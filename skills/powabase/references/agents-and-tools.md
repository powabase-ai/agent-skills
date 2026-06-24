# Agents, tools & sessions

An **agent** = an LLM + system prompt + settings + tools + optional knowledge
bases + session memory, run in a **ReAct** (reason → act → observe) loop. Streamed
over SSE. All paths under `{BASE_URL}` with two-header auth.

## 0. Designing an agent — cover all four pillars (be exhaustive, MECE)

A good agent is **deliberately specified on four axes**. Skipping any one is the
usual cause of mediocre results — **defaults are rarely right**. Be **MECE**: every
instruction, tool, and data source has a clear purpose, with **no gaps and no
overlap**.

1. **Data — knowledge bases** (link-KB endpoint in §1). Decide *exactly* which KBs the
   agent needs and link **all** of them (multiple KBs share one `knowledge_search`
   tool, filtered by `knowledge_base_names`). Per-link `config` can override `top_k` /
   `retrieval_method` for this agent without touching the KB. No KB needed? Say so and
   rely on tools/prompt — don't link an irrelevant KB "just in case" (it adds noise and
   cost). Match the KB's indexing/retrieval to the query shape (decision table in
   SKILL.md / [rag-context-engineering.md](rag-context-engineering.md)).
2. **Prompt — `system_prompt`, detailed and explicit.** The highest-leverage field.
   Write it in **Markdown with bulleted instruction lists**, not a vague sentence.
   Cover, MECE:
   - **Role & scope** — who the agent is; what it must and must **not** do.
   - **Inputs & context** — what it receives; how to use the KB / retrieved chunks.
   - **Tool-use policy** — when to call each tool, when *not* to, how to combine them
     (e.g. "call `web_search` only after the KB returns nothing relevant").
   - **Output contract** — exact format, length, tone, citation rules; pair with
     `response_format` (§2) for structured output.
   - **Constraints & edge cases** — refusals, missing-data handling, ambiguity, safety.
   - **Insights & examples** — short worked examples or domain facts that steer quality.

   Favor explicit and comprehensive over terse — ambiguity is where models go wrong.
3. **Tools — internal and external, assigned on purpose** (§4). Three kinds: **builtin**
   (eight, assign by name), **custom** (your own HTTP endpoint, SSRF-validated), and
   **MCP servers** (runtime tool discovery from an external provider). Give the agent
   *every* tool the task needs and *nothing* it doesn't. Lock parameters with
   `config_override` (§5) — e.g. pin `web_search` to `deep` + specific domains, or
   restrict `database_query` to named tables. Tool use requires **`/run/stream`**.
4. **Model + reasoning effort — choose, don't default.** `model` is any LiteLLM ID
   (§2); pick one matched to the task and **function-calling-capable** if it uses tools.
   On a reasoning-capable model, **set `settings.reasoning_effort`** (`low`/`medium`/
   `high`) explicitly — leaving it unset (or picking a weak model) is a common cause of
   bad output on hard tasks. Set `settings.temperature` deliberately too (low for
   precision/extraction, higher for ideation). The provider needs a BYOK key or AI-on-us.

> The same discipline applies to **orchestrations** — additionally make each member's
> `role_description` specific and non-overlapping (MECE across the team). See
> [orchestrations.md](orchestrations.md).

