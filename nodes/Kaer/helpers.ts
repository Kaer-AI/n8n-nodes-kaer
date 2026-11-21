import type {
	IDataObject,
	IExecuteFunctions,
	IN8nHttpFullResponse,
	INode,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

export const DEFAULT_BASE_URL = 'https://api.kaer.ai/v1';

/** The deep and auto lanes may run for up to 40 seconds; leave headroom for the network. */
export const REQUEST_TIMEOUT_MS = 60_000;

export const QUERY_MAX_CHARS = 512;
export const DOMAINS_MAX = 20;

export const RESULT_FIELDS = [
	'title',
	'url',
	'snippet',
	'source',
	'published_date',
	'text',
	'text_truncated',
	'text_source',
] as const;

/** Keys kept on each item when 'Simplify' is on. */
const SIMPLE_FIELDS = ['title', 'url', 'snippet', 'published_date', 'text'] as const;

export interface KaerSearchResult extends IDataObject {
	title: string;
	url: string;
	snippet: string;
	source: string[];
	published_date?: string;
	text?: string;
	text_truncated?: boolean;
	text_source?: string;
}

export interface KaerSearchResponse extends IDataObject {
	object: 'search.result';
	query: string;
	lane: string;
	served_lane: string;
	results: KaerSearchResult[];
	answer?: IDataObject;
	warnings?: string[];
	kaer: IDataObject & { request_id?: string; cost_usd?: number; ignored_params?: string[] };
}

export interface KaerSearchBody extends IDataObject {
	query: string;
	lane: string;
	num_results: number;
	include_domains?: string[];
	exclude_domains?: string[];
	offset?: number;
	page?: number;
	fields?: string[];
}

/** Details kept on every error this node raises, so 'Continue On Fail' output can carry them. */
export interface KaerErrorDetails extends IDataObject {
	code: string;
	httpCode?: number;
	requestId?: string;
	retryAfterSeconds?: number;
}

export function normaliseBaseUrl(value: unknown): string {
	const raw = typeof value === 'string' && value.trim() !== '' ? value.trim() : DEFAULT_BASE_URL;
	return raw.replace(/\/+$/, '');
}

/**
 * Accepts a comma, space or line separated string, or an array (from an expression),
 * and returns unique host names. A pasted address such as `https://example.com/page`
 * becomes `example.com`.
 */
export function parseDomains(value: unknown): string[] {
	let parts: unknown[] = [];
	if (Array.isArray(value)) {
		parts = value;
	} else if (typeof value === 'string') {
		parts = value.split(/[\s,]+/);
	}

	const hosts = parts
		.map((part) =>
			String(part ?? '')
				.trim()
				.toLowerCase()
				.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
				.replace(/[/?#].*$/, ''),
		)
		.filter((host) => host !== '');

	return [...new Set(hosts)];
}

function wholeNumber(node: INode, value: unknown, displayName: string, itemIndex: number): number {
	const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
	if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
		throw new NodeOperationError(node, `'${displayName}' must be a whole number of 0 or more`, {
			itemIndex,
			description: `Got ${JSON.stringify(value)}. Enter a value such as 0, 10 or 20.`,
		});
	}
	return n;
}

function domainList(
	node: INode,
	value: unknown,
	displayName: string,
	itemIndex: number,
): string[] | undefined {
	const hosts = parseDomains(value);
	if (hosts.length === 0) return undefined;
	if (hosts.length > DOMAINS_MAX) {
		throw new NodeOperationError(
			node,
			`'${displayName}' lists ${hosts.length} hosts, and Kaer takes up to ${DOMAINS_MAX}`,
			{ itemIndex, description: `Remove some hosts from '${displayName}'.` },
		);
	}
	return hosts;
}

/** Reads the node parameters for one item and builds the POST /search body. */
export function buildSearchBody(ctx: IExecuteFunctions, itemIndex: number): KaerSearchBody {
	const node = ctx.getNode();

	const query = String(ctx.getNodeParameter('query', itemIndex, '') ?? '').trim();
	if (query === '') {
		throw new NodeOperationError(node, "'Query' is empty", {
			itemIndex,
			description: `Enter what to search for, 1 to ${QUERY_MAX_CHARS} characters.`,
		});
	}
	if (query.length > QUERY_MAX_CHARS) {
		throw new NodeOperationError(
			node,
			`'Query' is ${query.length} characters long, and Kaer takes up to ${QUERY_MAX_CHARS}`,
			{ itemIndex, description: "Shorten 'Query' and run the node again." },
		);
	}

	const lane = String(ctx.getNodeParameter('lane', itemIndex, 'auto') ?? 'auto')
		.trim()
		.toLowerCase();

	const numResults = Number(ctx.getNodeParameter('numResults', itemIndex, 5));

	const body: KaerSearchBody = {
		query,
		lane: lane === '' ? 'auto' : lane,
		num_results: Number.isFinite(numResults) ? Math.round(numResults) : 5,
	};

	const options = ctx.getNodeParameter('options', itemIndex, {}) as IDataObject;

	const include = domainList(node, options.includeDomains, 'Include Domains', itemIndex);
	if (include) body.include_domains = include;

	const exclude = domainList(node, options.excludeDomains, 'Exclude Domains', itemIndex);
	if (exclude) body.exclude_domains = exclude;

	if (options.offset !== undefined && options.offset !== '') {
		const offset = wholeNumber(node, options.offset, 'Offset', itemIndex);
		// Offset 0 is the first page anyway, and the API lets offset win over
		// page, so sending the default 0 would hide a 'Page' the user set.
		if (offset > 0) body.offset = offset;
	}
	if (options.page !== undefined && options.page !== '') {
		body.page = wholeNumber(node, options.page, 'Page', itemIndex);
	}

	if (Array.isArray(options.fields) && options.fields.length > 0) {
		body.fields = (options.fields as string[]).map(String);
	}

	return body;
}

/**
 * One flat item per result, with the fields most workflows and AI agents use,
 * or exactly the result keys picked in 'Fields'. `published_date` is always set
 * when kept (null when unknown) so every item has the same columns; `text`
 * appears only when the lane returned it (Deep). When the response carries an
 * instant answer or warnings, every item of that search gets `answer` and
 * `warnings` too, so neither is lost.
 */
export function simplifyResults(
	response: KaerSearchResponse,
	fields?: readonly string[],
): IDataObject[] {
	const results = Array.isArray(response.results) ? response.results : [];
	const keys: readonly string[] = fields && fields.length > 0 ? fields : SIMPLE_FIELDS;
	const answer =
		response.answer && typeof response.answer === 'object' && (response.answer as IDataObject).text
			? (response.answer as IDataObject)
			: undefined;
	const warnings =
		Array.isArray(response.warnings) && response.warnings.length > 0 ? response.warnings : undefined;
	return results.map((result) => {
		const item: IDataObject = {};
		for (const key of keys) {
			const value = result[key];
			if (value !== undefined && value !== null) item[key] = value;
			else if (key === 'published_date') item[key] = null;
		}
		if (answer) item.answer = answer;
		if (warnings) item.warnings = warnings;
		return item;
	});
}

export function headerValue(
	headers: IN8nHttpFullResponse['headers'] | undefined,
	name: string,
): string | undefined {
	if (!headers) return undefined;
	const wanted = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() !== wanted) continue;
		if (Array.isArray(value)) return value.length > 0 ? String(value[0]) : undefined;
		return value === undefined || value === null ? undefined : String(value);
	}
	return undefined;
}

