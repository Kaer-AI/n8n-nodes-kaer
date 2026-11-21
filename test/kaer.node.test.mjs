// Unit tests for the Kaer node. They run against the compiled node in dist/
// (`npm test` builds first) with a fake IExecuteFunctions, so no request leaves
// the machine. Uses only node:test and node:assert: no extra dependencies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Kaer } = require('../dist/nodes/Kaer/Kaer.node.js');
const { KaerApi } = require('../dist/credentials/KaerApi.credentials.js');
const { NodeApiError, NodeOperationError } = require('n8n-workflow');

const FAKE_KEY = 'kaer_live_test_0000000000000000';

const okResponse = (overrides = {}) => ({
	statusCode: 200,
	headers: { 'content-type': 'application/json', 'x-request-id': 'req_000000000000000000000001' },
	body: {
		object: 'search.result',
		query: 'uk electricity price cap',
		lane: 'fast',
		served_lane: 'fast',
		results: [
			{
				title: 'Energy price cap explained',
				url: 'https://example.org/price-cap',
				snippet: 'What the cap is and how it is set.',
				source: ['fast'],
				published_date: null,
			},
			{
				title: 'Price cap from January',
				url: 'https://example.com/january',
				snippet: 'The new level for January.',
				source: ['kaer_web'],
				published_date: '2026-11-21T07:00:00Z',
			},
		],
		kaer: { request_id: 'req_000000000000000000000001', cost_usd: 0.001 },
		...overrides,
	},
});

const deepResponse = () =>
	okResponse({
		lane: 'deep',
		served_lane: 'deep',
		results: [
			{
				title: 'Deep page',
				url: 'https://example.net/deep',
				snippet: 'Short snippet.',
				source: ['kaer_web'],
				text: 'The main text of the page.',
				text_truncated: false,
				text_source: 'page',
			},
		],
	});

const errorResponse = (statusCode, code, message, headers = {}) => ({
	statusCode,
	headers: {
		'content-type': 'application/json',
		'x-request-id': 'req_00000000000000000000abcd',
		...headers,
	},
	body: { error: { message, type: 'invalid_request_error', param: null, code } },
});

/**
 * A minimal IExecuteFunctions. `params` is an object (same for every item) or a
 * function of the item index. Each queued response is returned once, in order;
 * an Error in the queue is thrown instead.
 */
function makeContext({
	params,
	items = [{ json: {} }],
	responses = [],
	continueOnFail = false,
	credentials = { apiKey: FAKE_KEY, baseUrl: 'https://api.kaer.ai/v1/' },
}) {
	const calls = [];
	const node = {
		id: 'node-1',
		name: 'Kaer',
		type: 'n8n-nodes-kaer.kaer',
		typeVersion: 1,
		position: [0, 0],
		parameters: {},
	};
	const ctx = {
		getInputData: () => items,
		getNode: () => node,
		continueOnFail: () => continueOnFail,
		getCredentials: async (type) => {
			assert.equal(type, 'kaerApi');
			return credentials;
		},
		getNodeParameter: (name, itemIndex, fallback) => {
			const p = typeof params === 'function' ? params(itemIndex) : params;
			const defaults = { resource: 'search', operation: 'search' };
			if (name in p) return p[name];
			if (name in defaults) return defaults[name];
			if (fallback !== undefined) return fallback;
			throw new Error(`No parameter ${name}`);
		},
		helpers: {
			async httpRequestWithAuthentication(credentialType, options) {
				calls.push({ credentialType, options, boundTo: this });
				const next = responses.shift();
				if (next === undefined) throw new Error('No response queued');
				if (next instanceof Error) throw next;
				return next;
			},
		},
	};
	return { ctx, calls };
}

const run = (ctx) => new Kaer().execute.call(ctx);

// ── Success and output shape ────────────────────────────────────────────────

