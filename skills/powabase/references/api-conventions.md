# API conventions

Powabase exposes several HTTP surfaces — agentic `/api/*`, PostgREST `/rest/v1/*`,
GoTrue `/auth/v1/*`, Storage `/storage/v1/*`, Realtime `/realtime/v1/*`. The BaaS
ones are upstream Supabase services, so conventions differ slightly across them.
Learn these once and every endpoint reads easier.

## 1. Headers

Two on every authenticated request: `apikey` and `Authorization: Bearer` (see
[connection-and-auth.md](connection-and-auth.md)). Realtime WS uses `?apikey=`;
the workflow webhook trigger uses only the webhook secret.

## 2. Update verbs: PUT vs PATCH (per resource)

The `/api/*` surface is **inconsistent** here — match the docs per endpoint, don't
derive it.

| Resource | Update verb |
| --- | --- |
| `/api/agents/{id}` | **PATCH** |
| `/api/agents/{id}/tools/{assignment_id}` | **PATCH** |
| `/api/agents/{id}/mcp-servers/{server_id}` | **PUT** |
| `/api/tools/{id}` | **PUT** |
| `/api/orchestrations/{id}` and `/entities/{eid}` | **PUT** |
| `/api/sources/{id}` | **PATCH** |
| `/api/workflows/{id}` | **PATCH** |
| `/api/ai-provider-keys` | POST (single upsert) / PUT (batch) |

In practice the PUT endpoints here also behave as partial updates. PostgREST uses
PATCH for partial updates (PUT only with `Prefer: resolution=merge-duplicates`,
i.e. upsert). GoTrue uses PUT on `/user` and `/admin/users/{id}` (both partial).
Storage uses PUT to overwrite an object.

## 3. Resource naming traps

Most resources are plural, hyphenated nouns: `/api/agents/{id}`,
`/api/knowledge-bases/{id}`, `/api/ai-provider-keys`. But a few paths use
**snake_case** and are case/character-sensitive:

- `/api/ai-provider-keys/platform_supported` — **underscore** (most-missed one).
- `/api/config/kb-defaults` — hyphen.

Match the docs literally.

## 4. Error envelopes (they differ per service)

| Surface | Shape |
| --- | --- |
| Agentic `/api/*` | `{"error": "<message>"}`, sometimes `+ "code"` / `"error_code"` |
| PostgREST | `{"code": "<SQLSTATE>", "message", "details", "hint"}` |
| GoTrue | `{"error": "<code>", "error_description": "..."}` or `{"msg": "..."}` |
| Storage | `{"statusCode": "<n>", "error": "<name>", "message": "..."}` |

Examples:

```json
{ "error": "Webhook not found", "error_code": "WORKFLOW_NOT_FOUND" }
{ "code": "23505", "message": "duplicate key value violates unique constraint", "details": "Key (email)=(a@b.com) already exists.", "hint": null }
{ "error": "invalid_grant", "error_description": "Invalid login credentials" }
{ "statusCode": "413", "error": "Payload too large", "message": "..." }
```

A unified handler should branch on `response.status` first, then read
`.error || .message || .error_description || .msg` in that order:

```typescript
type NormalizedError = { status: number; code: string; message: string; details?: unknown };
async function normalizeError(res: Response): Promise<NormalizedError> {
  const body = await res.json().catch(() => ({} as any));
  return {
    status: res.status,
    code: body.error_code || body.code || body.error || String(res.status),
    message: body.message || body.error_description || body.error || body.msg || res.statusText,
    details: body,
  };
}
```

> **Streaming endpoints fail at HTTP 200.** `/run/stream` and `/execute/stream`
> return `200` and surface failures as an SSE `error` event (e.g.
> `data: {"type":"error", ...}`), not an HTTP error status. Check the event stream,
> not just the status code.

## 5. Pagination

- **Agentic `/api/*`** — query params `?limit=&offset=`; responses include `total`.
  Defaults vary (often `limit=50`, cap `200`).
  ```
  GET /api/agents?limit=20&offset=0  →  { "agents": [...], "total": 47, "limit": 20, "offset": 0 }
  ```
- **PostgREST** — `Range: 0-19` request header; total in `Content-Range: 0-19/247`
  (add `Prefer: count=exact`).

For high-volume agentic lists, prefer the explicit `limit`/`offset`.

## 6. List response shapes are not uniform

Most agentic list endpoints wrap: `{ "<resource>": [...], "total", "limit", "offset" }`.
Some use `{ "items": [...], "total", ... }` (e.g. KB sources), and a few return a
bare array. **When unsure, log the response and read its shape** — and trust the
live docs over memory.

## 7. No idempotency keys

The `/api/*` surface does **not** honor an `Idempotency-Key` header. Retrying a
`POST /api/agents/{id}/run/stream` after a timeout creates a **second** run. Build
retries to tolerate that: wait longer between attempts, or check session/run state
before retrying. (Billing charges *are* internally idempotent — see
[billing-limits-and-debugging.md](billing-limits-and-debugging.md) — but the API
itself doesn't dedupe your retries.) PostgREST also ignores it; for idempotent
inserts use unique constraints + upsert (`Prefer: resolution=merge-duplicates`).

## 8. Useful behavior-changing headers (PostgREST/Storage)

| Header | Where | Effect |
| --- | --- | --- |
| `Prefer: return=representation` | PostgREST writes | Return the inserted/updated rows |
| `Prefer: count=exact` | PostgREST reads | Include total in `Content-Range` |
| `Prefer: resolution=merge-duplicates` | PostgREST POST | Upsert (with `on_conflict=`) |
| `Accept-Profile: <schema>` | PostgREST reads | Target a non-`public` schema (e.g. `ai`) |
| `Content-Profile: <schema>` | PostgREST writes | Same, for writes |
| `Accept: application/vnd.pgrst.object+json` | PostgREST reads | Return one object; error unless exactly one row |
| `x-upsert: true` | Storage upload | Overwrite an existing object |
| `Range: 0-19` | PostgREST reads | Offset slice |

## 9. Path versioning

BaaS surfaces are versioned (`/auth/v1`, `/rest/v1`, `/storage/v1`,
`/realtime/v1`). The agentic `/api/*` surface is **not** versioned in the path
today; if it ever needs to be, expect `/api/v2/*` alongside. A tiny URL-builder
constant in your client futureproofs this.

## 10. Retry policy

Retry **only** transient statuses: `503` (e.g. billing service unreachable) and
`429` (rate limit — today only on workflow `/execute`, 20/min/user). Do **not**
retry `402` (out of credits), other `4xx`, or `401`.

```typescript
async function withRetry(fn: () => Promise<Response>): Promise<Response> {
  const delays = [3000, 6000, 12000, 30000, 30000, 30000]; // ms
  for (let i = 0; i <= delays.length; i++) {
    const res = await fn();
    if (res.ok) return res;
    if ((res.status === 503 || res.status === 429) && i < delays.length) {
      await new Promise((r) => setTimeout(r, delays[i] * (1 + Math.random() * 0.25)));
      continue;
    }
    return res;
  }
  throw new Error("unreachable");
}
```
