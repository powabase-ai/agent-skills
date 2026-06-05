# Workflows & Copilot

A **workflow** is a directed acyclic graph of **blocks** connected by **edges**.
Blocks run in topological order; each receives upstream outputs. Blocks can call
agents, orchestrations, LLMs, or code — so a fixed graph still produces dynamic
content. All paths under `{BASE_URL}` with two-header auth.

## 1. Block types — exactly ten

`starter`, `webhook`, `agent`, `orchestration`, `code`, `condition`, `split`,
`platform_api`, `general_api`, `response`. (Back-compat aliases: `function` →
`code`, `api_call` → `general_api`.)

> **`input`, `output`, and `llm` are NOT block types.** Use `starter` to declare
> inputs and `response` to return output. An unknown type → `400 Unknown block type`
> at graph save.

| Block | Purpose | Key `config` |
| --- | --- | --- |
| `starter` | Manual/API trigger; declares inputs; **also holds scheduling** | schedule fields (§5) |
| `webhook` | HTTP trigger at `POST /api/webhooks/{webhook_id}` | `webhook_id` (UUID), `webhook_secret` |
| `agent` | Run an existing agent | `agent_id`, `message` (templated) |
| `orchestration` | Run a multi-agent coordinator | `orchestration_id`, `message` |
| `code` | Run Python/JavaScript | language, source, input mappings |
| `condition` | Branch on a boolean expression | expression (Python-safe AST subset; **no function calls**) |
| `split` | Parallel fan-out to downstream branches | branch rules |
| `platform_api` | Call a platform resource (KB search, agent run, ...) | resource type + params |
| `general_api` | Call an external HTTP API | URL, method, headers, body template |
| `response` | Return the workflow result | result template |

For exact `config` schemas of `code`/`split`/`platform_api`/`general_api` (the
docs describe these only in prose), use the Copilot's `get_block_info` tool or
verify on `docs.powabase.ai`.

## 2. Graph model & reference syntax

The graph is `{ "blocks": [...], "edges": [...] }`.

```json
{
  "blocks": [
    { "id": "start", "type": "starter",  "config": {}, "position": {"x": 0,   "y": 0} },
    { "id": "out",   "type": "response", "config": {}, "position": {"x": 300, "y": 0} }
  ],
  "edges": [ { "source": "start", "target": "out" } ]
}
```

Block `id` may contain letters, digits, `_`, `-`, and **spaces**. Each edge needs
`source` + `target` referencing blocks in the same graph.

**Reference upstream outputs with angle brackets:** `<blockId.output.field.nested>`.

- Inside a string: substituted as text — `"Hello <fetch.output.name>!"`.
- A value that is **one whole reference** keeps its original type —
  `"<extract.output.tags>"` → an array, not a stringified array.
- Starter inputs surface as `<starter.output.variableName>`.
- Legacy `{{variables.x}}` still works in agent/code templates, but **angle
  brackets are canonical** and work everywhere.
- An unresolvable reference is left **as-is** in the output so you can spot it in
  the block logs.

## 3. Endpoints (update verb is **PATCH**)

| Method | Path | Purpose |
| --- | --- | --- |
| GET / POST | `/api/workflows` | List (`?limit&offset`) / create (`{name, description?}`) |
| GET / **PATCH** / DELETE | `/api/workflows/{id}` | Get (incl. blocks+edges) / rename / delete |
| **PUT** | `/api/workflows/{id}/graph` | Save the complete graph (blocks + edges) |
| POST | `/api/workflows/{id}/execute` | Run synchronously |
| POST | `/api/workflows/{id}/execute/stream` | Run with streaming SSE |
| GET | `/api/workflows/{id}/executions` | Execution history |
| GET | `/api/workflows/{id}/executions/{eid}/logs` | **Per-block logs** (start here when a run fails) |
| POST | `/api/workflows/{id}/deploy` / `/undeploy` | Enable / disable the webhook (+ schedule) |
| POST | `/api/workflows/{id}/arm` | Arm the webhook for one single-use trigger |

> There is **no `GET .../graph`** — read the graph from `GET /api/workflows/{id}`.

**Execute body:** `{ "variables": { ... } }`. `variables` is canonical; `input` is
a legacy alias (server reads `variables` then falls back to `input`).

> `POST /api/workflows/{id}/execute` and `/execute/stream` are **rate-limited at
> 20 requests/minute per user → 429**. Back off with jitter; don't retry within the
> same minute. See [billing-limits-and-debugging.md](billing-limits-and-debugging.md).

## 4. Triggers

1. **Manual / API** — `starter` block + `POST .../execute`.
2. **Webhook** — `webhook` block + `POST /api/webhooks/{webhook_id}` (§6).
3. **Scheduled** — set on the `starter` block config (§5).

**Deploy vs Arm:**

| Mode | Endpoint | Effect |
| --- | --- | --- |
| **Deploy** | `POST .../deploy` → `{"ok": true, "state": "deployed"}` | Webhook accepts **unlimited** calls until undeploy. Production. |
| **Arm** | `POST .../arm` → `{"ok": true, "armed_until": "<iso>"}` | Opens a **10-minute window** for **exactly one** call. One-shot tests; re-arm after. |