## 1. Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET / POST | `/api/agents` | List / create |
| GET / **PATCH** / DELETE | `/api/agents/{id}` | Get / update / delete |
| POST / GET | `/api/agents/{id}/tools` | Assign / list tool assignments |
| **PATCH** / DELETE | `/api/agents/{id}/tools/{assignment_id}` | Update `config_override` / remove |
| POST / GET | `/api/agents/{id}/knowledge-bases` | Link / list KBs (link auto-adds a `knowledge_search` tool; multiple KBs share one tool with a `knowledge_base_names` filter). Body `{ knowledge_base_id, config? }` — `config` can override this agent's `top_k` / `retrieval_method` for that KB without touching the KB's stored `retrieval_config` |
| DELETE | `/api/agents/{id}/knowledge-bases/{assignment_id}` | Unlink a KB |
| POST / GET | `/api/agents/{id}/mcp-servers` | Add / list MCP servers |
| **PUT** / DELETE | `/api/agents/{id}/mcp-servers/{server_id}` | Update / remove an MCP server |
| POST / GET | `/api/agents/{id}/hooks` | Add / list lifecycle hooks |
| DELETE | `/api/agents/{id}/hooks/{hook_id}` | Remove a hook |
| GET | `/api/agents/{id}/sessions` | List the agent's chat sessions |
| POST | `/api/agents/{id}/run` | **Sync run — no tools, no ReAct loop** (single LLM call) |
| POST | `/api/agents/{id}/run/stream` | **Streaming run — tools + ReAct + multi-turn** |
| GET | `/api/agents/runs/{run_id}` | Fetch a run (status, error, events, tool_calls, ...) |
| POST | `/api/agents/runs/{run_id}/approve` | Approve/deny a paused tool call |

Tool **definitions** live on a separate resource: GET/POST `/api/tools`,
GET/**PUT**/DELETE `/api/tools/{id}`.

## 2. Agent config

Create/update body honors **only** `name` (required on create), `model`,
`system_prompt`, `settings`.

```json
{ "name": "Docs Assistant", "model": "gpt-4o",
  "system_prompt": "Use the knowledge base to answer.",
  "settings": { "temperature": 0.7 } }
```

> **Top-level `temperature` (and other tuning fields) are silently dropped.** Nest
> all model tuning inside `settings`. No error is returned — you just get defaults.

**Reasoning / extended thinking** is driven by `settings.reasoning_effort`
(`"low"`/`"medium"`/`"high"`) on a reasoning-capable model — set it at create/update
time. There is **no** per-run `reasoning_requested` input; the run only *reports*
whether reasoning happened (a `reasoning_requested` field in the `start` SSE event
and run record). When set, the run emits `reasoning_delta` (per-token, forwarded)
and `reasoning` (persisted) events and stores `reasoning_steps` in the run record.

