// Dev-only live check: runs the built node's execute() against a real Kaer API
// with a fake IExecuteFunctions whose httpRequestWithAuthentication applies the
// credential's `authenticate` block and sends the request with fetch, the way
// n8n does. Not part of the published package (only dist/ is).
//
//   KAER_TEST_BASE_URL=https://api.kaer.ai/v1 KAER_API_KEY=kaer_live_... \
//     node scripts/live-smoke.mjs
//
// Each search here is billed at its lane's price. The key is never printed.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Kaer } = require('../dist/nodes/Kaer/Kaer.node.js');
const { KaerApi } = require('../dist/credentials/KaerApi.credentials.js');

const baseUrl = process.env.KAER_TEST_BASE_URL;
const apiKey = process.env.KAER_API_KEY;
if (!baseUrl || !apiKey) {
	console.error('Set KAER_TEST_BASE_URL and KAER_API_KEY.');
	process.exit(2);
}

const credentialType = new KaerApi();

function authHeaders(credentials) {
	// Resolves '=Bearer {{$credentials.apiKey}}' the way n8n's generic authenticate does.
	const out = {};
	for (const [name, template] of Object.entries(credentialType.authenticate.properties.headers)) {
		out[name] = template
			.replace(/^=/, '')
			.replace(/\{\{\s*\$credentials\.(\w+)\s*\}\}/g, (_, k) => credentials[k]);
	}
	return out;
}

async function send(credentials, options) {
	const res = await fetch(options.url, {
		method: options.method,
		headers: {
			'content-type': 'application/json',
			...(options.headers ?? {}),
			...authHeaders(credentials),
		},
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
		signal: AbortSignal.timeout(options.timeout ?? 60_000),
	});
	const text = await res.text();
	let body = text;
	if ((res.headers.get('content-type') ?? '').includes('json')) {
		try {
			body = JSON.parse(text);
		} catch {
			body = text;
		}
	}
	const headers = Object.fromEntries(res.headers.entries());
	if (!options.ignoreHttpStatusErrors && !res.ok) throw new Error(`HTTP ${res.status}`);
	return options.returnFullResponse
		? { statusCode: res.status, statusMessage: res.statusText, headers, body }
		: body;
}

function context({ params, credentials, continueOnFail = false, items = [{ json: {} }] }) {
	return {
		getInputData: () => items,
		getNode: () => ({
			id: 'live',
			name: 'Kaer',
			type: 'n8n-nodes-kaer.kaer',
			typeVersion: 1,
			position: [0, 0],
			parameters: {},
		}),
		continueOnFail: () => continueOnFail,
		getCredentials: async () => credentials,
		getNodeParameter: (name, i, fallback) => {
			const p = { resource: 'search', operation: 'search', ...params };
			return name in p ? p[name] : fallback;
		},
		helpers: {
			httpRequestWithAuthentication: (type, options) => {
				if (type !== 'kaerApi') throw new Error(`unexpected credential ${type}`);
				return send(credentials, options);
			},
		},
	};
}

const good = { apiKey, baseUrl };
const bad = { apiKey: 'kaer_live_not_a_real_key_000000000000', baseUrl };
let failed = 0;
const check = (label, ok, detail) => {
	if (!ok) failed++;
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};

// 1. The credential test request (GET /me): free, proves the key.
{
	const t = credentialType.test.request;
	const res = await send(good, {
		method: t.method,
		url: `${baseUrl.replace(/\/+$/, '')}${t.url}`,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
	});
	if (res.statusCode === 403 && res.body?.error?.code === 'insufficient_scope') {
		// A key without the models scope: n8n shows the credential's 403 rule message.
		const rule = credentialType.test.rules?.find((r) => r.properties.value === 403);
		console.log(
			`NOTE  credential test GET /me: 403 insufficient_scope (${res.body.error.message}) — this key has no models scope; n8n would show: "${rule?.properties.message}"`,
		);
	} else {
		check(
			'credential test GET /me with the key',
			res.statusCode === 200 && res.body?.object === 'account',
			`HTTP ${res.statusCode}, scopes ${JSON.stringify(res.body?.key?.scopes)}, tier ${res.body?.tier?.name}`,
		);
	}
	const badRes = await send(bad, {
		method: t.method,
		url: `${baseUrl.replace(/\/+$/, '')}${t.url}`,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
	});
	check(
		'credential test GET /me with a bad key is refused',
		badRes.statusCode === 401,
		`HTTP ${badRes.statusCode}`,
	);
}

// 2. Searches on the web and fast lanes, simplified and raw.
for (const lane of ['web', 'fast']) {
	const query = 'n8n workflow automation';
	const simple = await new Kaer().execute.call(
		context({ params: { query, lane, numResults: 3, simplify: true }, credentials: good }),
	);
	const items = simple[0];
	const keys = [...new Set(items.flatMap((i) => Object.keys(i.json)))].sort().join(',');
	check(
		`${lane}: simplify on gives one item per result`,
		items.length > 0 && items.length <= 3 && items.every((i) => typeof i.json.url === 'string'),
		`${items.length} items, keys ${keys}, first: ${items[0]?.json.title?.slice(0, 60)}`,
	);

	const raw = await new Kaer().execute.call(
		context({
			params: { query, lane, numResults: 3, simplify: false, options: { page: 2 } },
			credentials: good,
		}),
	);
	const r = raw[0][0]?.json;
	check(
		`${lane}: simplify off gives the raw response (page 2)`,
		raw[0].length === 1 && r?.object === 'search.result' && r?.served_lane === lane,
		`served_lane ${r?.served_lane}, ${r?.results?.length} results, request ${r?.kaer?.request_id}, cost_usd ${r?.kaer?.cost_usd}${r?.warnings ? `, warnings ${JSON.stringify(r.warnings)}` : ''}`,
	);
}

// 3. A bad key: NodeApiError with Kaer's code and request id; and continueOnFail.
try {
	await new Kaer().execute.call(
		context({ params: { query: 'test', lane: 'web' }, credentials: bad }),
	);
	check('bad key throws', false, 'no error thrown');
} catch (error) {
	check(
		'bad key throws NodeApiError with code and request id',
		error.constructor.name === 'NodeApiError' &&
			error.httpCode === '401' &&
			/req_/.test(error.description ?? ''),
		`${error.message} | ${error.description}`,
	);
	check(
		'bad key error never contains the real key',
		!JSON.stringify({ m: error.message, d: error.description, c: error.context }).includes(apiKey),
	);
}
{
	const out = await new Kaer().execute.call(
		context({ params: { query: 'test', lane: 'web' }, credentials: bad, continueOnFail: true }),
	);
	const j = out[0][0]?.json;
	check(
		'bad key with continueOnFail gives an error item',
		j?.code === 'invalid_api_key' && j?.httpCode === 401,
		JSON.stringify({ error: j?.error, code: j?.code, requestId: j?.requestId }),
	);
}

console.log(failed === 0 ? '\nAll live checks passed.' : `\n${failed} live check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