> **Neither deploy nor arm returns or rotates the webhook secret.** `webhook_id`
> and `webhook_secret` live in the **webhook block's `config`** (minted at block
> creation). To read them, `GET /api/workflows/{id}` and find the `webhook` block.
> If you create a webhook block via API you must mint both yourself (a valid UUID +
> a non-empty secret) — a webhook block with no secret is silently un-triggerable.

## 5. Scheduling (on the `starter` block `config`)

`schedule_enabled: true` + one of:

- **interval:** `schedule_type: "interval"`, `schedule_interval_value` (int),
  `schedule_interval_unit` (`minutes`/`hours`/`days`). **Minimum effective interval
  is 60 s** even if you set less.
- **cron:** `schedule_type: "cron"`, `schedule_cron` (croniter syntax, default
  `0 * * * *`).

Optional bounds: `schedule_timezone` (IANA, default UTC), `schedule_start_at` /
`schedule_end_at` (ISO 8601), `schedule_max_runs`. Schedules activate on `deploy`
(the scheduler tick is every 30 s) and are cleared on `undeploy`. Scheduled runs
use the starter variables' configured defaults (no per-run override).

## 6. Webhook trigger endpoint

`POST /api/webhooks/{webhook_id}` runs the workflow inline/synchronously (**5-minute
timeout** → 504) and returns the final output. The request body becomes the input
variables.

**Auth is the webhook secret — no `apikey`:** `Authorization: Bearer <secret>` (or
`?token=<secret>` when you can't set headers). The secret is compared with
constant-time `hmac.compare_digest`, so extra whitespace fails.

> **The `Bearer ` trailing-space footgun.** The server matches
> `auth_header.lower().startswith("bearer ")`. If you send literally `"Bearer "`
> (trailing space, empty token — what `Bearer ${secret ?? ""}` produces when the
> secret is undefined) you get a **401 and the `?token=` fallback is NOT consulted**.
> Guard the construction so you never send a Bearer header without a token.

Responses: `200 {execution_id, status, output}`; `401` (bad/missing secret); `403`
(not deployed and not armed, or an armed single-use slot already consumed);
`404 WORKFLOW_NOT_FOUND`; `500 EXECUTION_FAILED`; `504 EXECUTION_TIMEOUT`. There's
**no body HMAC, replay protection, or idempotency** — validate upstream signatures
(Stripe/GitHub) yourself in the first `code` block, and remember two identical
calls run the workflow twice.

## 7. Copilot (natural language → workflow graph)

The Copilot generates/edits a workflow's blocks and edges from a chat description.

| Method | Path | Purpose |
| --- | --- | --- |
| POST / GET | `/api/copilot/sessions` | Create (`{workflow_id}`) / get by `?workflow_id=` |
| GET | `/api/copilot/sessions/{id}/messages` | Conversation history |
| POST | `/api/copilot/sessions/{id}/chat` | Send a message; stream SSE response |
| POST | `/api/copilot/sessions/{id}/messages/{mid}/snapshot` | Apply a suggestion — requires a `pre_snapshot` body (400 without it); `mid` is the `message_id` from `complete` |
| GET / PUT | `/api/copilot/settings/model` | Get / set the Copilot model (default `claude-opus-4-6`) |
| DELETE | `/api/copilot/sessions/{id}` | Delete a session |

Chat body: `{ "message", "workflow_state"?: { nodes, edges } }`. Chat SSE events:
`status`, `tool_call`, `tool_result`, `content_delta` (token), `complete`
(`message_id`, `content`, `workflow_diff`), `error`. The Copilot runs a ReAct loop
(25 steps, temp 0.7; workflow state truncated at 50k chars, block configs over 2k
truncated) with tools including `modify_workflow`, `get_block_info`, `get_db_schema`,
`list_project_assets`, `get_asset_details`, `execute_public_sql` (read-only,
**public schema only**), `get_workflow_run_logs`, `manage_project_asset`
(UI-confirmed). Allowed models are function-calling-capable only (GPT-5.2/4.1,
o3/o4, Claude Opus/Sonnet/Haiku 4.x, Gemini; default `claude-opus-4-6`). It bills
as an agent run. `GET /api/copilot/settings/model` returns the authoritative
selectable list and current default.

## 8. Gotchas

- **10 block types only** (`input`/`output`/`llm` invalid).
- **`variables`** is canonical for execute (`input` is a legacy alias).
- **No `GET .../graph`** — read from `GET /api/workflows/{id}`.
- **deploy/arm don't return secrets** — read them from the webhook block config.
- **`Bearer ` trailing-space → 401** (and `?token=` skipped).
- **Armed = single-use** within 10 min; concurrent valid calls → only the first
  wins (atomic disarm), others get 403.
- **Webhook runs are synchronous with a 5-min cap** — for long work, ack fast and
  offload (e.g. a `general_api` block dispatching to your own queue).
- **`/execute` is 20/min/user → 429.**
- **Condition expressions** allow no function calls (safe AST subset only).
