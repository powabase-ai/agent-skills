---
name: powabase
description: "Use for ANY task building on Powabase, the multi-tenant AI Backend-as-a-Service (projects on *.p.powabase.ai, the /api/* surface). Triggers: RAG & knowledge bases (Sources, document upload/extraction, indexing strategies chunk_embed/full_document/page_index/graph_index/doc2json, retrieval vector/full-text/hybrid/tree search, reranking, query enrichment, multimodal/image retrieval, embeddings, pgvector); agents (ReAct loops, builtin/custom/MCP tools, sessions, streaming, approval/human-in-the-loop); multi-agent orchestrations (supervisor/sequential/parallel); workflows (block graphs, webhooks, scheduled/cron triggers, Copilot); SSE streaming of agent/orchestration/workflow runs; and the Powabase BaaS layer — PostgREST, Row Level Security, the ai.* schema, GoTrue auth, Storage, Realtime, direct Postgres. Also connecting/authenticating, choosing the right API key, and handling billing/rate-limit/error responses."
license: MIT
metadata:
  author: powabase
  version: "1.0.0" # x-release-please-version
  date: June 2026
---

# Powabase

Powabase is a multi-tenant **AI Backend-as-a-Service**. One REST API gives every
project an isolated stack — Postgres + pgvector, an API gateway, auth, storage,
realtime, and an AI worker — exposing three composable modules on top of a
Supabase-style backend:

| Module | What it is | Entry reference |
| --- | --- | --- |
| **Context Engineering (RAG)** | Sources → extraction → Knowledge Bases → indexing → retrieval → reranking | [rag-context-engineering.md](references/rag-context-engineering.md) |
| **Agent Orchestration** | ReAct agents with tools, sessions, streaming; multi-agent coordinators | [agents-and-tools.md](references/agents-and-tools.md) · [orchestrations.md](references/orchestrations.md) |
| **Workflow Automation** | DAG of blocks; webhook / scheduled triggers; NL Copilot | [workflows-and-copilot.md](references/workflows-and-copilot.md) |
| **BaaS layer** | PostgREST + RLS, GoTrue auth, Storage, Realtime, direct Postgres | [baas-database-rls.md](references/baas-database-rls.md) · [baas-auth-storage-realtime.md](references/baas-auth-storage-realtime.md) |

Use only the modules you need. A KB can attach to an agent; an agent can be a
block in a workflow; a workflow can call a KB search — they compose.

## Core principles

1. **The `/api/*` surface is still evolving — verify against live docs.** Don't
   trust this snapshot for exact request/response shapes. The docs at
   `https://docs.powabase.ai` are the contract; fetch the relevant page (Mintlify
   — you can append `.md` to a page path) before relying on a field you're unsure
   about. This skill flags known ambiguities inline.
2. **Verify your work.** After a change, make a real call (`GET /api/agents`, a KB
   search, a one-message run) and read the response. A fix without a confirming
   call is incomplete.
3. **Recover, don't loop.** If an approach fails 2–3 times, stop and reconsider —
   re-read the error, check the run record (see the debugging playbook), try a
   different method. The agent itself fails a run if it calls the same tool with
   the same args 3× in a row ("doom loop").
4. **Two headers or 401.** Every `/api/*`, `/rest/v1/*`, `/auth/v1/*`,
   `/storage/v1/*` request needs **both** `apikey` and `Authorization: Bearer`.
   Sending one is the #1 cause of 401s.
5. **Security is not the default — make it explicit.** See the security box below.
6. **Hand off to the human for Studio-only setup.** Credentials, BYOK provider
   keys, and tool API keys live behind the Studio UI. Don't guess them — ask, and
   point the user to the exact place. See [studio-setup-and-human-handoff.md](references/studio-setup-and-human-handoff.md).

> ### ⚠️ Security must-knows (read before exposing anything to end users)
> - **Run agents from a trusted backend only.** Powabase does **not** forward
>   end-user JWTs to agent tools — `database_query`/`database_write` run on the DB
>   **superuser connection** (RLS bypassed) regardless of caller. Exposing
>   `/api/agents/{id}/run/stream` (the tool-bearing path) to clients with their own
>   tokens gives them full project-wide DB access. Inject per-user data yourself
>   (via `context_items` or a custom tool). See [agents-and-tools.md](references/agents-and-tools.md).
> - **`ai.*` RLS is project-wide, not per-user.** Any signed-in (`authenticated`)
>   user can read every agent/KB/workflow in the project; only session tables
>   filter by `user_id`. See [baas-database-rls.md](references/baas-database-rls.md).
> - **Never ship the Service Role key, JWT Secret, or Database URL client-side.**
>   The Anon (Publishable) key is the only credential safe in a browser/mobile app.