test('simplify on: one item per result, with the simple fields only', async () => {
	const { ctx } = makeContext({
		params: { query: 'uk electricity price cap', lane: 'fast', numResults: 2, simplify: true },
		responses: [okResponse()],
	});
	const [out] = await run(ctx);
	assert.equal(out.length, 2);
	assert.deepEqual(out[0].json, {
		title: 'Energy price cap explained',
		url: 'https://example.org/price-cap',
		snippet: 'What the cap is and how it is set.',
		published_date: null,
	});
	assert.equal(out[1].json.published_date, '2026-11-21T07:00:00Z');
	assert.equal('source' in out[0].json, false);
	assert.deepEqual(out[0].pairedItem, { item: 0 });
	assert.deepEqual(out[1].pairedItem, { item: 0 });
});

test('simplify on, deep lane: text is kept when present', async () => {
	const { ctx } = makeContext({
		params: { query: 'deep query', lane: 'deep', numResults: 1, simplify: true },
		responses: [deepResponse()],
	});
	const [out] = await run(ctx);
	assert.equal(out.length, 1);
	assert.equal(out[0].json.text, 'The main text of the page.');
	assert.equal('text_source' in out[0].json, false);
});

test('simplify off: the raw response as one item', async () => {
	const response = okResponse({ warnings: ['offset is not applied on the deep lane'] });
	const { ctx } = makeContext({
		params: { query: 'uk electricity price cap', lane: 'fast', numResults: 2, simplify: false },
		responses: [response],
	});
	const [out] = await run(ctx);
	assert.equal(out.length, 1);
	assert.deepEqual(out[0].json, response.body);
	assert.deepEqual(out[0].pairedItem, { item: 0 });
});

test('a JSON body that arrives as a string is parsed', async () => {
	const response = okResponse();
	response.body = JSON.stringify(response.body);
	const { ctx } = makeContext({
		params: { query: 'q', simplify: true },
		responses: [response],
	});
	const [out] = await run(ctx);
	assert.equal(out.length, 2);
});

test('zero results with simplify on gives zero items', async () => {
	const { ctx } = makeContext({
		params: { query: 'nothing matches', simplify: true },
		responses: [okResponse({ results: [] })],
	});
	const [out] = await run(ctx);
	assert.equal(out.length, 0);
});

test('every input item runs its own search', async () => {
	const { ctx, calls } = makeContext({
		items: [{ json: {} }, { json: {} }, { json: {} }],
		params: (i) => ({ query: `query ${i}`, lane: 'web', numResults: 3, simplify: false }),
		responses: [okResponse(), okResponse(), okResponse()],
	});
	const [out] = await run(ctx);
	assert.equal(calls.length, 3);
	assert.deepEqual(
		calls.map((c) => c.options.body.query),
		['query 0', 'query 1', 'query 2'],
	);
	assert.deepEqual(
		out.map((o) => o.pairedItem.item),
		[0, 1, 2],
	);
});

// ── Request mapping ─────────────────────────────────────────────────────────

test('request: endpoint, credential, timeout and minimal body', async () => {
	const { ctx, calls } = makeContext({
		params: { query: '  uk electricity price cap  ', simplify: true },
		responses: [okResponse()],
	});
	await run(ctx);
	assert.equal(calls.length, 1);
	const { credentialType, options, boundTo } = calls[0];
	assert.equal(credentialType, 'kaerApi');
	assert.equal(boundTo, ctx);
	assert.equal(options.method, 'POST');
	assert.equal(options.url, 'https://api.kaer.ai/v1/search');
	assert.equal(options.json, true);
	assert.equal(options.timeout, 60_000);
	assert.equal(options.returnFullResponse, true);
	assert.equal(options.ignoreHttpStatusErrors, true);
	assert.deepEqual(options.body, {
		query: 'uk electricity price cap',
		lane: 'auto',
		num_results: 5,
	});
	assert.equal(
		JSON.stringify(options).includes(FAKE_KEY),
		false,
		'the node never sets the key itself',
	);
});

