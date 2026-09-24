# Studio setup, human handoff & glossary

Some setup can only happen in the Studio UI (or only a human should do it). When you
hit one, **stop and ask the user** with a precise instruction — don't guess secrets
or invent navigation. This page lists those handoff points, what you *can* still do
over the API, how to phrase the ask, and the confusable-terms glossary.

## 1. Things only a human can do in the Studio

| Need | Send the user to | Notes |
| --- | --- | --- |
| Project URL, Anon / Service Role keys, JWT Secret, Database URL, connection strings | **Connect modal** (project header → **Connect**, or `?showConnect=true`) | The only place these are surfaced. |
| BYOK model provider keys; see "AI-on-us" vs "BYOK required" status | **Settings → LLM Provider Keys** | Also doable via `POST/PUT /api/ai-provider-keys`. |
| `web_search` key (`EXA_API_KEY`), `web_scrape` key (`FIRECRAWL_API_KEY`) | **Settings → Tools** | Also doable via `PUT /api/settings`. |
| Aggregate observability (request counts, error rates, activity) | **Project overview** | Studio-only (control-plane data). |
| Extraction queue (pending/running/failed) | **Extraction queue** view | Studio-only. |
| Per-service health (Postgres, GoTrue, Storage, ...) | **Health checks** view | Studio-only; or `GET /api/health` for a basic ping. |
| Database **restore** / point-in-time recovery | **Email support** with project ref + timestamp + scope | No self-service restore or PITR. |
| Top up / upgrade after a `402` | Account billing (pricing page) | Credits refill 1st of each UTC month. |

## 2. What you CAN do over the API (don't over-hand-off)

Provider keys (`/api/ai-provider-keys`), settings incl. the Exa/Firecrawl keys
(`/api/settings`), reading run/execution logs, the health ping (`/api/health`), and
your own `pg_dump` backups via the Database URL are all programmatic. Only reach for
the human when a value is **behind the Studio** (credentials) or an action is
**not exposed** (restore).

## 3. Settings via the API

`GET /api/settings` returns every setting with its default, current override,
category, and type (secrets are masked). `PUT /api/settings` bulk-updates:

```json
PUT /api/settings   { "settings": { "EXA_API_KEY": "exa-...", "AGENT_DEFAULT_MODEL": "gpt-4o" } }
```

Values are strings (stringify numbers/bools). Sending a secret's mask placeholder
back is a no-op. `DELETE /api/settings/{key}` reverts to default;
`POST /api/settings/reset-category` resets a whole category (`tools`, `agents`,
`copilot`, `knowledge-indexing`, `knowledge-retrieval`, `compaction`, `sources`).
Notable keys: `EXA_API_KEY`, `FIRECRAWL_API_KEY`, `VISION_MODEL` (default
`gpt-4.1-mini`), `AGENT_DEFAULT_MODEL` (default `gpt-5.2`), `KB_DEFAULT_TOP_K`,
`RERANKER_DEFAULT_MODEL`, `copilot_model` (default `claude-opus-4-6`).
(`code_execute`'s sandbox is a platform-level env var, not a project setting —
operator territory.) These are a curated subset — `GET /api/settings` returns the
**full** registry (90+ keys across `agents`/`tools`/`knowledge-indexing`/
`knowledge-retrieval`/`copilot`/`compaction`/`sources`) with each key's current
value and default; treat it as authoritative rather than hardcoding.

## 4. How to phrase the ask

Be specific and unblock-able. Good asks:

- "I need your project credentials to continue. In the Studio, click **Connect** in
  the project header and paste me the **Project URL** and the **Service Role
  (Secret) Key**." *(Remind them: server-side use only; don't paste it anywhere
  public.)*
- "The `web_search` tool needs an Exa key. Either set `EXA_API_KEY` in **Settings →
  Tools**, or give me the key and I'll set it via `PUT /api/settings`."
- "Your agent's model has no provider key. In **Settings → LLM Provider Keys**, add
  a key for `{provider}` (or confirm AI-on-us is active for it)."
- "This needs a database restore, which is support-only. Email Powabase support with
  your project ref and the target timestamp."

Confirm before doing anything destructive or hard to reverse (deleting sources/KBs/
agents, overwriting a graph, rotating a key).

## 5. Powabase MCP server

- **URL:** `https://mcp.powabase.ai/mcp` — streamable HTTP. Auth is OAuth: the
  client opens a sign-in with the user's Powabase account; no API key to paste.