## Connect in 60 seconds

Base URL is the **Project URL**: `https://{ref}.p.powabase.ai`. Most platform docs
(and this skill) assume the **Service Role (Secret) Key** for server-side `/api/*`
calls.

```python
import requests
BASE_URL = "{BASE_URL}"   # Connect modal → Project URL
API_KEY  = "{API_KEY}"    # Connect modal → Service Role (Secret) Key
headers = {"apikey": API_KEY, "Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"}
requests.get(f"{BASE_URL}/api/agents", headers=headers).json()   # verify: 200 + {agents, total, ...}
```

**Which key for which surface:**

| Key | Use for | Client-safe? |
| --- | --- | --- |
| **Project URL** | `BASE_URL` for every call | Yes |
| **Anon (Publishable)** | Browser calls to PostgREST/Storage that respect RLS | **Yes** |
| **Service Role (Secret)** | Server-side `/api/*` and RLS-bypassing PostgREST | **No — server only** |
| **JWT Secret** | Verifying user JWTs on your backend | **No** |
| **Database URL** | Direct Postgres (migrations, ORMs, psql) | **No** |

→ **The credentials come from the Studio's Connect modal** (project header →
**Connect**, or append `?showConnect=true` to a project URL). If you don't have
them, **ask the user to open it and paste the Project URL + Service Role Key**.
Full detail: [connection-and-auth.md](references/connection-and-auth.md). Shared
conventions (errors, pagination, PUT vs PATCH, headers): [api-conventions.md](references/api-conventions.md).

## Custom database tables — the BaaS core

