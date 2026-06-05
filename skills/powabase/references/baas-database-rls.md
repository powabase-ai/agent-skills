# BaaS: Database, schemas, RLS & PostgREST

Powabase is a Supabase fork, so the database surface is largely Supabase-compatible
(PostgREST v14-class, RLS, pgvector). This covers the schema layout, the `ai.*`
schema, RLS posture, PostgREST usage, direct Postgres, and extensions.

## 1. Architecture & routing

Each project is fully isolated (own Postgres, Kong gateway, GoTrue, Storage,
Realtime, AI worker). Kong routes by path on the Project URL
`https://{ref}.p.powabase.ai`:

| Prefix | Service |
| --- | --- |
| `/api/*` | Project Service (AI surface) |
| `/rest/v1/*` | PostgREST |
| `/auth/v1/*` | GoTrue |
| `/storage/v1/*` | Storage |
| `/realtime/v1/*` | Realtime |
| Database URL | Postgres via PgBouncer |

## 2. Schemas

| Schema | Owner | Use | Migrate? | PostgREST |
| --- | --- | --- | --- | --- |
| `public` | You | Your app tables | Yes | Yes (default; no profile header) |
| `extensions` | You | Installed extensions | Yes | — |
| `ai` | Platform | Sources, KBs, agents, runs, sessions, workflows (35+ tables) | **No** | Yes (with `Accept-Profile: ai`) |
| `auth` | GoTrue | Users, sessions, identities | **No** | **No** (use `/auth/v1/*`) |
| `storage` | Storage | Bucket/object metadata | **No** | Yes |

PostgREST serves `public`, `ai`, `storage`, `graphql_public`. **Do not migrate or
schema-change `ai`/`auth`/`storage`** — the services assume their invariants and
run their own migrations. New `public` tables have **RLS off by default**.

Useful `ai.*` tables: `agents`, `agent_sessions`, `agent_runs`, `agent_tools`,
`knowledge_bases`, `chunks`, `embeddings`, `sources`, `indexed_sources`,
`orchestrations`, `orchestration_runs`, `workflows`, `workflow_executions`,
`workflow_block_logs`, `tools`, `project_settings`, `ai_provider_keys`. For the
live list, `GET /rest/v1/` with `Accept-Profile: ai`.

### Securing a user-owned `public` table (do this for every user-facing table)

RLS is **off by default**, so a fresh `public` table is fully readable/writable by
anyone with the Anon key until you enable it. The canonical user-scoped pattern —
filter rows by the JWT's user id via `auth.uid()`:

```sql
create table public.documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users,
  title text,
  created_at timestamptz default now()
);
alter table public.documents enable row level security;

-- one policy per action; WITH CHECK guards writes, USING guards reads/updates
create policy "own_select" on public.documents for select to authenticated using (user_id = auth.uid());
create policy "own_insert" on public.documents for insert to authenticated with check (user_id = auth.uid());
create policy "own_modify" on public.documents for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own_delete" on public.documents for delete to authenticated using (user_id = auth.uid());
```

Then end users hit `/rest/v1/documents` from the browser with the **Anon key + their
user JWT** and only see their own rows. Roles: `anon` (no JWT) and `authenticated`
(valid user JWT) are gated by policies; the **Service Role key bypasses RLS
entirely** (server-side only). With RLS enabled and zero policies, a table is
locked to everyone except the service role — a safe default while you write policies.

## 3. Querying `ai.*` via PostgREST

Add the profile header or PostgREST looks in `public` and 404s/returns empty:

```bash
curl "$BASE_URL/rest/v1/agent_runs?limit=10" \
  -H "Accept-Profile: ai" \
  -H "apikey: $API_KEY" -H "Authorization: Bearer $API_KEY"
```

Use `Content-Profile: ai` for writes.

### RLS posture on `ai.*` (security-critical)

Every `ai.*` table has RLS enabled, but the default policies are **project-wide**:

| Caller | Reads | Writes |
| --- | --- | --- |
| Service Role key | Everything | Everything |
| Signed-in user (`authenticated`) | **Everything in the project** | Most config tables |
| Anon key | Nothing | Nothing |

> **Only the session-shaped tables filter by `user_id`:** `agent_sessions`,
> `agent_runs`, `orchestration_sessions`, `orchestration_runs`. Everything else is
> readable by **any** signed-in user — two users in the same project can see each
> other's agents, KBs, and workflows.

