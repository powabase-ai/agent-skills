# BaaS: Auth, Storage & Realtime

The upstream Supabase services — GoTrue (auth), Storage, Realtime — shipped as part
of every Powabase project. Largely Supabase-compatible; the differences and
footguns are called out.

---

## Auth (GoTrue) — `/auth/v1/*`

Header sets: unauthenticated calls (signup/signin/recover/OAuth) use `apikey: <Anon>`
+ `Authorization: Bearer <Anon>`; authenticated calls (`/user`, `/logout`, MFA) use
`apikey: <Anon>` + `Authorization: Bearer <user access token>`; admin calls
(`/admin/*`) use the **Service Role key** for both.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/auth/v1/signup` | Create user (`email`/`phone` + `password`; `data` → user_metadata) |
| POST | `/auth/v1/token?grant_type=password` | Sign in → tokens |
| POST | `/auth/v1/token?grant_type=refresh_token` | Refresh (single-use refresh token) |
| POST | `/auth/v1/token?grant_type=pkce` | Exchange a PKCE auth code for a session (OAuth / magic-link code flow) |
| POST | `/auth/v1/otp` / `/auth/v1/verify` | Magic link / OTP send & verify |
| POST | `/auth/v1/recover` | Password-reset email |
| GET | `/auth/v1/authorize?provider=...` | Start OAuth (302 to provider) |
| GET / PUT | `/auth/v1/user` | Get / update current user (email/password/`user_metadata`) |
| POST | `/auth/v1/logout` | Invalidate session (`?scope=global\|local\|others`) |
| POST | `/auth/v1/factors[...]` | MFA enroll / challenge / verify |
| GET/POST/PUT/DELETE | `/auth/v1/admin/users[...]` | Admin user management (service role) |

**Tokens:** the **access token** is a JWT, lifetime **1 hour** (`expires_in: 3600`).
Refresh before expiry (refresh tokens are single-use, rotated; a 10-second reuse
window forgives concurrent double-refreshes). The token's `role` claim
(`anon`/`authenticated`/`service_role`) sets the Postgres role; `sub` is the user
UUID (→ `auth.uid()`).

> **`app_metadata` vs `user_metadata`.** `user_metadata` is **user-editable**
> (via `PUT /auth/v1/user`) — never use it for authorization. Put roles/flags in
> `app_metadata`, which only an admin can set (`PUT /auth/v1/admin/users/{id}` with
> the Service Role key). RLS reads them via `auth.jwt()`.

**Roles (four):** `anon` (Anon key, respects RLS), `authenticated` (signed-in user,
respects RLS), `service_role` (Service Role key, **BYPASSRLS**), and `supabase_admin`
(the direct-Postgres owner via the Database URL — **BYPASSRLS**, not a GoTrue JWT;
migrations/admin). OAuth supports ~20 providers (`google`, `github`, `apple`,
`azure`, ...).

**Defaults to know (may be operator-tuned):** email auto-confirm may be **on** (no
verification email); SMTP may be unconfigured (recovery/magic-link silently no-op);
password min length 6, no complexity; no anonymous sign-in; per-IP rate limits
(e.g. email sends 30/hour, token refresh 150/5min). GoTrue errors look like
`{"error": "invalid_grant", "error_description": "..."}`.

---

## Storage — `/storage/v1/*`

Headers: `apikey` + `Authorization: Bearer` (Anon key + user token for browser
uploads; Service Role for admin). Metadata lives in `storage.buckets` /
`storage.objects` (queryable via PostgREST for RLS).

**Buckets:** `POST/GET/PUT/DELETE /storage/v1/bucket[/{id}]`. Create body: `id`
(required, lowercase), `public` (default `false`), `file_size_limit`,
`allowed_mime_types`. `POST /storage/v1/bucket/{id}/empty` clears objects.

**Objects:**

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/storage/v1/object/{bucket}/{path}` | Upload (raw bytes). `409 Duplicate` if exists |
| PUT | `/storage/v1/object/{bucket}/{path}` | Overwrite (or POST with `x-upsert: true`) |
| GET | `/storage/v1/object/public/{bucket}/{path}` | **No auth** — public buckets only |
| GET | `/storage/v1/object/authenticated/{bucket}/{path}` | RLS-gated download |
| POST | `/storage/v1/object/list/{bucket}` | List (`{prefix, limit, offset, sortBy, search}`) |
| POST | `/storage/v1/object/copy` · `/move` | Copy / move |
| DELETE | `/storage/v1/object/{bucket}/{path}` | Delete |
| POST | `/storage/v1/object/sign/{bucket}/{path}` | Mint a signed download URL (`expiresIn`, max 7 days) |
| POST | `/storage/v1/object/sign` | Batch-sign many paths (`{paths:[...], expiresIn}`) |
| POST | `/storage/v1/object/upload/sign/{bucket}/{path}` | Mint a signed upload URL |
| GET | `/storage/v1/render/image/{public\|authenticated\|sign}/{bucket}/{path}` | On-the-fly image transform (`?width&height&resize&quality&format`) |

> - **50 MB per-request limit → 413.** For larger files use **TUS resumable
>   uploads** at `/storage/v1/upload/resumable` with a TUS client; keep each chunk
>   under 50 MB.
> - **Public buckets are fully public** — the public URL bypasses RLS and needs no
>   key. Don't put anything sensitive in a public bucket; use a private bucket +
>   signed URLs.
> - **The MIME allowlist is UX, not security** — it checks the client-sent
>   `Content-Type`, not file bytes. Validate contents server-side for untrusted
>   clients.
> - **Storage objects ≠ AI Sources.** `/api/sources/upload` writes to a
>   platform-managed bucket + `ai.sources` (not `storage.objects`). Don't share
>   buckets between the two — the AI surface owns its layout.

Storage errors: `{"statusCode", "error", "message"}`.

---

## Realtime — `/realtime/v1/*`

Three features over one WebSocket (a channel can use any combination):

- **Broadcast** — ephemeral fan-out to subscribers (cursors, typing).
- **Presence** — track/untrack "who's here"; everyone sees the aggregate.
- **Postgres Changes** — INSERT/UPDATE/DELETE events from logical replication,
  filtered by schema/table/event.

**Connect (auth is a query param — WS can't set headers):**

```
wss://{ref}.p.powabase.ai/realtime/v1/websocket?apikey=<Anon | user token | service role>&vsn=1.0.0
```

Frames are Phoenix Channels envelopes: `{ topic, event, payload, ref }`. Join with
`phx_join` (config: `broadcast`, `presence`, `postgres_changes: [{event, schema,
table, filter}]`, `private`). Server replies `phx_reply`. Private channels
(`config: { private: true }`) require a matching SELECT policy on
`realtime.messages`. To **send** a broadcast over the socket the frame `event` is
literally `"broadcast"` and its `payload` nests `{ type: "broadcast", event:
"<your-type>", payload: {...} }` (presence updates use a `presence` frame with
`{ action: "track" | "untrack", ... }`).

> - **`postgres_changes` deliver nothing until you create the publication** — it is
>   **not** set up by default:
>   ```sql
>   CREATE PUBLICATION supabase_realtime FOR TABLE public.orders, public.messages;
>   -- or: CREATE PUBLICATION supabase_realtime FOR ALL TABLES IN SCHEMA public;
>   ```
>   This is the first thing to check when changes don't arrive.
> - **Send a heartbeat every 30 s** or the socket closes (~60 s): frame
>   `{ topic: "phoenix", event: "heartbeat", payload: {}, ref: "..." }`. Most client
>   libraries do this for you.
> - UPDATE/DELETE payloads only include changed columns + PK unless you set
>   `ALTER TABLE ... REPLICA IDENTITY FULL`.
> - `403 TenantNotFound` only happens on self-hosted (Kong not preserving Host) —
>   managed cloud handles it.

**Server-side broadcast (REST, needs Service Role key):**

```
POST /realtime/v1/api/broadcast
{ "messages": [ { "topic": "room:42", "event": "msg", "payload": {...}, "private": false } ] }
```

You can also broadcast from SQL/triggers: `realtime.send(payload, event, topic,
private)` and `realtime.broadcast_changes(...)` — handy for streaming agent events
to clients without polling (see the cookbook on `docs.powabase.ai`).

Realtime delivery is best-effort (no persistence/replay). For guaranteed delivery
or backend pub/sub, use a broker, not Realtime.
