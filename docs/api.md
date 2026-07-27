# API reference

All routes return JSON. Errors use a consistent shape:

```json
{ "error": "Human-readable message", "code": "machine_code", "details": {} }
```

| Status | `code`                         | Meaning                                                |
| ------ | ------------------------------ | ------------------------------------------------------ |
| 400    | `bad_request` / `invalid_body` | Malformed request; `details.issues` lists field errors |
| 401    | `unauthorized`                 | Missing or invalid deployment token                    |
| 404    | `not_found`                    | No such resource                                       |
| 429    | `rate_limited`                 | `details.retryAfter` in seconds                        |
| 500    | `internal_error`               | Opaque by design — details stay server-side            |

## Nodes

### `GET /api/nodes`

The catalogue the editor renders from. Zod schemas cannot cross the wire, so each
definition is projected into a serialisable descriptor.

```json
{
  "nodes": [
    {
      "type": "flowforge.llm",
      "label": "LLM",
      "category": "model",
      "inputs": [{ "id": "prompt", "label": "Prompt", "type": "string" }],
      "outputs": [{ "id": "text", "label": "Text", "type": "string" }],
      "configKeys": ["model", "prompt", "temperature"],
      "configUi": { "model": { "widget": "select", "order": 1 } },
      "defaults": { "model": "flowforge/mock", "temperature": 0.7 },
      "capabilities": { "deterministic": false },
      "secrets": []
    }
  ],
  "providers": [{ "name": "mock", "models": ["flowforge/mock"] }],
  "plugins": []
}
```

## Workflows

### `GET /api/workflows` · `POST /api/workflows`

```jsonc
// POST body
{ "name": "Support triage", "description": "…", "templateId": "tpl_rag" } // templateId optional
```

### `GET /api/workflows/:id`

Returns the draft graph plus live validation, version history, and deployments.

### `PATCH /api/workflows/:id`

Saves the draft. Omitted fields are left untouched — sending `{"name": undefined}`
does not clear the name.

```json
{ "name": "New name", "graph": { "id": "…", "name": "…", "nodes": [], "edges": [] } }
```

### `DELETE /api/workflows/:id`

Deletes the workflow, its versions, runs, and deployments.

## Execution

### `POST /api/workflows/:id/run`

```json
{ "input": { "question": "…" }, "version": 2, "stream": true }
```

With `stream: false`, returns `{ runId, trace }`.

With `stream: true` (default), returns `text/event-stream`. Each frame is one
`TraceEvent`; the stream ends with `data: [DONE]`. The run id is also in the
`X-Run-Id` response header.

```
data: {"kind":"run.started","runId":"run_…","at":1730000000000,"input":{…}}
data: {"kind":"node.started","runId":"run_…","nodeId":"retrieve","attempt":1,…}
data: {"kind":"node.partial","runId":"run_…","nodeId":"answer","portId":"text","chunk":"The "}
data: {"kind":"edge.skipped","runId":"run_…","edgeId":"e_retrieve_empty_fallback_input",…}
data: {"kind":"run.finished","runId":"run_…","status":"succeeded","output":{…},"usage":{…}}
data: [DONE]
```

Event kinds: `run.started`, `run.finished`, `node.started`, `node.finished`,
`node.skipped`, `node.retrying`, `node.partial`, `node.log`, `edge.activated`,
`edge.skipped`.

Fold them with `reduceTrace` from `@/core/runtime/events` to reconstruct the same
`RunTrace` the server persists.

Rate limited to 60 runs/minute per client.

## Versions

### `GET /api/workflows/:id/versions`

### `POST /api/workflows/:id/versions`

```jsonc
{ "action": "publish", "changelog": "Added retrieval fallback" }
{ "action": "rollback", "version": 3 }   // copies v3's graph into the draft
```

Publishing freezes the draft and opens the next one.

### `GET /api/workflows/:id/diff?from=1&to=2`

Structural diff. Position-only changes are reported as `moved` and excluded from
the `modified` count and from `identical`.

