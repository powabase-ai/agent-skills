# Connection & authentication

Everything you need to make an authenticated request, and where each value comes
from. The shared response/error conventions are in
[api-conventions.md](api-conventions.md).

## 1. The Connect modal (where credentials live)

Every project surfaces its credentials in the Studio's **Connect modal**: open
[app.powabase.ai](https://app.powabase.ai) → your project → **Connect** in the
project header. You can also deep-link by appending `?showConnect=true` to any
project URL.

It has two tabs:

- **API Keys** — Project URL, Anon (Publishable) Key, Service Role (Secret) Key,
  JWT Secret, Database URL.
- **Connection Strings** — ready-to-paste Postgres strings in 9 formats: psql,
  generic URI, Node.js (`pg`), Python (`psycopg2`), Go (`database/sql`), JDBC,
  .NET, PHP, SQLAlchemy.

A coding agent cannot read these for you. **If you don't have the Project URL and
a key, ask the user to open the Connect modal and paste them.** See
[studio-setup-and-human-handoff.md](studio-setup-and-human-handoff.md).

## 2. Keys: what each is for

| Field | Use it for | Client-safe? |
| --- | --- | --- |
| **Project URL** (`https://{ref}.p.powabase.ai`) | `BASE_URL` for `/api/*`, `/rest/v1/*`, `/auth/v1/*`, `/storage/v1/*`, `/realtime/v1/*` | Yes |
| **Anon (Publishable) Key** | Browser/mobile calls to PostgREST & Storage that respect RLS | **Yes** |
| **Service Role (Secret) Key** | Server-side `/api/*` (the AI surface; **required for every route not in the end-user list in §2a**) and any RLS-bypassing PostgREST access | **No — server only** |
| **JWT Secret** | Verifying user-signed JWTs on your own backend | **No — server only** |
| **Database URL** | Direct Postgres: psql, migrations, ORMs, BI tools (password in cleartext) | **No — server only** |

The Service Role key has `BYPASSRLS`. The Anon key respects RLS. A signed-in
**user access token** (from GoTrue) carries the `authenticated` role and also
respects RLS — use it in `Authorization` for per-user browser calls to
PostgREST/Storage. On `/api/*` (powabase-ai 0.12.0+) a user token works **only**
on the conversation routes in §2a; everywhere else it returns `403`.

### 2a. Which key for which `/api/*` route (powabase-ai 0.12.0+)

**Default: the Service Role key.** An end-user JWT (GoTrue access token) is
accepted on exactly these routes, and every one is scoped to the caller's own
sessions and runs:

| Method | Route |
| --- | --- |
| GET | `/api/agents/{agent_id}/sessions` |
| POST | `/api/agents/{agent_id}/sessions` |
| DELETE | `/api/agents/{agent_id}/sessions/{session_id}` |
| POST | `/api/agents/{agent_id}/run` |
| POST | `/api/agents/{agent_id}/run/stream` |
| GET | `/api/agents/runs/{run_id}` |
| POST | `/api/agents/runs/{run_id}/approve` |
| GET | `/api/sessions/{session_id}` |
| GET | `/api/sessions/{session_id}/messages` |
| GET | `/api/sessions/{session_id}/runs` |
| GET | `/api/sessions/{session_id}/runs/{run_id}/retrieved-context` |
| DELETE | `/api/sessions/{session_id}` |
| GET | `/api/orchestrations/{orch_id}/sessions` |
| GET | `/api/orchestrations/{orch_id}/sessions/{session_id}/messages` |
| POST | `/api/orchestrations/{orch_id}/run/stream` |
| GET | `/api/orchestrations/runs/{run_id}` |

Two more routes take **no** bearer because they authenticate another way:
`POST /api/webhooks/{webhook_id}` (webhook secret) and
`POST /api/internal/docs/search` (docs-search token).

**Everything else under `/api/*` needs the Service Role key; an end-user JWT gets
`403`.** That includes agent/KB/source/workflow/tool/orchestration management,
knowledge-base search, source upload and download, context handlers, workflow
execution, and `/api/database/*`. Call those from your backend.

Rules for end-user calls on the allowlisted routes:

- The token needs a **UUID `sub`** and an **`exp`** claim (GoTrue tokens have both).
- A run can **only continue an existing session of that user's own**, and cannot
  name a new `session_id`. Start one with `POST /api/agents/{id}/sessions`, or omit
  `session_id` on the run. Session ids are strings of at most 255 characters.
- A run **cannot** send `knowledge_bases`, `runtime_knowledge_bases`,
  `context_handler_id`, or by-reference `context_items`. It uses the knowledge
  bases configured on the agent.
- A backend using the Service Role key may set `user_id` in the
  `POST /api/agents/{id}/sessions` body so the session belongs to that end user.
- Agent database and storage tools run as the caller. See
  [agents-and-tools.md](agents-and-tools.md) §4 (builtin tools).

**Migrating from earlier versions:** if your backend forwarded the user's JWT to
KB, source, or other management routes, switch those calls to the Service Role
key. If your client sent `knowledge_bases` (or `runtime_knowledge_bases`) on an
end-user run, configure those KBs on the agent instead, or make the run from your
backend with the Service Role key. Self-hosters must set `SERVICE_ROLE_KEY` on the
project service.

> **Never** expose the Service Role key, JWT Secret, or Database URL to a browser,
> mobile app, or anything outside your control. If one leaks, rotate it from the
> Studio and treat data touched during the window as compromised.

## 3. The two-header pattern

Every authenticated HTTP request needs **both** headers:

```
apikey: <Anon Key | Service Role Key>
Authorization: Bearer <Anon Key | Service Role Key | User Access Token>
Content-Type: application/json        # for POST/PUT/PATCH bodies
```

- `apikey` is the routing credential Kong checks. `Authorization` is what the
  downstream service verifies for role assignment. **They can differ:**
  `apikey: <Anon>` + `Authorization: Bearer <user-access-token>` is the standard
  browser pattern after sign-in.
- **Server-side**, set both to the **Service Role key**. From a browser with a
  signed-in user, `Authorization: Bearer <user token>` is valid **only** on the
  §2a routes.
- **Sending only one header is the #1 cause of 401s.**

```python
import requests
BASE_URL = "{BASE_URL}"   # Project URL
API_KEY  = "{API_KEY}"    # Service Role (Secret) Key
headers = {
    "apikey": API_KEY,
    "Authorization": f"Bearer {API_KEY}",
    "Content-Type": "application/json",
}
```

```typescript
const BASE_URL = "{BASE_URL}";
const API_KEY = "{API_KEY}";
const headers = {
  apikey: API_KEY,
  Authorization: `Bearer ${API_KEY}`,
  "Content-Type": "application/json",
};
```

**Verify the setup** with a cheap idempotent call — an empty array still means
success:

```bash
curl "$BASE_URL/api/agents" -H "apikey: $API_KEY" -H "Authorization: Bearer $API_KEY"
# → 200 { "agents": [...], "total": N, "limit": 50, "offset": 0 }
```

## 4. Two surfaces where the header pattern changes

- **Realtime WebSocket** — browsers can't set headers on the WS upgrade, so auth
  is a **query param**: `wss://{ref}.p.powabase.ai/realtime/v1/websocket?apikey=<KEY>&vsn=1.0.0`.
  (The Realtime REST broadcast endpoint uses normal headers and needs the Service
  Role key.) See [baas-auth-storage-realtime.md](baas-auth-storage-realtime.md).
- **Workflow webhook trigger** (`POST /api/webhooks/{id}`) — **no `apikey`**; auth
  is the webhook secret via `Authorization: Bearer <secret>` **or** `?token=<secret>`.
  Beware the `Bearer ` trailing-space footgun. See
  [workflows-and-copilot.md](workflows-and-copilot.md).

## 5. Direct Postgres

For migrations, ORMs, or any tool speaking the Postgres wire protocol, use the
**Database URL** (or a Connection Strings snippet). Server-side only.

```bash
psql "{POSTGRES_URL}"     # Connect modal → Database URL
```

Gotcha: the username and database are both `<ref>` (not `postgres`), the role you
connect as is `supabase_admin` (full ownership, bypasses RLS), the pooler is
PgBouncer in **transaction mode**, and the port is `5432`. Copy the string
verbatim. Details and pooler caveats: [baas-database-rls.md](baas-database-rls.md).

## 6. User tokens (when calling as an end user)

Use a user token on `/api/*` only for the §2a conversation routes; use it on
PostgREST/Storage for RLS-scoped access.

A signed-in user's **access token** lasts **1 hour**. Refresh it *before* it
expires rather than waiting for a 401 — call
`POST /auth/v1/token?grant_type=refresh_token` (refresh tokens are single-use). A
simple rule: refresh at ~50 minutes elapsed.

```typescript
const REFRESH_BEFORE_MS = 50 * 60 * 1000;
const shouldRefresh = (issuedAtMs: number) => Date.now() - issuedAtMs > REFRESH_BEFORE_MS;
```

Full auth flows (signup, sign-in, OAuth, magic links, admin): [baas-auth-storage-realtime.md](baas-auth-storage-realtime.md).

## 7. SDKs

Powabase ships **no first-party SDKs or CLI** today — raw HTTP is the supported
path. `@supabase/supabase-js` mostly works for the **BaaS** surface (PostgREST,
Auth, Storage, Realtime) if you point it at `https://{ref}.p.powabase.ai` with the
Anon key, with caveats: the agentic `/api/*` surface is **not** in it, and
there's no `/graphql/v1` route (point any GraphQL client at
`POST /rest/v1/rpc/graphql` instead). The `/api/*`
surface is always plain HTTP + the two headers. A thin ~200-line wrapper in your
own codebase (`client.agents.run({...})`) is the common ergonomic pattern.