test('request: lane, num_results, domains, paging and fields are mapped', async () => {
	const { ctx, calls } = makeContext({
		params: {
			query: 'price cap',
			lane: 'FAST',
			numResults: 10,
			simplify: true,
			options: {
				includeDomains: 'https://www.gov.uk/guidance/x, ons.gov.uk,\nofgem.gov.uk,, ons.gov.uk',
				excludeDomains: ['Pinterest.com', ' quora.com '],
				offset: 10,
				page: 2,
				fields: ['title', 'url', 'published_date'],
			},
		},
		responses: [okResponse()],
	});
	await run(ctx);
	assert.deepEqual(calls[0].options.body, {
		query: 'price cap',
		lane: 'fast',
		num_results: 10,
		include_domains: ['www.gov.uk', 'ons.gov.uk', 'ofgem.gov.uk'],
		exclude_domains: ['pinterest.com', 'quora.com'],
		offset: 10,
		page: 2,
		fields: ['title', 'url', 'published_date'],
	});
});

test('request: empty options are left out of the body', async () => {
	const { ctx, calls } = makeContext({
		params: {
			query: 'q',
			lane: 'web',
			numResults: 3,
			options: { includeDomains: ' , ', excludeDomains: '', fields: [] },
		},
		responses: [okResponse()],
	});
	await run(ctx);
	assert.deepEqual(calls[0].options.body, { query: 'q', lane: 'web', num_results: 3 });
});

test('request: a blank base URL falls back to the public API', async () => {
	const { ctx, calls } = makeContext({
		params: { query: 'q' },
		responses: [okResponse()],
		credentials: { apiKey: FAKE_KEY, baseUrl: '' },
	});
	await run(ctx);
	assert.equal(calls[0].options.url, 'https://api.kaer.ai/v1/search');
});

// ── Checks before any request ───────────────────────────────────────────────

test('an empty query stops before any request', async () => {
	const { ctx, calls } = makeContext({ params: { query: '   ' } });
	await assert.rejects(run(ctx), (error) => {
		assert.ok(error instanceof NodeOperationError);
		assert.equal(error.message, "'Query' is empty");
		assert.equal(error.context.itemIndex, 0);
		return true;
	});
	assert.equal(calls.length, 0);
});

test('a query over 512 characters stops before any request', async () => {
	const { ctx, calls } = makeContext({ params: { query: 'a'.repeat(513) } });
	await assert.rejects(run(ctx), NodeOperationError);
	assert.equal(calls.length, 0);
});

test('more than 20 domains stops before any request', async () => {
	const hosts = Array.from({ length: 21 }, (_, n) => `site${n}.example.com`).join(',');
	const { ctx, calls } = makeContext({
		params: { query: 'q', options: { excludeDomains: hosts } },
	});
	await assert.rejects(run(ctx), /'Exclude Domains' lists 21 hosts/);
	assert.equal(calls.length, 0);
});

test('a fractional offset stops before any request', async () => {
	const { ctx, calls } = makeContext({ params: { query: 'q', options: { offset: 1.5 } } });
	await assert.rejects(run(ctx), /'Offset' must be a whole number/);
	assert.equal(calls.length, 0);
});

// ── Error mapping ───────────────────────────────────────────────────────────

test('401 invalid_api_key: NodeApiError with Kaer message, code and request id', async () => {
	const { ctx } = makeContext({
		params: { query: 'q' },
		responses: [errorResponse(401, 'invalid_api_key', 'Invalid or revoked API key.')],
	});
	await assert.rejects(run(ctx), (error) => {
		assert.ok(error instanceof NodeApiError);
		assert.equal(error.message, 'Invalid or revoked API key.');
		assert.equal(error.httpCode, '401');
		assert.match(error.description, /Check the API key in the Kaer credential/);
		assert.match(error.description, /Kaer code: invalid_api_key/);
		assert.match(error.description, /request ID: req_00000000000000000000abcd/);
		assert.equal(error.context.itemIndex, 0);
		assert.deepEqual(error.context.kaer, {
			code: 'invalid_api_key',
			httpCode: 401,
			requestId: 'req_00000000000000000000abcd',
		});
		return true;
	});
});