```json
{
  "diff": {
    "nodes": [
      {
        "nodeId": "answer",
        "kind": "modified",
        "changes": [{ "path": "config.temperature", "before": 0.2, "after": 0.9 }]
      }
    ],
    "edges": [
      {
        "edgeId": "e_…",
        "kind": "added",
        "description": "Retrieve (documents) → LLM (context)"
      }
    ],
    "summary": { "added": 0, "removed": 0, "modified": 1, "moved": 0 },
    "identical": false
  },
  "summary": "1 modified"
}
```

## Assistant

### `GET /api/workflows/:id/analyze`

Deterministic static review — no model call, no cost. Combines graph analysis with
evidence from the last 25 runs.

```json
{
  "suggestions": [
    {
      "id": "quality:no-empty-branch:retrieve",
      "severity": "warning",
      "title": "Retrieval has no empty-result branch",
      "detail": "…",
      "nodeId": "retrieve",
      "fix": { "kind": "setConfig", "nodeId": "retrieve", "patch": { "minScore": 0.1 } }
    }
  ]
}
```

### `POST /api/workflows/:id/analyze`

```jsonc
{ "suggestionId": "quality:minScore:retrieve" }   // apply one
{ "all": true }                                    // apply every auto-fixable suggestion
```

### `POST /api/assistant/generate`

Generates a workflow from a description. Model output is never trusted: it is
schema-parsed, then repaired against the live registry (unknown node types
dropped, invalid ports remapped, dangling edges removed) before being returned.

```json
{ "prompt": "Classify a support ticket and escalate urgent ones", "save": false }
```

Response includes `repairs` (what had to be corrected) and `issues` (what could
not be). Rate limited to 20/minute.

## Runs

### `GET /api/runs?workflowId=&status=&limit=`

Summaries only — full traces can be megabytes.

### `GET /api/runs/:id`

The complete trace plus the graph it ran against.

### `POST /api/runs/:id/approvals`

```json
{ "nodeId": "approve", "decision": "approved", "comment": "Verified", "reviewer": "alex" }
```

## Observability

### `GET /api/observability?workflowId=&hours=24`

Success rate, p50/p95 latency, token and cost totals, hourly buckets, per-node
hotspots with time share, provider usage, and grouped errors.

## Deployments

### `GET /api/deployments?workflowId=`

### `POST /api/deployments`

```json
{
  "workflowId": "wf_…",
  "kind": "rest",
  "slug": "support-triage",
  "requireToken": true,
  "rateLimitPerMinute": 60
}
```

Requires a published version. The response contains the plaintext `token`
**exactly once** — only its SHA-256 hash is stored.

### `POST /api/v1/:slug`

The public execution endpoint. All deployment kinds resolve here.

```bash
curl -X POST https://your-app/api/v1/support-triage \
  -H "Authorization: Bearer ffk_…" \
  -H "Content-Type: application/json" \
  -d '{"question": "Where is my order?"}'
```

```json
{
  "runId": "run_…",
  "output": { "answer": "…" },
  "usage": { "totalTokens": 412, "costUsd": 0.0031 },
  "durationMs": 1840
}
```

A failed workflow returns **502** with `{ error, runId, status }`.

### `GET /api/v1/:slug`

Public metadata: kind, version, whether a token is required, invocation count.

## Evaluations

### `GET /api/evals?workflowId=`

### `POST /api/evals`

```jsonc
{ "action": "createSuite", "workflowId": "wf_…", "name": "Accuracy",
  "metrics": ["tokenF1", "latencyMs"],
  "cases": [{ "input": { "q": "…" }, "expected": "…" }] }

{ "action": "run", "suiteId": "suite_…", "version": 2, "label": "after prompt tweak" }

{ "action": "compare", "baselineRunId": "ev_…", "candidateRunId": "ev_…" }
```

`compare` returns per-metric deltas with direction-aware `improved` flags, plus
`regressions` and `fixes` — the case ids that flipped in each direction.

## Credentials

### `GET /api/credentials`

Metadata only. Values are never returned by any endpoint.

### `POST /api/credentials`

```json
{ "key": "OPENROUTER_API_KEY", "label": "Production key", "value": "sk-…" }
```

Keys must be `SCREAMING_SNAKE_CASE`. Values are encrypted with AES-256-GCM before
storage.

### `DELETE /api/credentials?key=OPENROUTER_API_KEY`