To make `ai.*` multi-tenant-safe, do one of: (a) tighten the default policies;
(b) gate `ai.*` behind your own backend; or (c) never expose `ai.*` to end users.
The typed `/api/*` endpoints use the Service Role key and enforce **session**
ownership (a session/run you don't own returns 404), so `ai.*` RLS doesn't govern
them. But that ownership check does **not** sandbox an agent's *tools*: a
`database_query`/`database_write` call runs on the superuser connection with no
per-user filter. So **never expose `/api/agents/{id}/run/stream` to clients with
their own JWTs** — run agents from a trusted backend and inject per-user scope
yourself (§8).

## 4. PostgREST patterns

```
GET    /rest/v1/{table}?select=...&order=...&limit=...&offset=...
GET    /rest/v1/{table}?col=eq.value          # filter
POST   /rest/v1/{table}                        # insert
PATCH  /rest/v1/{table}?id=eq.{id}             # update (filter REQUIRED)
DELETE /rest/v1/{table}?id=eq.{id}             # delete (filter REQUIRED)
POST   /rest/v1/rpc/{function}                 # call a Postgres function
```

Filter operators: `eq, neq, gt, gte, lt, lte, like, ilike, is, in`
(`?id=in.(1,2,3)`). Embeds/joins: `select=*,relation(*)`. Single object:
`Accept: application/vnd.pgrst.object+json`. Upsert: `Prefer:
resolution=merge-duplicates` + `on_conflict=`. See the header table in
[api-conventions.md](api-conventions.md).

> **PATCH/DELETE without a filter affect EVERY row.** Always include a filter.

**GraphQL** is `pg_graphql` via `POST /rest/v1/rpc/graphql` — there is **no
`/graphql/v1`** route (a Supabase-migration gotcha).

There's also a thin authenticated proxy: `GET /api/database/tables`,
`/api/database/tables/{table}`, `.../openapi`, etc. — `public` schema only, no anon
access (handy when you only have a Service Role key).

## 5. Direct Postgres & the pooler

Use the **Database URL** (Connect modal). It connects through PgBouncer in
**transaction mode** as the `supabase_admin`-class role (full ownership,
`BYPASSRLS`).

> - **Username and database are both `<ref>`** (not `postgres`); port `5432`. Copy
>   the URL verbatim — `postgres:postgres@.../postgres` muscle memory is wrong here.
> - **Transaction-mode pooling breaks session state:** prepared statements (disable
>   in your driver — e.g. Prisma `?pgbouncer=true`, `postgres.js` `prepare: false`,
>   psycopg `prepare_threshold=None`), **LISTEN/NOTIFY** (use Realtime instead),
>   bare `SET` (use `SET LOCAL` in a transaction), advisory locks
>   (`pg_advisory_xact_lock`), and temp tables across statements. **There is no
>   external non-pooled endpoint** — un-pooled Postgres is reachable only from
>   inside the project's cluster namespace, so for session-state work wrap it all in
>   one transaction (or contact support); for notifications use Realtime.
> - Pool budget: **20 server connections per project**; size your client pool to
>   ~10 and close clients per request on serverless.
> - The Database URL embeds the password in cleartext — server-side only; rotate via
>   the Studio if it leaks.

## 6. Extensions

Preloaded: `vector` (pgvector, HNSW/IVFFlat; **HNSW max 2000 dims**), `pg_net`
(async HTTP from SQL — DB webhooks), `pgcrypto` (`gen_random_uuid()`), `uuid-ossp`,
`pg_graphql`, `vault`. Install more (e.g. `pg_trgm`, `unaccent`, `citext`,
`postgres_fdw`) as the `supabase_admin` role via the Database URL:

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA extensions;
```

Anon/authenticated/service_role lack `CREATE` — you must use the Database URL.
**`vector` and `pgcrypto` live in `public`** (so `gen_random_uuid()` is
unqualified), while `pg_net`/`uuid-ossp` and anything you install land in
`extensions` — qualify those (`extensions.http_post(...)`) or add `extensions` to
`search_path`. **`pg_cron` is not available** — use a workflow cron trigger instead.

## 7. When to use what

- **Typed `/api/*`** — anything the platform manages: agent/workflow runs, source
  extraction, KB indexing/deletion (these coordinate Celery tasks + cascades; e.g.
  remove a KB source via `DELETE /api/knowledge-bases/{id}/sources/{indexed_source_id}`,
  not direct SQL).
- **PostgREST** — your own `public` tables; read-only `ai.*` analytics (mind RLS +
  `Accept-Profile: ai`).
- **Direct Postgres** — migrations, ORMs, extensions, bulk admin.

## 8. The per-user RAG-context pattern (cookbook)

Because KB search and agent tools run as the service role / DB superuser, enforce
per-user access yourself: enable RLS on `ai.sources`/`ai.chunks`/`ai.indexed_sources`
keyed to ownership in your own `public` table, query `ai.chunks` **from the browser
under the user's JWT** (`Accept-Profile: ai`, Anon key + user token), then pass the
RLS-filtered rows to the agent as `context_items` (which bypasses the agent's own
retrieval). Run the agent itself from your backend with the Service Role key. Full
recipe on `docs.powabase.ai` (BaaS + AI cookbook); see also
[agents-and-tools.md](agents-and-tools.md).