test('403 tier_required: tells the user search opens after the first top-up', async () => {
	const { ctx } = makeContext({
		params: { query: 'q' },
		responses: [errorResponse(403, 'tier_required', 'Search is not included in your tier.')],
	});
	await assert.rejects(run(ctx), (error) => {
		assert.ok(error instanceof NodeApiError);
		assert.equal(error.httpCode, '403');
		assert.equal(error.message, 'Search is not included in your tier.');
		assert.match(error.description, /first top-up/);
		assert.match(error.description, /Kaer code: tier_required/);
		return true;
	});
});

test('403 insufficient_scope: points at the search scope', async () => {
	const { ctx } = makeContext({
		params: { query: 'q' },
		responses: [errorResponse(403, 'insufficient_scope', 'The key lacks the search scope.')],
	});
	await assert.rejects(run(ctx), /The key lacks the search scope/);
});

test('429 with Retry-After: the wait is in the description and the details', async () => {
	const { ctx } = makeContext({
		params: { query: 'q' },
		responses: [
			errorResponse(429, 'rate_limit_exceeded', 'Rate limit reached for this key.', {
				'Retry-After': '12',
			}),
		],
	});
	await assert.rejects(run(ctx), (error) => {
		assert.ok(error instanceof NodeApiError);
		assert.equal(error.httpCode, '429');
		assert.match(error.description, /Wait 12 seconds before trying again/);
		assert.match(error.description, /Retry On Fail/);
		assert.equal(error.context.kaer.retryAfterSeconds, 12);
		return true;
	});
});

test('a 502 with a non-JSON body still gives a clear message', async () => {
	const { ctx } = makeContext({
		params: { query: 'q' },
		responses: [
			{
				statusCode: 502,
				headers: { 'content-type': 'text/html' },
				body: '<html>Bad gateway</html>',
			},
		],
	});
	await assert.rejects(run(ctx), (error) => {
		assert.ok(error instanceof NodeApiError);
		assert.equal(error.httpCode, '502');
		assert.equal(error.message, 'Kaer could not complete the search');
		assert.match(error.description, /Kaer code: http_502/);
		return true;
	});
});

test('a 200 without a results list is reported, not passed on', async () => {
	const { ctx } = makeContext({
		params: { query: 'q' },
		responses: [{ statusCode: 200, headers: {}, body: '<html>login</html>' }],
	});
	await assert.rejects(run(ctx), /Kaer answered without a list of results/);
});

test('a timeout becomes a NodeApiError that never carries the API key', async () => {
	const timeout = Object.assign(new Error('timeout of 60000ms exceeded'), {
		code: 'ECONNABORTED',
		config: { headers: { Authorization: `Bearer ${FAKE_KEY}` } },
	});
	const { ctx } = makeContext({ params: { query: 'q' }, responses: [timeout] });
	await assert.rejects(run(ctx), (error) => {
		assert.ok(error instanceof NodeApiError);
		assert.equal(error.message, 'The Kaer API did not answer within 60 seconds');
		assert.equal(error.context.kaer.code, 'request_timeout');
		const seen = JSON.stringify({ ...error, message: error.message, cause: error.cause });
		assert.equal(seen.includes(FAKE_KEY), false);
		return true;
	});
});

// ── Continue On Fail ────────────────────────────────────────────────────────