export function parseJsonBody(body: unknown): unknown {
	if (typeof body === 'string') {
		try {
			return JSON.parse(body);
		} catch {
			return body;
		}
	}
	if (typeof Buffer !== 'undefined' && Buffer.isBuffer(body)) {
		return parseJsonBody(body.toString('utf8'));
	}
	return body;
}

function retryAfterSeconds(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
	const date = Date.parse(value);
	if (Number.isNaN(date)) return undefined;
	return Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

const STATUS_TEXT: Record<number, string> = {
	400: 'Kaer could not run this search with the parameters sent',
	401: 'Kaer did not accept the API key',
	402: 'The Kaer account cannot pay for this search',
	403: 'Kaer refused this request',
	404: 'Kaer did not find the search endpoint',
	413: 'The search request is larger than Kaer accepts',
	429: 'Too many searches at once for this key',
	500: 'Kaer could not complete the search',
	502: 'Kaer could not complete the search',
	503: 'Kaer search is busy',
	504: 'The search ran past its time limit',
};

/** How to get unstuck, by the API's error code. */
function hintFor(code: string, status: number, retryAfter?: number): string {
	const wait =
		retryAfter !== undefined
			? `Wait ${retryAfter} second${retryAfter === 1 ? '' : 's'} before trying again`
			: 'Wait a moment before trying again';
	switch (code) {
		case 'missing_api_key':
		case 'invalid_api_key':
			return 'Check the API key in the Kaer credential, or create a new key under API keys at https://api.kaer.ai.';
		case 'insufficient_scope':
			return "Give the key the 'search' scope under API keys at https://api.kaer.ai. If Search is locked there, add a card under Billing first.";
		case 'tier_required':
			return "Search is not open on this account yet. Add a card under Billing at https://api.kaer.ai for free web searches, or make the account's first top-up.";
		case 'ip_not_allowed':
			return "Add this n8n instance's IP address to the key's allow-list, or remove the allow-list.";
		case 'account_inactive':
			return 'The Kaer account is not active. Contact support@kaer.ai.';
		case 'insufficient_credits':
		case 'payment_required':
			return 'Top up the balance under Billing at https://api.kaer.ai.';
		case 'key_shared':
			return 'Keep the key on one server. A top-up moves the account off the Free tier, which limits how many networks may use a key.';
		case 'monthly_limit_reached':
			return 'The account reached its monthly spend cap. Raise the cap under Billing, or move to a higher tier.';
		case 'key_budget_exceeded':
			return "The key reached its monthly budget. Raise the key's budget under API keys.";
		case 'rate_limit_exceeded':
		case 'too_many_concurrent_searches':
			return `${wait}, or turn on 'Retry On Fail' in the node settings.`;
		case 'query_required':
			return "Enter what to search for in 'Query'.";
		case 'query_too_long':
			return `Shorten 'Query' to ${QUERY_MAX_CHARS} characters or fewer.`;
		case 'invalid_lane':
			return "Set 'Lane' to Auto, Web, Fast or Deep.";
		case 'invalid_num_results':
			return "Set 'Number of Results' to a number from 1 to 25.";
		case 'invalid_paging':
			return "Set 'Offset' and 'Page' to whole numbers of 0 or more.";
		case 'invalid_domains':
			return `Use host names such as example.com in 'Include Domains' and 'Exclude Domains', up to ${DOMAINS_MAX} in each.`;
		case 'invalid_fields':
			return "Pick 'Fields' from the list only.";
		case 'invalid_json':
		case 'body_too_large':
			return 'Shorten the query or the domain lists and run the node again.';
		case 'search_timeout':
			return 'Try the Web or Fast lane, or run the node again. Searches that time out are not charged.';
		case 'search_failed':
		case 'search_busy':
		case 'search_unavailable':
			return `${wait}. Failed searches are not charged.`;
		default:
			if (status === 429 || status >= 500) return `${wait}. Failed searches are not charged.`;
			return 'See https://api.kaer.ai/docs/search for the request format.';
	}
}

function attachDetails<T extends NodeApiError | NodeOperationError>(
	error: T,
	details: KaerErrorDetails,
): T {
	error.context = { ...(error.context ?? {}), kaer: details };
	return error;
}

/** Turns a non-2xx response into a NodeApiError with Kaer's code, message and request id. */
export function apiErrorFromResponse(
	node: INode,
	response: IN8nHttpFullResponse,
	itemIndex: number,
): NodeApiError {
	const status = Number(response.statusCode);
	const parsed = parseJsonBody(response.body);

	let code = `http_${status}`;
	let type: string | undefined;
	let apiMessage: string | undefined;
	if (parsed && typeof parsed === 'object') {
		const errorField = (parsed as IDataObject).error;
		if (errorField && typeof errorField === 'object') {
			const e = errorField as IDataObject;
			if (typeof e.code === 'string' && e.code !== '') code = e.code;
			if (typeof e.type === 'string') type = e.type;
			if (typeof e.message === 'string' && e.message !== '') apiMessage = e.message;
		} else if (typeof errorField === 'string' && errorField !== '') {
			apiMessage = errorField;
		} else if (typeof (parsed as IDataObject).message === 'string') {
			apiMessage = (parsed as IDataObject).message as string;
		}
	}

	const requestId = headerValue(response.headers, 'x-request-id');
	const retryAfter = retryAfterSeconds(headerValue(response.headers, 'retry-after'));

	const summary = apiMessage ?? STATUS_TEXT[status] ?? `Kaer answered with HTTP ${status}`;
	const facts = [`Kaer code: ${code}`, `HTTP ${status}`];
	if (requestId) facts.push(`request ID: ${requestId}`);
	if (retryAfter !== undefined) facts.push(`retry after: ${retryAfter} s`);

	const details: KaerErrorDetails = { code, httpCode: status };
	if (requestId) details.requestId = requestId;
	if (retryAfter !== undefined) details.retryAfterSeconds = retryAfter;

	const errorResponse: JsonObject = { message: summary, code, httpCode: String(status) };
	if (type) errorResponse.type = type;
	if (requestId) errorResponse.requestId = requestId;

	const error = new NodeApiError(node, errorResponse, {
		message: summary,
		description: `${hintFor(code, status, retryAfter)} (${facts.join(', ')})`,
		httpCode: String(status),
		itemIndex,
	});
	return attachDetails(error, details);
}

/**
 * Wraps a transport failure (no HTTP answer). Only the message and code of the
 * original are kept, so request headers and the API key never reach the error.
 */
export function networkError(node: INode, error: unknown, itemIndex: number): NodeApiError {
	const e = (error ?? {}) as IDataObject & { cause?: IDataObject };
	const rawCode = (e.code ?? e.cause?.code) as string | undefined;
	const rawMessage = String(e.message ?? e.cause?.message ?? 'No answer from the Kaer API');
	const timedOut =
		rawCode === 'ECONNABORTED' || rawCode === 'ETIMEDOUT' || /timeout|timed out/i.test(rawMessage);

	const message = timedOut
		? `The Kaer API did not answer within ${REQUEST_TIMEOUT_MS / 1000} seconds`
		: 'The Kaer API could not be reached';
	const description = timedOut
		? 'Try the Web or Fast lane, or run the node again.'
		: `Check the 'Base URL' in the Kaer credential and this instance's network access. (${rawCode ?? rawMessage})`;

	const code = timedOut ? 'request_timeout' : 'network_unreachable';
	const failure = new NodeApiError(
		node,
		{ message: rawMessage, code },
		{ message, description, itemIndex },
	);
	return attachDetails(failure, { code });
}

/** The JSON item written when 'Continue On Fail' is on. */
export function errorItem(error: unknown): IDataObject {
	const e = error as NodeApiError | NodeOperationError | Error;
	const json: IDataObject = { error: e?.message ?? String(error) };
	const description = (e as NodeApiError).description;
	if (description) json.description = description;
	const details = (e as NodeApiError).context?.kaer as KaerErrorDetails | undefined;
	if (details) Object.assign(json, details);
	return json;
}
