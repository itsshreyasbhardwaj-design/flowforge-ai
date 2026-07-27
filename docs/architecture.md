# Architecture

## The shape of the system

FlowForge has one hard rule that everything else follows from: **the kernel does
not know the web app exists.** Nothing under `src/core/` imports React, Next.js,
or a database driver. The kernel takes a `Workflow` and a `NodeRegistry` and emits
a stream of `TraceEvent`s. The app is one consumer of that; a CLI or a worker
would be another.

```
Workflow (data)  ──▶  Validator  ──▶  Executor  ──▶  TraceEvent stream
                          │              │                  │
                     NodeRegistry   SecretVault      reduceTrace()
                          │              │                  │
                    NodeDefinitions  providers      RunTrace (persisted,
                                                     rendered, evaluated)
```

## Data model

A `Workflow` is a directed acyclic graph:

```ts
interface Workflow {
  id: string;
  name: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  variables?: Record<string, unknown>;
  concurrency?: number; // default 8
  policy?: Partial<NodePolicy>;
}
```

An edge connects a _source port_ on one node to a _target port_ on another. Ports
carry one of eleven types, and assignability is checked at three separate points:
when a connection is drawn (the handle refuses to snap), on every canvas edit
(client-side validation), and immediately before execution (server-side). All
three call the same `validateWorkflow`.

## The scheduler

`WorkflowExecutor` is event-driven. It maintains two state maps:

- **node state** — `pending | running | done | skipped | failed`
- **edge state** — `pending | delivered | skipped`

A node is runnable when no inbound edge is still `pending`. That is the whole
readiness rule. Consequences:

- **Parallelism is emergent.** Two branches with no shared ancestor become
  runnable at the same moment and run concurrently up to `concurrency`.
- **Branching needs no engine support.** A node result omits ports it did not
  activate. Edges from omitted ports become `skipped`. A node whose inbound edges
  are _all_ skipped is itself skipped, and that propagates transitively.
- **Fail-fast is one line.** A node failure aborts a shared `AbortController`,
  which cancels siblings mid-flight.

There is no `switch` on node type anywhere in the executor.

### Why not cycles

Cycles are rejected at validation. Iteration goes through a `Loop` node that
invokes a sub-workflow per item, bounded by a depth limit.

The trade-off is deliberate. Cyclic graphs would be marginally more convenient to
author, but they make termination undecidable, make a trace a tangle rather than a
tree, and make "which iteration failed?" hard to answer. Sub-workflow iteration
gives each pass its own trace, makes the loop body independently testable and
versionable, and makes runaway recursion a caught error instead of a hung process.

### Error policy

Per node, configurable:

| Policy           | Behaviour                                            |
| ---------------- | ---------------------------------------------------- |
| `fail` (default) | Abort the run                                        |
| `continue`       | Record the error, emit nothing, skip downstream      |
| `route`          | Emit the serialized error on the node's `error` port |

Retries use exponential backoff and are counted per node in the trace, so a node
that "works" after three attempts is visibly flaky rather than silently fine.

## Traces

A run is a stream of `TraceEvent`s folded by `reduceTrace` into a `RunTrace`.

The same reducer runs in three places: the server folds it to persist the final
record, the SSE route streams the raw events, and the browser folds those events
to render the live debugger. What a user watches mid-run is byte-identical to what
gets stored — there is no second, drifting representation.

Every value written into a trace passes through `redact()` (removes secret
material by key name and by exact value match) and `truncateForTrace()` (caps
serialized size), in that order.

## Expressions

Config values may contain `{{ $.path.to.value }}`. The resolver is a path walker,
not an evaluator — no `eval`, no `Function` constructor, no sandbox to escape.

Semantics:

- A template that is _exactly one_ expression returns the **raw value**, so
  objects and arrays survive intact.
- Anything else is string interpolation.
- `??` supplies a literal fallback.

Resolution happens before schema validation, so a templated field is validated
against its real runtime value rather than the template string. Validation
compensates by skipping schema errors on fields that still contain `{{`.

## Registry and plugins

`NodeRegistry` is an instance, not module state, so tests and multi-tenant
deployments can hold isolated plugin sets. It holds node definitions plus LLM,
embedding, and vector-store providers.

The API route `/api/nodes` projects each definition into a serialisable
descriptor — Zod schemas cannot cross the network. The editor builds the palette,
the port handles, and the entire inspector form from that descriptor, which is why
a third-party node needs no client-side code.

## Persistence

`Store` is an interface. Three implementations:

- **`MemoryStore`** — the reference implementation; all versioning logic lives here
- **`FileStore`** — extends it with debounced, atomic (`write` + `rename`) JSON persistence
- **Postgres** — planned; the interface is the seam

Versioning is copy-on-publish: publishing freezes the current draft and opens the
next one with a cloned graph. A deployment records a version number, so publishing
can never change what a live endpoint serves.

## Request lifecycle

```
POST /api/workflows/:id/run
  → resolve graph for version
  → executor.run() → async generator of TraceEvent
  → each event: JSON → SSE frame → browser
  → each event: reduceTrace → final RunTrace → store.saveRun()
```

The generator uses a queue plus a wake promise so events surface the moment they
are emitted, while nodes continue executing concurrently underneath.

## Deliberate limitations

Documented rather than hidden:

- The in-memory vector store is process-local and non-persistent.
- The rate limiter is per-process.
- The Function node is isolated but not sandboxed (see [security.md](security.md)).
- There is no authentication layer; only `/api/v1/:slug` is designed to be public.
- The offline embedder is lexical, not semantic — it will not connect "car" to
  "automobile".
