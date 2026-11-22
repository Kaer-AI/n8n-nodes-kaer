# n8n-nodes-kaer

This is an n8n community node for the [Kaer Search API](https://api.kaer.ai/docs/search). It searches the web from a workflow, or from an AI Agent as a tool, and returns ranked results with titles, URLs and snippets. On the Deep lane, results also carry the page's main text.

[n8n](https://n8n.io/) is a [fair-code licensed](https://docs.n8n.io/n8n-community-license) workflow automation platform.

- [Installation](#installation)
- [Credentials](#credentials)
- [Operations](#operations)
- [Lanes](#lanes)
- [Options](#options)
- [Output](#output)
- [Use it as an AI Agent tool](#use-it-as-an-ai-agent-tool)
- [Errors](#errors)
- [Example workflow](#example-workflow)
- [Compatibility](#compatibility)
- [Development](#development)
- [Resources](#resources)
- [Version history](#version-history)

## Installation

### From the n8n editor

1. Open **Settings > Community nodes**.
2. Select **Install**.
3. Enter `n8n-nodes-kaer` and confirm.

Once the node is verified, you can also find it in the nodes panel: search for **Kaer**.

See the [community nodes installation guide](https://docs.n8n.io/integrations/community-nodes/installation-and-management) for details.

### Manual installation

For self-hosted n8n, install the package in the folder n8n loads community nodes from, then restart n8n:

```sh
cd ~/.n8n/nodes
npm install --omit=peer n8n-nodes-kaer
```

`--omit=peer` stops npm installing `n8n-workflow`, which n8n already provides; n8n's own installer leaves it out too. Without the flag, npm also tries to build a native module that the official n8n Docker image can't compile, and the install fails.

For Docker and queue mode, follow [manual installation](https://docs.n8n.io/integrations/community-nodes/installation-and-management/manual-installation) in the n8n docs, keeping `--omit=peer` on the install command.

## Credentials

The node uses a **Kaer API** credential.

1. Sign up at [api.kaer.ai](https://api.kaer.ai).
2. Search opens after the account's first top-up; adding a card in **Billing** first gives you free web searches. Without either, searches return `403 tier_required`.
3. Open **API keys**, create a key and tick the `search` scope. The node needs no other scope.
4. Copy the key straight away: it starts with `kaer_live_` and is shown only once.
5. In n8n, create a **Kaer API** credential and paste the key into **API Key**.

Leave **Base URL** as `https://api.kaer.ai/v1` unless Kaer gave you another address to test against.

The node sends the key as `Authorization: Bearer <key>`.

### How the credential test works

When you save the credential, n8n calls `GET /v1/me`. It is free and only reads the calling key, so testing never runs or bills a search. Any valid key passes, whatever its scopes.

## Operations

| Resource | Operation | What it does |
| --- | --- | --- |
| Search | Search the web | Runs one query (`POST /v1/search`) and returns ranked results. |

Each input item runs its own search, so you can feed the node a list of queries.

### Parameters

| Parameter | Description |
| --- | --- |
| Query | What to search for, 1 to 512 characters. |
| Lane | How Kaer runs the search. See [Lanes](#lanes). Default: Auto. |
| Number of Results | 1 to 25. Default: 5. The Deep lane may return fewer. |
| Simplify | On (default): one item per result. Off: the full response as one item. See [Output](#output). |
| Options | Optional filters. See [Options](#options). |

## Lanes

| Lane | What it does | Time limit |
| --- | --- | --- |
| Web | Kaer's own index alone. Fastest and cheapest. | 6 s |
| Fast | Kaer's index racing the live web. | 12 s |
| Deep | Every lane, re-ranked. Results carry the page's main text, up to 4,000 characters, when the page could be read. | 40 s |
| Auto | Kaer picks a lane for each query. You are billed for the lane that served it. | 40 s |

Each lane has its own price per query. See [search pricing](https://api.kaer.ai/docs/search-pricing). Failed searches, including ones that run past their time limit, are not charged.

## Options

| Option | Description |
| --- | --- |
| Include Domains | Only return results from these hosts or their subdomains, up to 20. Separate hosts with commas, for example `gov.uk, bbc.co.uk`. An expression that returns an array of hosts also works. A pasted address such as `https://www.gov.uk/guidance` is reduced to its host, `www.gov.uk`. |
| Exclude Domains | Never return results from these hosts or their subdomains, up to 20. Same format as Include Domains. |
| Offset | Results to skip before this page. Only the Web and Fast lanes page; the others return their first page and say so in `warnings`. Wins over Page when it is above 0. |
| Page | The page of results to return, counting from 1, in pages of Number of Results. Web and Fast lanes only. |
| Fields | Result fields to keep: Title, URL, Snippet, Source, Published Date, Text, Text Truncated, Text Source. Left empty, Simplify keeps Title, URL, Snippet, Published Date and Text; with Simplify off, every field comes back. |

## Output

With **Simplify** on, the node returns one item per result:

```json
{
  "title": "Energy price cap explained",
  "url": "https://example.org/price-cap",
  "snippet": "What the cap is and how it is set.",
  "published_date": null
}
```

`published_date` is `null` when the page has no known date. On the Deep lane each item also has `text`, the page's main text. If you pick **Fields**, each item has exactly those fields instead. When Kaer returns an instant answer (a sum, a conversion, the time), `warnings` (for example, that a lane ignored **Page**) or both, every item from that search carries them too. A search with no results returns no items, so an instant answer that came without results is dropped; turn **Simplify** off to keep it, or turn on **Always Output Data** in the node settings if the next node should still run.

With **Simplify** off, the node returns the API response as one item, including `served_lane`, `answer` (an instant answer such as a sum or a conversion, when there is one), `warnings`, and `kaer.request_id` and `kaer.cost_usd`. The full response format is in the [Search API docs](https://api.kaer.ai/docs/search).

## Use it as an AI Agent tool

The node is usable as a tool. In an **AI Agent** node, add a tool, search for **Kaer** and pick **Search the web**. To let the model write the query, select the sparkle button next to **Query** (or set it to `{{ $fromAI('query', 'What to search for') }}`). Leave Simplify on: the agent gets short, flat results.

If the AI Agent does not list Kaer as a tool on an older self-hosted instance, set `N8N_COMMUNITY_PACKAGES_ALLOW_TOOL_USAGE=true` and restart n8n.

## Errors

The node reports the Kaer API's own message, with the error code, the HTTP status, the request ID and a suggested fix. Quote the request ID (`req_…`) to [support@kaer.ai](mailto:support@kaer.ai) if you need help.

| Status | Codes | What to do |
| --- | --- | --- |
| 400 | `query_required`, `query_too_long`, `invalid_lane`, `invalid_num_results`, `invalid_paging`, `invalid_domains`, `invalid_fields` | Fix the parameter the message names. Before sending, the node checks the query length and the number of hosts in each domain list. |
| 401 | `missing_api_key`, `invalid_api_key` | Check the key in the credential, or create a new one. |
| 402 | `insufficient_credits`, `monthly_limit_reached`, `key_budget_exceeded` | Top up, raise the monthly cap, or raise the key's budget. |
| 403 | `tier_required` | Add a card under Billing for free web searches, or make the account's first top-up. |
| 403 | `insufficient_scope` | Give the key the `search` scope. |
| 403 | `ip_not_allowed`, `account_inactive` | Add this n8n instance's IP address to the key's allow-list, or contact support. |
| 429 | `rate_limit_exceeded`, `too_many_concurrent_searches` | Wait for the `Retry-After` time, or turn on **Retry On Fail** in the node settings. |
| 502, 503, 504 | `search_failed`, `search_busy`, `search_unavailable`, `search_timeout` | Try again shortly, or use a faster lane. These are not charged. |

With **Continue On Fail** on, a failed item becomes an output item with `error` and `description`, and the other items still run. An error from the API adds `code`, `httpCode`, `requestId` and, when the API sent a `Retry-After` header, `retryAfterSeconds`. A timeout or a network failure adds only `code`: `request_timeout` or `network_unreachable`.

## Example workflow

[`examples/kaer-search.json`](examples/kaer-search.json) runs two queries on the Fast lane, limited to UK government sites, and returns one item per result. In n8n, open a new workflow, select **...** > **Import from File**, choose the file, then pick your Kaer API credential on the Kaer node.

## Compatibility

- Built with `@n8n/node-cli` 0.57 against `n8n-workflow` 2.48, using n8n nodes API version 1.
- Built for self-hosted n8n and, once verified, n8n Cloud. The package has no runtime dependencies.

## Development

```sh
npm install
npm run lint     # n8n's community node lint rules
npm run build    # compiles to dist/
npm test         # builds, then runs the unit tests (node:test, no network)
npm run dev      # starts a local n8n with this node linked
```

`scripts/live-smoke.mjs` runs the built node against a real Kaer API. It bills each search it runs:

```sh
KAER_TEST_BASE_URL=https://api.kaer.ai/v1 KAER_API_KEY=kaer_live_... node scripts/live-smoke.mjs
```

Releases are published to npm from GitHub Actions with a provenance statement. Run `npm run release` on `main` to bump the version, tag and push; the tag starts `.github/workflows/publish.yml`.

## Resources

- [Kaer Search API docs](https://api.kaer.ai/docs/search)
- [Search pricing](https://api.kaer.ai/docs/search-pricing)
- [Kaer API sign-up and keys](https://api.kaer.ai)
- [n8n community nodes documentation](https://docs.n8n.io/integrations/community-nodes)
- Support: [support@kaer.ai](mailto:support@kaer.ai)

## Version history

### 0.1.1

First release: the Search resource with the Search the web operation, the Kaer API credential, and AI Agent tool support.
