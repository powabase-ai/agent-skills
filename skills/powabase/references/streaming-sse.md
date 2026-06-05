# Streaming & Server-Sent Events

Agent, orchestration, and workflow runs stream over **SSE**: a `text/event-stream`
where each event is a single line `data: {JSON}\n`, events separated by blank
lines. The same buffering rules apply to all three.

## 1. Agent run events (`/api/agents/{id}/run/stream`)

| Event | Key fields | Meaning |
| --- | --- | --- |
| `start` | `run_id`, `session_id` | Run started — **save `session_id`** for multi-turn |
| `step_started` / `step_completed` | `step` | Reasoning step boundaries |
| `content_delta` | `delta` | Per-token text (forwarded only; assembled text persists on `complete`) |
| `chunk` | `content` | Final assembled text (sync-style/no-tool generation) |
| `tool_call` | `tool_name`, `arguments` | Agent is calling a tool |
| `tool_result` | `tool_name`, `result` | Tool finished |
| `reasoning_delta` | `delta` | Per-token reasoning (only if `reasoning_requested`; forwarded only) |
| `reasoning` | `text` | Persisted reasoning segment |
| `reasoning_summary` | `summary` | Final summarized reasoning at end of a step |
| `approval_requested` | `tool_name`, `tool_input` | Paused for approval (see agents reference) |
| `context_handler_created` | `context_handler_id` | A retrieval ran mid-run (citation panel) |
| `complete` | `run_id`, `content`, `usage` | Run finished |
| `error` | `message`, `code?` | Error (`code` e.g. `rate_limited`, `context_length_exceeded`) |

**Persisted vs forwarded-only:** `content_delta` and `reasoning_delta` are
per-token deltas that are **not** persisted individually — replaying a run via
`GET /api/agents/runs/{run_id}` shows the assembled `content`, not the deltas.
Everything else is persisted.

## 2. Orchestration events

Agent events **plus** delegation: `orchestration_started`, `delegation_started` /
`delegation_completed` (supervisor; payload field `agent` = the entity name, plus
usage), `sequential_step` (pipeline progress). Use these to show which agent is
currently working.

## 3. Workflow events (`/api/workflows/{id}/execute/stream`)

| Event | Key fields | When |
| --- | --- | --- |
| `workflow_start` | `execution_id` | Execution began |
| `block_started` | `block_id`, `block_type` | A block is about to run |
| `block_chunk` | `block_id`, `delta` | A streaming block produced output |
| `content_delta` / `reasoning_delta` | `block_id`, `delta` | Forwarded from an agent/orchestration block — render tokens live |
| `block_output` | `block_id`, `output` | A block finished (downstream may reference it) |
| `block_completed` | `block_id` | Block fully done |
| `block_error` | `block_id`, `error` | A block failed (workflow short-circuits unless next block is an error handler) |
| `workflow_complete` | `execution_id`, `result` | Whole execution finished |
| `workflow_error` | `execution_id`, `error` | Top-level failure |

Block-level events drive a step indicator; the forwarded `content_delta` lets you
stream an inner agent's tokens in the same UI.

## 4. Keepalive & buffering (don't skip this)

- If no event fires for **30 s**, the server sends `: keepalive\n\n` (an SSE
  comment). **Drop any line starting with `:`.**
- A single network read may contain **half an event or several events**. Always
  **buffer and split on `\n`**, processing only complete lines.

## 5. Robust parsers

**Python** (`requests`, `iter_lines` handles line splitting):

```python
import json, requests

with requests.post(f"{BASE_URL}/api/agents/{agent_id}/run/stream",
                   headers=headers, json={"message": "Hi"}, stream=True) as resp:
    session_id = None
    for raw in resp.iter_lines():
        if not raw:
            continue
        line = raw.decode("utf-8")
        if line.startswith(":"):           # keepalive comment
            continue
        if not line.startswith("data: "):
            continue
        event = json.loads(line[6:])
        kind = event.get("event")
        if kind == "start":
            session_id = event["session_id"]
        elif kind in ("content_delta",):
            print(event["delta"], end="", flush=True)
        elif kind == "chunk":
            print(event["content"], end="", flush=True)
        elif kind == "tool_call":
            print(f"\n[calling {event['tool_name']}]")
        elif kind == "error":
            print(f"\nerror: {event['message']}")
        elif kind == "complete":
            print("\n[done]")
```

**TypeScript** (`fetch` — you must buffer manually):

```typescript
const resp = await fetch(`${BASE_URL}/api/agents/${agentId}/run/stream`, {
  method: "POST", headers, body: JSON.stringify({ message: "Hi" }),
});
const reader = resp.body!.getReader();
const decoder = new TextDecoder();
let buffer = "";
let sessionId: string | null = null;

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";               // keep the partial last line
  for (const line of lines) {
    if (line.startsWith(":") || !line.startsWith("data: ")) continue;
    const event = JSON.parse(line.slice(6));
    switch (event.event) {
      case "start": sessionId = event.session_id; break;
      case "content_delta": process.stdout.write(event.delta); break;
      case "chunk": process.stdout.write(event.content); break;
      case "tool_call": console.log(`\n[calling ${event.tool_name}]`); break;
      case "complete": console.log("\n[done]"); break;
    }
  }
}
```

**cURL** (raw inspection): add `-N` to disable buffering —
`curl -N -X POST "$BASE_URL/api/agents/$ID/run/stream" -H "apikey: $K" -H "Authorization: Bearer $K" -H "Content-Type: application/json" -d '{"message":"Hi"}'`.

## 6. Multi-turn

Capture `session_id` from `start`, then send it on the next run to continue the
conversation. There is no create-session endpoint — the first run mints it. See
[agents-and-tools.md](agents-and-tools.md).

## 7. Retry caution

Streaming runs are **not idempotent** — retrying after a timeout starts a *second*
run (and bills again). Prefer checking session/run state over blind retries; see
[api-conventions.md](api-conventions.md).
