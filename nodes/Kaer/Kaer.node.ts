import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestOptions,
	IN8nHttpFullResponse,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import {
	apiErrorFromResponse,
	buildSearchBody,
	errorItem,
	networkError,
	normaliseBaseUrl,
	parseJsonBody,
	REQUEST_TIMEOUT_MS,
	simplifyResults,
	type KaerSearchResponse,
} from './helpers';

// Programmatic style rather than declarative: the node splits one response into
// one item per result, maps Kaer's error codes (with the request id and
// Retry-After) into NodeApiError, and checks the query and domain lists before
// any request is sent.
export class Kaer implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Kaer',
		name: 'kaer',
		icon: { light: 'file:kaer.svg', dark: 'file:kaer.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] === "search" ? "Search the web" : ""}}',
		description: 'Search the web with the Kaer Search API',
		defaults: {
			name: 'Kaer',
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'kaerApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Search',
						value: 'search',
					},
				],
				default: 'search',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: {
						resource: ['search'],
					},
				},
				options: [
					{
						name: 'Search the Web',
						value: 'search',
						description: 'Run one query and get ranked results from Kaer',
						action: 'Search the web',
					},
				],
				default: 'search',
			},
			{
				displayName: 'Query',
				name: 'query',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'e.g. uk electricity price cap january',
				description: 'What to search for, 1 to 512 characters',
				displayOptions: {
					show: {
						resource: ['search'],
						operation: ['search'],
					},
				},
			},
			{
				displayName: 'Lane',
				name: 'lane',
				type: 'options',
				default: 'auto',
				description:
					'How Kaer runs the search. Each lane is billed at its own price; see https://api.kaer.ai/docs/search-pricing.',
				options: [
					{
						name: 'Auto',
						value: 'auto',
						description: 'Kaer picks a lane for each query and bills the lane that served it',
					},
					{
						name: 'Deep',
						value: 'deep',
						description:
							"Every lane, re-ranked. Results carry the page's main text, up to 4,000 characters. Up to 40 seconds.",
					},
					{
						name: 'Fast',
						value: 'fast',
						description: "Kaer's index racing the live web. Up to 12 seconds.",
					},
					{
						name: 'Web',
						value: 'web',
						description: "Kaer's own index alone. Fastest and cheapest, up to 6 seconds.",
					},
				],
				displayOptions: {
					show: {
						resource: ['search'],
						operation: ['search'],
					},
				},
			},
			{
				displayName: 'Number of Results',
				name: 'numResults',
				type: 'number',
				default: 5,
				typeOptions: {
					minValue: 1,
					maxValue: 25,
					numberPrecision: 0,
				},
				description: 'How many results to return, from 1 to 25',
				displayOptions: {
					show: {
						resource: ['search'],
						operation: ['search'],
					},
				},
			},
			{
				displayName: 'Simplify',
				name: 'simplify',
				type: 'boolean',
				default: true,
				description:
					'Whether to return a simplified version of the response instead of the raw data',
				hint: 'On: one item per result with title, URL, snippet, published date and, on the Deep lane, the page text. Off: the full response as one item.',
				displayOptions: {
					show: {
						resource: ['search'],
						operation: ['search'],
					},
				},
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: {
					show: {
						resource: ['search'],
						operation: ['search'],
					},
				},
				options: [
					{
						displayName: 'Exclude Domains',
						name: 'excludeDomains',
						type: 'string',
						default: '',
						placeholder: 'e.g. pinterest.com, quora.com',
						description:
							'Never return results from these hosts or their subdomains. Separate hosts with commas, up to 20.',
					},
					{
						displayName: 'Fields',
						name: 'fields',
						type: 'multiOptions',
						default: [],
						description: 'Result fields to keep. Leave empty to keep them all.',
						options: [
							{ name: 'Published Date', value: 'published_date' },
							{ name: 'Snippet', value: 'snippet' },
							{ name: 'Source', value: 'source' },
							{ name: 'Text', value: 'text' },
							{ name: 'Text Source', value: 'text_source' },
							{ name: 'Text Truncated', value: 'text_truncated' },
							{ name: 'Title', value: 'title' },
							{ name: 'URL', value: 'url' },
						],
					},
					{
						displayName: 'Include Domains',
						name: 'includeDomains',
						type: 'string',
						default: '',
						placeholder: 'e.g. gov.uk, bbc.co.uk',
						description:
							'Only return results from these hosts or their subdomains. Separate hosts with commas, up to 20.',
					},
					{
						displayName: 'Offset',
						name: 'offset',
						type: 'number',
						default: 0,
						typeOptions: { minValue: 0, numberPrecision: 0 },
						description:
							"Results to skip before this page. Only the Web and Fast lanes page; the others return their first page. Wins over 'Page' when both are set.",
					},
					{
						displayName: 'Page',
						name: 'page',
						type: 'number',
						default: 1,
						typeOptions: { minValue: 1, numberPrecision: 0 },
						description:
							"The page of results to return, counting from 1, in pages of 'Number of Results'. Only the Web and Fast lanes page.",
					},
				],
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		const credentials = await this.getCredentials('kaerApi');
		const baseUrl = normaliseBaseUrl(credentials.baseUrl);

		for (let i = 0; i < items.length; i++) {
			try {
				const resource = this.getNodeParameter('resource', i) as string;
				const operation = this.getNodeParameter('operation', i) as string;
				if (resource !== 'search' || operation !== 'search') {
					throw new NodeOperationError(
						this.getNode(),
						`The operation '${operation}' is not available for '${resource}'`,
						{ itemIndex: i },
					);
				}

				const body = buildSearchBody(this, i);
				const simplify = this.getNodeParameter('simplify', i, true) as boolean;

				const request: IHttpRequestOptions = {
					method: 'POST',
					url: `${baseUrl}/search`,
					headers: { Accept: 'application/json' },
					body,
					json: true,
					timeout: REQUEST_TIMEOUT_MS,
					returnFullResponse: true,
					ignoreHttpStatusErrors: true,
				};

				let response: IN8nHttpFullResponse;
				try {
					response = (await this.helpers.httpRequestWithAuthentication.call(
						this,
						'kaerApi',
						request,
					)) as IN8nHttpFullResponse;
				} catch (error) {
					throw networkError(this.getNode(), error, i);
				}

				const status = Number(response.statusCode);
				if (!(status >= 200 && status < 300)) {
					throw apiErrorFromResponse(this.getNode(), response, i);
				}

				const data = parseJsonBody(response.body) as KaerSearchResponse;
				if (!data || typeof data !== 'object' || !Array.isArray(data.results)) {
					throw new NodeApiError(
						this.getNode(),
						{ message: 'Unexpected response body', httpCode: String(status) },
						{
							message: 'Kaer answered without a list of results',
							description:
								"Check the 'Base URL' in the Kaer credential. It should end in /v1, for example https://api.kaer.ai/v1.",
							itemIndex: i,
						},
					);
				}

				if (simplify) {
					for (const result of simplifyResults(data, body.fields)) {
						returnData.push({ json: result, pairedItem: { item: i } });
					}
				} else {
					returnData.push({ json: data as IDataObject, pairedItem: { item: i } });
				}
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({ json: errorItem(error), pairedItem: { item: i } });
					continue;
				}
				// Both constructors hand back an error that is already of their type, so
				// the Kaer message, description and item index set above are kept.
				if (error instanceof NodeApiError) {
					throw new NodeApiError(this.getNode(), error as unknown as JsonObject, { itemIndex: i });
				}
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
			}
		}

		return [returnData];
	}
}