- **Claude Code:** `claude mcp add --transport http powabase https://mcp.powabase.ai/mcp`.
  Other clients: add it as a remote/HTTP MCP server with that URL.
- **Read-only:** `https://mcp.powabase.ai/mcp?read_only=true` registers only the
  read-only tools (no `execute_sql`, no create/update/delete).
- **Tools (~60):** projects (`list_organizations`, `list_projects`, `get_project`,
  `pause_project`, `resume_project`, URL + publishable keys, models) — **no
  create/delete project**, so new projects are made in Studio; database
  (`execute_sql` at service-role privilege, list schemas/tables, describe table);
  auth users + auth config; storage buckets/objects; knowledge bases (incl.
  search), sources (import, re-extract, delete); agents (CRUD, run, approve);
  orchestrations; workflows (CRUD, deploy, run, executions); sessions/runs;
  project settings; custom tools; `search_docs`. Most take a `project_ref`; a
  `Not authorized for that project` result means call `list_projects`.

**When to use which:** if the server is connected in this session, prefer it for
discovery and interactive work (inspecting a project's tables, one-off SQL, trying a
KB search or agent run, docs lookup). Build the app itself on the REST API
(`/api/*`, `/rest/v1/*`, `/auth/v1/*`, …) from these references — MCP is a tool for
the assistant, not a runtime SDK. If it isn't connected, don't assume its tools
exist; use raw HTTP and verify against `https://docs.powabase.ai`.

*(Unrelated: agents can connect to **external** MCP servers as tools — that's a
runtime agent feature, not a Powabase MCP server for your coding assistant. See
[agents-and-tools.md](agents-and-tools.md).)*

## 6. Glossary — confusable terms

Powabase reuses several words. Disambiguate before acting:

- **Webhook** — *agentic, inbound:* external systems triggering a workflow at
  `POST /api/webhooks/{id}` (auth = webhook secret). *Database, outbound:* Postgres
  rows changing → Postgres calling out via `pg_net`. Different mechanisms.
- **Session** — *agent session* (`ai.agent_sessions`): a multi-turn conversation.
  *Auth session* (GoTrue): a signed-in user's access+refresh token state. Unrelated.
- **Run / execution** — *agent run* (`ai.agent_runs`, one agent invocation);
  *workflow execution* (`ai.workflow_executions`, one graph run, may contain agent
  runs); *orchestration run* (one coordination cycle).
- **Hook** — *agent hook* (lifecycle: `PreToolUse`, approval, ...); *database trigger*
  (Postgres `CREATE TRIGGER`); *GoTrue hook* (auth extension point; not exposed
  per-project). Different surfaces.
- **Tool** — *builtin* (the eight by name); *custom* (your HTTP endpoint); *MCP*
  (discovered from an MCP server). Dispatch keys on the assignment's `tool_type`,
  not a Tool row's free-form `type`.
- **Keys** — *Anon (Publishable)* vs *Service Role (Secret)* vs short-lived *user
  access token* vs opaque *refresh token* vs *Database URL*. See
  [connection-and-auth.md](connection-and-auth.md).
- **Strategy** — *indexing strategy* (`chunk_embed`/`page_index`/...) vs *retrieval
  method* (`vector_search`/`hybrid`/...) vs *orchestration strategy*
  (`supervisor`/`sequential`/`parallel`).
- **"config"** — KB `indexing_config`/`retrieval_config`; a tool's `config`
  (endpoint/method/headers); a workflow block's `config` (block params). Context
  decides which.

## 7. Migrating from Supabase (quick deltas)

If the user is porting from Supabase: the BaaS surface (PostgREST, GoTrue, Storage,
Realtime, RLS) transfers by swapping the URL to `https://{ref}.p.powabase.ai` with
the Anon key. Key changes: GraphQL is `POST /rest/v1/rpc/graphql` (no `/graphql/v1`);
the Database URL username/db are both `<ref>` (not `postgres`), pooler is PgBouncer
transaction-mode; **no Edge Functions** (use workflows + `code` blocks, DB webhooks,
or your own serverless); **no `pg_cron`** (cron-triggered workflow); free-tier is a
hard `402` not soft limits; the entire `/api/*` agentic surface is Powabase-only.
The `ai.*` schema is new — audit its RLS before exposing it to clients.