**`model` is a LiteLLM model ID**, passed through unchanged and **not** restricted to
the Studio picker: bare for OpenAI/Anthropic (`gpt-4o`, `claude-sonnet-4-6`), prefixed
otherwise — `gemini/<model>`, `openrouter/<org>/<model>` (e.g.
`openrouter/deepseek/deepseek-chat`; OpenRouter slugs must match LiteLLM's `openrouter/`
cost-map keys, which can differ from OpenRouter's own). Tool-using agents need a
function-calling-capable model. The provider needs a BYOK key (or to be AI-on-us) or the
run fails `provider_key_decrypt_failed`. Format + walkthrough:
[docs.powabase.ai/guides/byollm](https://docs.powabase.ai/guides/byollm).

**Per-run body** (`/run` and `/run/stream`): `message` (required); `session_id`
(omit to start fresh); `temperature` (per-run override); `response_format`
(JSON-schema for structured output); `max_context_tokens`; `citations_enabled`.
(There is **no** per-run `reasoning_requested` — reasoning is the agent's
`settings.reasoning_effort`, above.) **Context sources are mutually exclusive** —
provide at most **one** of `knowledge_bases` / `context_handler_id` /
`context_override` / `context_items`, or you get 400.

## 3. The ReAct loop & limits

`/run/stream` runs the loop: the LLM reasons, optionally calls tools (concurrency-
safe tools like KB search run in parallel; others sequentially), observes results,
and iterates until it produces text. The model also auto-compacts context as it
approaches the limit.

| Constraint | Default |
| --- | --- |
| Max ReAct steps | **25** (final step withholds tools to force a response) |
| Doom-loop detection | same tool + same args **3×** in a row → run fails |
| Output-truncation recovery | 3 continuation retries |
| Custom/MCP tool timeout | 30 s |
| Tool-result truncation | 50,000 chars (KB search & delegation exempt) |
| Approval timeout | 300 s |
| Max orchestration depth | 3 |

> **`/run` (sync) loads no tools and runs no loop.** If you assigned tools (or a
> KB) and call `/run`, they never fire. Use **`/run/stream`** for any tool use.

## 4. Tools — three types

### Builtin (assign by name) — exactly eight

`database_query`, `database_write`, `http_request`, `code_execute`,
`storage_read`, `storage_write`, `web_search`, `web_scrape`.

```json
POST /api/agents/{id}/tools   { "tool_name": "database_query" }
```

| Tool | Notes / constraints |
| --- | --- |
| `database_query` | Read-only `SELECT` (single statement). Runs as **DB superuser**. 50k-char cap. |
| `database_write` | INSERT/UPDATE/DELETE; UPDATE/DELETE require `WHERE`. Superuser. |
| `http_request` | External HTTP, 10k-char cap, 30 s. **No SSRF protection** — can reach `localhost`/RFC1918/`169.254.169.254`. |
| `code_execute` | Python/JS in a sandbox. Needs platform `CODE_SANDBOX_URL` (+ optional `CODE_SANDBOX_API_KEY`); else returns *"Code sandbox is not configured"*. |
| `storage_read` / `storage_write` | Project Storage list/download / upload UTF-8 text. `storage_read` returns a **signed URL** for binary files (inline content only for text). |
| `web_search` | Exa.ai (1–10 results, ~20–50k chars). Five `search_type` modes incl. agentic **`deep`** / **`deep-reasoning`** (slower, pricier — see callout). **Needs `EXA_API_KEY`** (Settings → Tools). |
| `web_scrape` | Firecrawl → markdown (≤200k chars — exempt from the 50k cap). **Needs `FIRECRAWL_API_KEY`**; `include_images` uses `gpt-4.1-mini` vision; direct image URLs bypass Firecrawl. |

> **Security:** `database_query`/`database_write` ignore the caller's identity and
> run as superuser — never expose `/run*` to end-user JWTs (see §8). Prefer a
> **custom tool** over builtin `http_request` for fixed endpoints (custom tools
> enforce SSRF validation).

#### `web_search` search modes (`search_type`) — pick deliberately; cost varies ~2.5×

Exa supports five modes; the default `auto` lets the engine choose neural vs keyword.
Set the mode per call, or **pin it via `config_override`** (§5).

| `search_type` | What it does | Base cost / call | When to use |
| --- | --- | --- | --- |
| `auto` *(default)* | Engine picks neural or keyword | $0.04 | Most queries |
| `neural` | Semantic / meaning-based | $0.04 | Conceptual, fuzzy intent |
| `keyword` | Exact-term matching | $0.04 | IDs, error codes, exact phrases |
| `deep` | Exa **agentic** deep search | $0.075 | Hard research questions; quality > latency |
| `deep-reasoning` | Agentic deep search **+ reasoning** | $0.10 | Hardest multi-hop questions; top quality |

- **Base cost is before the plan multiplier** (Free 100% · Self-serve 75% · Scale 50%);
  billing detail in [billing-limits-and-debugging.md](billing-limits-and-debugging.md) §2.
- `deep` / `deep-reasoning` are **much slower** and the priciest tiers —
  `deep-reasoning` is the most timeout-prone (30 s handler cap). **Reserve them for
  questions a standard search can't answer; don't make them an agent's default.** A
  timeout / 5xx is **not** billed (platform-error path), but a positive balance is still
  required to dispatch.
- Other params (all optional): `num_results` (1–10, default 5), `include_domains` /
  `exclude_domains`, `start_date` / `end_date` (ISO 8601, published-date filter),
  `category` (`company` / `news` / `research paper` / `tweet` / `github` / `wikipedia` /
  `personal site`), `content_mode` (`highlights` default · `compact_text` · `full_text`).
- **Pin a tier with `config_override`** to force it regardless of what the model picks —
  e.g. `{"config_override": {"search_type": "deep", "num_results": 3}}`. **Billing
  follows the forced type**, so pinning `deep` / `deep-reasoning` bills the deep tier on
  every call.

### Custom (your own HTTP endpoint)

```json
POST /api/tools
{ "name": "weather_lookup", "description": "Get current weather for a city",
  "type": "http",
  "input_schema": { "type": "object", "properties": { "city": { "type": "string" } }, "required": ["city"] },
  "config": { "endpoint": "https://api.weather.com/v1/current", "method": "GET" } }
```

At call time the platform POSTs the tool arguments (method overridable via
`config.method`) to `config.endpoint`, returns the response (≤10k chars, 30 s,
SSRF-validated). **Top-level `endpoint_url`/`method`/`headers` are silently
dropped — they must go inside `config`** (`config.endpoint`, `config.method`,
`config.headers`, `config.timeout_seconds`). `type` is a free-form label, not used
for dispatch; `input_schema` isn't validated at create time.

### MCP servers (runtime tool discovery)

```json
POST /api/agents/{id}/mcp-servers
{ "name": "GitHub Tools", "url": "https://mcp.example.com/github/mcp",
  "transport": "http", "headers": { "Authorization": "Bearer ..." } }
```

At each run the platform calls `tools/list`, namespaces discovered tools as
`mcp__{server_name}__{tool_name}`, and calls them via `tools/call` (30 s each).

> - **`transport` defaults to `http`** (streamable HTTP). `sse` is accepted/stored
>   but **not honored** by the current client — effectively HTTP-only.
> - **Discovery is fail-open:** a broken `tools/list` drops that server's tools
>   **silently**; the run continues with no error surfaced.
> - Duplicate server `name` for an agent → 409. Per-server control via `headers` and
>   `enabled` (`enabled: false` skips discovery entirely — no `tools/list`/`tools/call`).

(Note: this MCP feature is the agent connecting to external tool providers — it is
**not** a Powabase MCP server for your coding assistant, which doesn't exist yet.)

## 5. `config_override` (PATCH a tool assignment)

Body **must** use the key `config_override` (passing `config` is a silent no-op
returning 200 unchanged).

- **Database tools:** restrict tables — `{"config_override": {"schemas": {"public": ["users","orders"]}}}`.
  System schemas (`ai`/`auth`/`storage`/`pg_*`) are rejected.
- **Other builtins:** any key matching the tool's `input_schema` is **force-injected
  into every call** (e.g. lock `web_search` to `{"max_results": 3, "include_domains": ["x.com"]}`).
  Keys not in the schema are silently dropped.
- **Custom/MCP tools:** `config_override` is not used (control via the Tool's
  `config` / the MCP server's `headers`/`enabled`).

## 6. Sessions

A session is a multi-turn conversation holding a sequence of runs (each with input,
response, tool calls, retrieved context, usage). **There is no create-session
endpoint** — omit `session_id` on a run and capture it from the `start` SSE event;
pass it back on later runs to continue.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/sessions/{id}` | Get a session |
| GET | `/api/sessions/{id}/messages` | Assembled messages (each assistant message carries `retrieved_context`) |
| GET | `/api/sessions/{id}/runs` | Runs in the session |
| GET | `/api/sessions/{id}/runs/{run_id}/retrieved-context` | Context injected for one run |
| DELETE | `/api/sessions/{id}` | Delete the session + its runs |

Ownership is enforced; a session you don't own returns **404** (not 403), so you
can't distinguish "missing" from "not yours". (This **agent session** is unrelated
to the GoTrue **auth session** — see [studio-setup-and-human-handoff.md](studio-setup-and-human-handoff.md) / glossary.)

## 7. Approval / human-in-the-loop

Implemented as a `PreToolUse` hook of `type: "approval"`. When the agent calls a
matching tool, the stream emits `approval_requested` (with `tool_name`,
`tool_input`, `run_id`) and **blocks**. Resume:

```json
POST /api/agents/runs/{run_id}/approve   { "approved": true }   // or false to reject
```

Times out after **300 s** (configurable). Set the hook's `matcher` to a tool name
to gate just that tool; omit `matcher` to require approval for **all** tool calls.

```json
POST /api/agents/{id}/hooks
{ "event": "PreToolUse", "type": "approval", "matcher": "database_write",
  "config": { "message": "Approve this write?" } }
```

> Approval (like all hooks) fires only on **standalone** agent runs — **not** when this
> agent runs inside an orchestration. Don't rely on it as an orchestration gate; see
> [orchestrations.md](orchestrations.md) §5.

## 8. Hooks (lifecycle)

Events: `OnRunStart`, `PreToolUse`, `OnDelegation` (before a delegate-tool call),
`PostToolUse`, `PreResponse`, `OnRunComplete`. Types: `http`, `rule`, `approval`
(§7). Required on create: `event`, `type`, `config`; optional `matcher` (tool name),
`enabled` (default `true`), `position` (run order, default `0`). **`event`/`type` are
stored verbatim and not validated** — an unknown value is saved but never fires, so a
typo fails silently. No update endpoint; delete and re-create to change one.

`http` contract: Powabase POSTs `{ event, tool_name, data, output? }` to `config.url`
(with `config.headers`; `config.timeout_seconds` default 5; URL is SSRF-checked).
Return `200` + `{ "action": "allow"|"deny", "message"?, "modified_input"?, "modified_output"? }`
— `modified_input` replaces tool args (`PreToolUse`); `modified_output` replaces the
tool result (`PostToolUse`) or final content (`PreResponse`). Any non-200/timeout =
**fail-open** (allow). `rule`: match `CONTAINS`/`STARTS_WITH`/`MATCHES`/`IN` against
tool args; first deny wins.

> **Hooks fire at lifecycle boundaries, not per token — they cannot transform the SSE
> stream.** `PreResponse` runs *after* the loop on the assembled content, by which point
> a streaming client has already received every `chunk`. To rewrite streamed tokens
> (e.g. inline markers → rich content), do it in your own proxy/app, not a hook. Hooks
> also don't fire inside orchestrations ([orchestrations.md](orchestrations.md) §5).

## 9. Run records & failed-run debugging

`GET /api/agents/runs/{run_id}` returns `status`, `error`, `usage`,
`input_messages`, `output_messages`, `content`, `retrieved_context`, `events`
(persisted SSE events in order), `tool_calls`, `reasoning_steps`, plus
`parent_orchestration_run_id` / `parent_workflow_execution_id` (null at top level).
The exact `status` enum isn't documented — read it from a real run. The `error`
field and the first failure-shaped entry in `events` are the highest-signal places
to start; the full playbook (and the error→cause table) is in
[billing-limits-and-debugging.md](billing-limits-and-debugging.md).

**Citations.** Set `citations_enabled: true` on the run (§2) to have the model
inline citation markers; the platform maps them to the retrieved chunks and the
final response / run record carries a `citations` array alongside `retrieved_context`
(the source chunks + metadata). Citations arrive in the **`complete`** event, not a
separate SSE event — render them from the final payload or the run record.

## 10. Context handlers (RAG without an agent)

Standalone retrieval: `POST /api/context-handlers` with
`{ "query", "knowledge_bases": [{ "id", "top_k"? }], "max_context_tokens"? }`
retrieves chunks from each KB for injection into your own prompts. GET to list/get.

> **Asymmetry:** the request field is `knowledge_bases`; the response echoes it as
> `knowledge_base_configs`, plus `metadata.query_enrichment` and per-KB `errors`.

## 11. The per-user data pattern (important)

Because tools run as superuser and end-user JWTs aren't forwarded, enforce
per-user scope **yourself**: run the agent from your backend with the Service Role
key and inject the user's allowed data via `context_items` (query `ai.chunks` under
the user's JWT first), or via a custom tool that takes an opaque `session_token`
your backend resolves to the user. Full recipes:
[baas-database-rls.md](baas-database-rls.md) and the cookbook on `docs.powabase.ai`.
