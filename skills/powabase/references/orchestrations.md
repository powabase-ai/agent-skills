# Multi-agent orchestrations

An **orchestration** groups several agents (**entities**) and runs them with a
coordination **strategy**. Unlike a workflow (fixed path), the coordinator decides
at runtime what happens. All paths under `{BASE_URL}` with two-header auth.

## 1. Strategies (`strategy`)

| Strategy | Pattern | How it works | Best for |
| --- | --- | --- | --- |
| `supervisor` | Coordinator delegates | A coordinator agent (auto-prompted from entity role descriptions) gets a `delegate_to_{name}` tool per entity, reasons which to call, and synthesizes results | Multi-domain routing, dynamic decomposition |
| `sequential` | Pipeline | Entities run in `position` order; each gets the previous output. **Any failure fails the whole run.** | extract → analyze → summarize → format |
| `parallel` | Fan-out + merge | All entities run concurrently on the same input; a merge agent (`gpt-4.1-mini` by default) combines them. **Any failure fails the whole run.** | Independent perspectives in parallel |

**Limits:** coordinator ReAct loop up to **25** steps; each entity up to **10**
steps (override `max_steps` in the entity `config`); **max delegation depth 3**.
Cancelling the orchestration cancels all active entity runs.

## 2. Endpoints (update verb is **PUT**)

| Method | Path | Purpose |
| --- | --- | --- |
| GET / POST | `/api/orchestrations` | List / create |
| GET / **PUT** / DELETE | `/api/orchestrations/{id}` | Get (with entities) / update / delete |
| POST / GET | `/api/orchestrations/{id}/entities` | Add / list entities |
| **PUT** / DELETE | `/api/orchestrations/{id}/entities/{eid}` | Update / remove an entity |
| POST | `/api/orchestrations/{id}/run/stream` | Run (streaming SSE; includes delegation events) |
| GET | `/api/orchestrations/runs/{run_id}` | Get a completed run's result |
| POST / GET / DELETE | `/api/orchestrations/{id}/hooks[...]` | Lifecycle hooks |
| GET | `/api/orchestrations/{id}/sessions[...]` | Sessions / messages |

> Only **`/run/stream`** invokes an orchestration — there is no separate
> non-streaming run endpoint. Fetch the result afterward via
> `GET /api/orchestrations/runs/{run_id}`.

## 3. Create + add entities

```json
POST /api/orchestrations
{ "name": "Customer Support Team", "strategy": "supervisor",
  "orchestrator_config": { "additional_instructions": "Route billing to Billing, technical to Tech Support." } }
```

```json
POST /api/orchestrations/{id}/entities
{ "entity_type": "agent", "entity_ref_id": "<agent-uuid>", "role_description": "Handles billing, invoices, payments" }
```

| Field | Notes |
| --- | --- |
| `entity_type` | Use `"agent"`. **Only `"agent"` actually runs** — other values are stored but silently skipped. |
| `entity_ref_id` | UUID of the agent to add. |
| `role_description` | Free text the coordinator uses to delegate. Make roles **specific and non-overlapping** (the supervisor's prompt is built from these). |
| `config` | Per-entity overrides (e.g. `max_steps`), default `{}`. |
| `position` | Sort order (sequential uses it), default `0`. |

> **Canonical fields are `entity_type` / `entity_ref_id` / `role_description`.**
> Older docs/examples show legacy `agent_id` / `role` — those are outdated; use the
> canonical set. On update (`PUT .../entities/{eid}`) only `role_description`,
> `config`, `position` are writable; `entity_type`/`entity_ref_id` are immutable.

## 4. Streaming events

Extends the agent SSE model with delegation events: `start` (→ `run_id`,
`session_id`), `orchestration_started`, `delegation_started` /
`delegation_completed` (supervisor; payload field **`agent`** = the entity name,
plus the child run ID / usage), `sequential_step` (sequential), entity
`tool_call`/`tool_result`, `chunk` (final text, field `content`), `complete`
(`content`, `usage`, `steps`), `error`. Parser details:
[streaming-sse.md](streaming-sse.md).

## 5. Gotchas

- **Run with zero entities → 400.** Add at least one entity first.
- **Hooks do NOT fire during an orchestration run — at any level.** The
  `/api/orchestrations/{id}/hooks` endpoints store hooks, but the orchestration
  engine doesn't execute them yet (no orchestration-level approval gate or
  `approval_requested` event). **A member agent's own hooks also stop firing once it
  runs inside an orchestration** — the engine calls the agent without its hooks, so an
  approval/policy hook that works standalone silently becomes a no-op here. If you need
  an agent's hooks (e.g. an approval gate), run that agent **directly** (§7/§8 of
  [agents-and-tools.md](agents-and-tools.md)), not as an orchestration entity.
  Tracked: powabase-ai/agentic-monorepo#570.
- **Sequential & parallel fail-fast** — one entity error fails the whole run.
- **Orchestrations update with `PUT`; workflows update with `PATCH`** — easy to mix.
- **Supervisor quality hinges on role descriptions** — vague/overlapping roles make
  the coordinator misroute. Keep depth ≤ 3 in mind for nested delegation.
- Use an orchestration as a single block inside a workflow via the `orchestration`
  block type — see [workflows-and-copilot.md](workflows-and-copilot.md).