test('continueOnFail: a failed item becomes an error item and the rest still run', async () => {
	const { ctx, calls } = makeContext({
		items: [{ json: {} }, { json: {} }, { json: {} }],
		continueOnFail: true,
		params: (i) => ({ query: i === 2 ? '' : `query ${i}`, simplify: true }),
		responses: [
			errorResponse(403, 'tier_required', 'Search is not included in your tier.'),
			okResponse(),
		],
	});
	const [out] = await run(ctx);
	assert.equal(calls.length, 2, 'item 2 fails its check before any request');

	assert.equal(out[0].json.error, 'Search is not included in your tier.');
	assert.equal(out[0].json.code, 'tier_required');
	assert.equal(out[0].json.httpCode, 403);
	assert.equal(out[0].json.requestId, 'req_00000000000000000000abcd');
	assert.deepEqual(out[0].pairedItem, { item: 0 });

	assert.equal(out[1].json.title, 'Energy price cap explained');
	assert.deepEqual(out[1].pairedItem, { item: 1 });
	assert.deepEqual(out[2].pairedItem, { item: 1 });

	assert.equal(out[3].json.error, "'Query' is empty");
	assert.deepEqual(out[3].pairedItem, { item: 2 });
	assert.equal(out.length, 4);
});

test('without continueOnFail the first failure stops the node', async () => {
	const { ctx, calls } = makeContext({
		items: [{ json: {} }, { json: {} }],
		params: { query: 'q' },
		responses: [errorResponse(503, 'search_busy', 'Search is busy.'), okResponse()],
	});
	await assert.rejects(run(ctx), (error) => {
		assert.ok(error instanceof NodeApiError);
		assert.equal(error.httpCode, '503');
		assert.match(error.description, /not charged/);
		return true;
	});
	assert.equal(calls.length, 1);
});

// ── Description and credential ──────────────────────────────────────────────

test('node description: usable as a tool, Kaer credential, themed icons', () => {
	const { description } = new Kaer();
	assert.equal(description.name, 'kaer');
	assert.equal(description.usableAsTool, true);
	assert.deepEqual(description.credentials, [{ name: 'kaerApi', required: true }]);
	assert.deepEqual(description.icon, { light: 'file:kaer.svg', dark: 'file:kaer.dark.svg' });
	const lane = description.properties.find((p) => p.name === 'lane');
	assert.deepEqual(
		lane.options.map((o) => o.value),
		['auto', 'deep', 'fast', 'web'],
	);
});

test('credential: bearer header, password field, free GET /me test', () => {
	const cred = new KaerApi();
	assert.equal(cred.name, 'kaerApi');
	const apiKey = cred.properties.find((p) => p.name === 'apiKey');
	assert.equal(apiKey.typeOptions.password, true);
	const baseUrl = cred.properties.find((p) => p.name === 'baseUrl');
	assert.equal(baseUrl.default, 'https://api.kaer.ai/v1');
	assert.equal(
		cred.authenticate.properties.headers.Authorization,
		'=Bearer {{$credentials.apiKey}}',
	);
	assert.equal(cred.test.request.method, 'GET');
	assert.equal(cred.test.request.url, '/me');
});

// ── Review fixes ────────────────────────────────────────────────────────────

test('simplify on with Fields: items carry exactly the picked fields', async () => {
	const { ctx } = makeContext({
		params: { query: 'q', simplify: true, options: { fields: ['url', 'source'] } },
		responses: [okResponse()],
	});
	const [out] = await run(ctx);
	assert.deepEqual(out[0].json, { url: 'https://example.org/price-cap', source: ['fast'] });
});

test('simplify on: answer and warnings reach every item', async () => {
	const answer = { type: 'conversion', text: '10 km is 6.21 miles.', data: { value: 6.21 } };
	const warnings = ['page is not applied on the deep lane'];
	const { ctx } = makeContext({
		params: { query: 'q', simplify: true },
		responses: [okResponse({ answer, warnings })],
	});
	const [out] = await run(ctx);
	assert.equal(out.length, 2);
	for (const item of out) {
		assert.deepEqual(item.json.answer, answer);
		assert.deepEqual(item.json.warnings, warnings);
	}
});

test('offset 0 (the default) is not sent, so Page applies', async () => {
	const { ctx, calls } = makeContext({
		params: { query: 'q', lane: 'web', options: { offset: 0, page: 3 } },
		responses: [okResponse()],
	});
	await run(ctx);
	const body = calls[0].options.body;
	assert.equal('offset' in body, false);
	assert.equal(body.page, 3);
});
