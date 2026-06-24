# Billing, provider keys, rate limits & debugging

How Powabase charges, how to bring your own model keys, what's rate-limited, and
the playbook for a failed run/execution.

## 1. AI provider keys (BYOK)

Per-project, encrypted model-provider credentials. Supported providers (four):
`openai`, `anthropic`, `google`, `openrouter`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/ai-provider-keys` | List configured keys (returns `masked_key`, `is_valid`) |
| POST | `/api/ai-provider-keys` | Upsert one key (`{provider, api_key}`) |
| PUT | `/api/ai-provider-keys` | Batch upsert (`{openai: "...", anthropic: "..."}`) |
| DELETE | `/api/ai-provider-keys/{provider}` | Remove a key |
| POST | `/api/ai-provider-keys/validate` | Validate without storing |
| GET | `/api/ai-provider-keys/platform_supported` | Which providers have platform ("AI-on-us") keys |

> Path uses an **underscore**: `platform_supported` (hyphenating it 404s).

**BYOK vs AI-on-us:** "AI-on-us" means the platform pays the provider and bills you
in credits — available for whatever `platform_supported` returns. **BYOK** means you
upsert your own key and pay the provider directly; the platform then **skips the LLM
token charge** for user-facing calls on that provider (compute/indexing/retrieval
credits still apply). At run time, resolution is BYOK key first, else AI-on-us if
the provider is platform-supported. Set keys in **Studio → Settings → LLM Provider
Keys** (or via the API above).

**`provider_key_decrypt_failed`** — a stored BYOK key can't be decrypted. **Fix:
re-upsert it** via `POST /api/ai-provider-keys`; don't retry the original call until
then. (Docs label the status both 400 and 402 in different places — verify live.)

## 2. Billing model

Powabase bills in **credits**, charged per billable op (agent runs and each tool
call, orchestration/workflow runs and per-block, indexing per 1K tokens, extraction
per page, web search/scrape, enrichment, KB search). Free tier has a **hard cap**;
credits refill on the first of each UTC month. Most ops check your **full** balance
before dispatch (→ 402), but source extraction and KB indexing only check that the
balance is positive and charge on completion — so a long indexing job can finish as
you run out while the *next* op is blocked. With BYOK, user-facing LLM tokens aren't
charged, but platform-internal LLM calls (indexing, enrichment, query-rewrite,
rerank) always are. Charges carry internal idempotency
keys, so a retried request with the same key won't double-bill (but the API doesn't
honor your `Idempotency-Key` header — see [api-conventions.md](api-conventions.md)).

**Web search tiers cost differently.** `web_search` bills by `search_type`: the
standard modes (`auto` / `neural` / `keyword`) at the base `web_search` rate, but Exa's
agentic **`deep`** and **`deep-reasoning`** modes bill pricier dedicated actions:

| `search_type` | Billing action | Base cost / call |
| --- | --- | --- |
| `auto` / `neural` / `keyword` | `web_search` | $0.04 |
| `deep` | `web_search_deep` | $0.075 |
| `deep-reasoning` | `web_search_deep_reasoning` | $0.10 |

Base cost is **before** the plan per-call multiplier (Free 100% · Self-serve 75% ·
Scale 50%). A timeout or 5xx from Exa is **not** billed (platform-error path), though the
balance check still gates dispatch. Pin the tier with the tool's `config_override` and
billing follows the forced type — see [agents-and-tools.md](agents-and-tools.md) §4–5.

**`402 insufficient_credits`** — **do not retry.** Surface the renewal date.

```json
{ "error": "insufficient_credits", "balance": 1234, "estimated_cost": 5000, "renews_at": "2026-07-01T00:00:00+00:00" }
```

**`503 billing service unreachable`** — transient (the balance check is fail-closed;
a 30-second cache fronts it). **Retry with exponential backoff** (start 5 s, double
up to ~1 min). Not a client error.

## 3. Rate limits

The **only** quantitative limit on the AI surface today:

| Endpoint | Limit | Response |
| --- | --- | --- |
| `POST /api/workflows/{id}/execute` (and `/execute/stream`) | **20 / minute / user** | `429` |

Keyed on the JWT `sub`; **unauthenticated callers (Service Role with no user) share
one `"anonymous"` budget** — so a backend firing workflows for many users should
either pass each end user's access token (each gets their own 20/min) or queue with
a token bucket. Agent runs, orchestration runs, and KB search are **not**
rate-limited (credit-metered). GoTrue has its own per-endpoint limits (see
[baas-auth-storage-realtime.md](baas-auth-storage-realtime.md)).

```json
{ "error": "Rate limit exceeded. Max 20 executions per minute." }
```

Back off with jitter (`3s → 6s → 12s → 30s`), don't retry within the same minute.

## 4. Client-side error decision table

| Response | Do |
| --- | --- |
| `402 insufficient_credits` | Surface `renews_at`; don't retry; suggest top-up. |
| `503 billing service unreachable` | Retry with exponential backoff (5 s → ~1 min). |
| `429 rate limit` (workflow execute) | Back off with jitter; pace to ≤20/min. |
| `provider_key_decrypt_failed` | Re-upsert the BYOK key; then retry. |
| `401` | Check both headers (`apikey` + `Authorization`). Don't retry blindly. |

## 5. Failed-run debugging playbook

When an agent run, workflow execution, or orchestration ends `failed`, the signal
is spread across endpoints. Check in this order:

1. **Get the run record** — `GET /api/agents/runs/{run_id}`. The `error` field is
   the highest-signal start; it also returns `events`, `usage`, `tool_calls`,
   `reasoning_steps`, `retrieved_context`, `input/output_messages`.
2. **Scan `events`** for the first failure-shaped entry (`type: "error"` /
   `"tool_error"`). Everything after it is usually symptom, not cause.
3. **Retrieval issue?** — `GET /api/sessions/{session_id}/runs/{run_id}/retrieved-context`.
   If the answer was "I don't know," empty/wrong context here is the root cause.
4. **Workflow run?** — `GET /api/workflows/{id}/executions/{execution_id}/logs` for
   per-block logs (a failing `general_api` body, `code` stderr).
5. **Rate limit?** — 22nd+ workflow execute in a minute → `429`; pace your calls.
6. **Still stuck?** — the Studio run-detail view renders all of the above on one
   page; for suspected platform bugs, file a support ticket with the `run_id`.

### Common `error` / `events` symptoms → cause

| Symptom | Cause / fix |
| --- | --- |
| `insufficient_credits`, `balance: 0` | Free-tier cap (402). Top up; don't retry. |
| `billing service unreachable` | 503, transient. Retry with backoff. |
| `Missing API Key` / `provider_key_decrypt_failed` | No BYOK or platform key for the model's provider. Set one (Settings → LLM Provider Keys) or re-upsert. |
| `Exa API key not configured` | `web_search` without `EXA_API_KEY`. Set it (Settings → Tools). |
| `Code sandbox is not configured` | `code_execute` without the platform sandbox (`CODE_SANDBOX_URL`). Operator setup. |
| `Doom loop detected` | Agent called the same tool with identical args 3× — usually it's misreading a tool result. Inspect that tool's `result`. |
| `Output truncated` after 3 retries | Model hit `max_tokens` repeatedly. Raise it or shorten the system prompt. |
| Empty `output_messages`, `status: completed` | Often a multimodal context sent to a non-multimodal model. Check model capabilities. |

## 6. Observability surface

There's one public health endpoint, **`GET /api/health`** (no auth, don't poll
faster than every 30 s). There is **no** Prometheus/`/metrics` endpoint or log-tail
API on your project URL — aggregate views (request counts, extraction queue,
service health) live in the **Studio**. For programmatic "telemetry," query `ai.*`
(e.g. `agent_runs`) via PostgREST. Platform-wide incidents: `status.powabase.ai`.

## 7. Backups

Automated daily `pg_dump` of the whole database, stored off-cluster. **No
self-service restore** and **no point-in-time recovery** — to restore, **email
support** with your project ref + target timestamp + scope. Take your own snapshots
via the Database URL (`pg_dump ... | gzip`) and replicate Storage files separately
(the DB dump doesn't include object bytes). See
[studio-setup-and-human-handoff.md](studio-setup-and-human-handoff.md).