Powabase is a **full Supabase-style backend first**, AI modules second. Every
project ships an isolated Postgres + **PostgREST** + GoTrue + Storage + Realtime —
so for ordinary app data (users' profiles, todos, orders, app state) you **create
your own `public` tables and use them directly**; don't model app data as agents/KBs.
This should be your default reach for anything that isn't RAG/agents/workflows.

- **Define tables** via the Database URL (psql/ORM/migrations) or Studio SQL — your
  `public` schema is yours to migrate.
- **CRUD over PostgREST** at `/rest/v1/{table}` — `GET ?col=eq.val&select=...&order=`,
  `POST`, `PATCH ?id=eq.{id}`, `DELETE ?id=eq.{id}` (filters **required** on
  write), embeds (`select=*,relation(*)`), upsert (`Prefer: resolution=merge-duplicates`),
  RPC (`/rest/v1/rpc/{fn}`). Two-header auth applies.
- **The Anon (Publishable) key is browser-safe** for these calls **as long as RLS is
  on** — and **new `public` tables have RLS OFF by default**, so a fresh table is
  world-readable/writable to anyone with the Anon key until you `ENABLE ROW LEVEL
  SECURITY` and add policies. Turn RLS on as step one for any user-facing table.
- An agent can read/write these same tables via its `database_query`/`database_write`
  tools — but those run as **DB superuser (RLS bypassed)**; see the security box.

Full surface — schemas, RLS posture, PostgREST patterns, direct Postgres/pooler,
extensions: [baas-database-rls.md](references/baas-database-rls.md).

## Canonical RAG flow (upload → index → agent → stream)

The reference end-to-end pattern. Each step links to depth.

1. **Upload** `POST /api/sources/upload` (multipart `file`) → poll
   `GET /api/sources/{id}` until `extraction_status` is terminal. **Extraction is a
   barrier:** the next step needs `extracted` specifically. Re-uploading identical
   bytes returns **409 `duplicate_source`** (project-wide dedup) — reuse it, don't
   treat it as an error. See [rag-context-engineering.md](references/rag-context-engineering.md) §1.
2. **Create KB** `POST /api/knowledge-bases` `{name}` → **add source**
   `POST /api/knowledge-bases/{kb_id}/sources` `{source_id}` (triggers indexing).
   This **400s unless the source is `extracted`** (`attention_required` is rejected —
   re-extract with OCR). Re-adding the same source is an idempotent re-index. Poll
   until the indexed source is `indexed`.
3. **Create agent** `POST /api/agents` `{name, model, system_prompt, settings}` →
   **link KB** `POST /api/agents/{id}/knowledge-bases` `{knowledge_base_id}` (the
   agent auto-gets a `knowledge_search` tool).
4. **Chat (streaming)** `POST /api/agents/{id}/run/stream` `{message}` — consume
   SSE; capture `session_id` from the `start` event for multi-turn.

> **Extraction artifacts are reusable beyond RAG.** Every Source also exposes
> **derivatives** — per-page images (rendered PNGs), per-page text, and whole-doc
> markdown/text — that you can render directly in your own UI (e.g. a document
> viewer). Reach for these before reinventing PDF rendering. See
> [rag-context-engineering.md](references/rag-context-engineering.md) §1.

Details: [rag-context-engineering.md](references/rag-context-engineering.md),
[agents-and-tools.md](references/agents-and-tools.md), and the SSE parser in
[streaming-sse.md](references/streaming-sse.md).

## Decision trees

**Which indexing strategy + retrieval method?** (set on the KB; full table in
[rag-context-engineering.md](references/rag-context-engineering.md))

| Your documents / queries | Indexing strategy | Retrieval method |
| --- | --- | --- |
| General docs, mixed queries (**default**) | `chunk_embed` | `hybrid` |
| Exact tokens — IDs, error codes, product names | `chunk_embed` | `full_text` |
| Whole short docs as a unit (cases, memos, papers) | `full_document` | `hybrid` (`top_k=3`) |
| Long structured PDFs, structural queries | `page_index` | `tree_search` |
| Cross-referenced corpora (regs, standards, code) | `graph_index` | `hybrid` |
| Structured field extraction (invoices, forms) | `doc2json` | `vector_search` |

> `tree_search` works **only** with `page_index` KBs. `build-bm25` and `full_text`/`hybrid` need a KB whose retrieval method includes BM25.

> **Tune retrieval quality with three `retrieval_config` knobs** (stored on the KB,
> query-time, no reindex; settable at create or via `PATCH`): `reranker`
> (precision), `query_enrichment` (LLM query rewrite for conversational/multi-turn),
> `context_mode: "image"` (multimodal retrieval — all strategies except `doc2json`).
> See [rag-context-engineering.md](references/rag-context-engineering.md) §6.

**Agent vs Orchestration vs Workflow?**

- **Agent** — one LLM decides what to do, calls tools in a ReAct loop. Open-ended
  conversation/task. → [agents-and-tools.md](references/agents-and-tools.md)
- **Orchestration** — several specialized agents under a coordinator
  (supervisor/sequential/parallel). Multi-domain or multi-stage reasoning. →
  [orchestrations.md](references/orchestrations.md)
- **Workflow** — a fixed DAG you control; blocks may call agents/LLMs/code.
  Known steps, dynamic content; webhook/cron triggers. →
  [workflows-and-copilot.md](references/workflows-and-copilot.md)

> **Specify any agent/orchestration exhaustively (MECE).** Cover all four pillars —
> **data** (link the right KBs), **prompt** (detailed, explicit, Markdown bulleted
> instructions), **tools** (builtin / custom / MCP, only what's needed), and **model +
> `reasoning_effort`** (choose deliberately — **defaults often underperform**). No gaps,
> no overlap. Full checklists: [agents-and-tools.md](references/agents-and-tools.md) §0 ·
> [orchestrations.md](references/orchestrations.md).

**Typed `/api/*` vs PostgREST vs direct Postgres?** Use **`/api/*`** for anything
the platform manages (runs, indexing, workflow execution — it coordinates async
work and ownership). Use **PostgREST** (`/rest/v1/*`) for your own `public` tables
and read-only `ai.*` queries (mind RLS + `Accept-Profile: ai`). Use the **Database
URL** for migrations/ORMs/extensions. → [baas-database-rls.md](references/baas-database-rls.md)

## Top cross-cutting gotchas

The footguns most likely to bite. Each is expanded in a reference.

- **Two headers, same key** (server-side) or 401. → [api-conventions.md](references/api-conventions.md)
- **`temperature` must nest in `settings`.** Top-level `temperature` (and other
  tuning fields) on agent create/update is **silently dropped**. → [agents-and-tools.md](references/agents-and-tools.md)
- **`/api/agents/{id}/run` has no tools and no ReAct loop.** For any tool use (incl.
  KB search) use **`/run/stream`**. → [agents-and-tools.md](references/agents-and-tools.md)
- **Querying `ai.*` via PostgREST needs `Accept-Profile: ai`** (writes:
  `Content-Profile: ai`) — without it you get `public` and a 404/empty. → [baas-database-rls.md](references/baas-database-rls.md)
- **Workflows have exactly 10 block types.** `input`/`output`/`llm` are not real
  (use `starter` / `response`). → [workflows-and-copilot.md](references/workflows-and-copilot.md)
- **Webhook auth: `Authorization: Bearer <secret>` with a trailing space and no
  token returns 401** and won't fall back to `?token=`. Guard against
  `Bearer ${secret ?? ""}`. → [workflows-and-copilot.md](references/workflows-and-copilot.md)
- **MCP server `transport` defaults to `http`** (streamable HTTP). `sse` is
  accepted but not honored by the current client. → [agents-and-tools.md](references/agents-and-tools.md)
- **Billing: `402 insufficient_credits` → do NOT retry** (surface `renews_at`);
  **`503 billing service unreachable` → retry with backoff.** → [billing-limits-and-debugging.md](references/billing-limits-and-debugging.md)
- **Workflow `/execute` is rate-limited at 20/min per user → `429`.** Back off with
  jitter. → [billing-limits-and-debugging.md](references/billing-limits-and-debugging.md)
- **Realtime `postgres_changes` deliver nothing until you create the
  `supabase_realtime` publication.** → [baas-auth-storage-realtime.md](references/baas-auth-storage-realtime.md)
- **A run failed?** `GET /api/agents/runs/{run_id}` (`error`, `events`,
  `retrieved_context`) is the highest-signal start. → [billing-limits-and-debugging.md](references/billing-limits-and-debugging.md)

## When to involve the human (Studio-only)

Some setup can't be done over the API. When you hit one, **pause and tell the user
exactly where to go** (full table in [studio-setup-and-human-handoff.md](references/studio-setup-and-human-handoff.md)):

| Need | Ask the user to go to |
| --- | --- |
| Project URL / API keys / Database URL | **Connect modal** (project header → Connect) |
| BYOK model provider keys (or "AI-on-us" status) | **Settings → LLM Provider Keys** |
| `web_search` needs `EXA_API_KEY`; `web_scrape` needs `FIRECRAWL_API_KEY` | **Settings → Tools** *(also settable via `PUT /api/settings`)* |
| Database restore / point-in-time recovery | **Email support** (no self-service) |
| Out of credits after a `402` | Top up / upgrade (account-level) |

## Powabase MCP server

<!-- PLACEHOLDER — Powabase ships no MCP server yet (unlike Supabase); fill in URL / .mcp.json / auth / tool list when it launches. -->
**Coming soon — none exists today.** There is no first-party Powabase MCP server or
CLI. Build requests over raw HTTP (principle #1) and verify shapes against the live
docs. Don't assume tools named `powabase_*` exist.

> Separately, an agent can connect to *external* MCP servers as runtime tools — a
> real Powabase feature ([agents-and-tools.md](references/agents-and-tools.md)), unrelated to a Powabase MCP server for your assistant.

## References

- [connection-and-auth.md](references/connection-and-auth.md) — Connect modal, key types, the two-header pattern, base URL, token refresh.
- [api-conventions.md](references/api-conventions.md) — error envelopes per service, pagination, PUT vs PATCH, naming traps, retry logic.
- [rag-context-engineering.md](references/rag-context-engineering.md) — Sources, Knowledge Bases, indexing strategies, retrieval methods, reranking, query enrichment, multimodal retrieval, enrichment.
- [agents-and-tools.md](references/agents-and-tools.md) — agent config, ReAct limits, builtin/custom/MCP tools, sessions, approval, hooks, run records.
- [orchestrations.md](references/orchestrations.md) — supervisor/sequential/parallel coordinators, entities, delegation, streaming.
- [workflows-and-copilot.md](references/workflows-and-copilot.md) — 10 block types, graph & reference syntax, triggers, webhooks, Copilot.
- [streaming-sse.md](references/streaming-sse.md) — SSE event tables and robust Python/TypeScript parsers.
- [baas-database-rls.md](references/baas-database-rls.md) — schemas, the `ai.*` schema, RLS posture, PostgREST, direct Postgres, extensions.
- [baas-auth-storage-realtime.md](references/baas-auth-storage-realtime.md) — GoTrue auth, Storage, Realtime.
- [billing-limits-and-debugging.md](references/billing-limits-and-debugging.md) — BYOK keys, billing/rate-limit errors, the failed-run debugging playbook.
- [studio-setup-and-human-handoff.md](references/studio-setup-and-human-handoff.md) — what only a human can do in the Studio, and how to ask.
