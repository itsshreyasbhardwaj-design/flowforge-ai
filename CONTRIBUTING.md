# Contributing to FlowForge AI

Thanks for taking the time. This document covers how to get set up, what the
architecture expects of you, and what a mergeable pull request looks like.

## Setup

```bash
pnpm install
pnpm dev          # http://localhost:3000
pnpm test:watch
```

No API keys and no accounts are needed. The default configuration uses a
deterministic offline model, local embeddings, an in-memory vector store, and a
JSON file database. If a change only works once you add a key, that is a bug.

## Before you open a pull request

```bash
pnpm verify   # typecheck + lint + tests + production build
```

CI runs exactly this. A red build will not be reviewed.

## Architectural rules

These are not style preferences — breaking them costs real capability.

1. **The kernel stays framework-free.** Nothing under `src/core/` may import
   React, Next.js, or a database driver. The kernel is what makes the engine
   unit-testable in milliseconds and embeddable outside this app.
2. **The engine never branches on node type.** Control flow is expressed by which
   output ports a node activates. If you find yourself writing
   `if (node.type === '…')` in the executor, the design is telling you the node
   contract needs extending instead.
3. **Built-ins use the public plugin API.** Every shipped node is a plain
   `defineNode` call. If a built-in needs something a third-party node cannot
   have, add it to `NodeContext` — do not reach around the contract.
4. **Traces are the single source of truth.** The debugger, evaluation harness,
   observability dashboard, and stored run records all fold the same
   `TraceEvent` stream with the same reducer. Do not add a second representation
   of what happened during a run.
5. **Secrets never touch a workflow document.** Use `{ "$secret": "KEY" }`
   references. Anything written to a trace goes through `redact()`.

## Adding a node

Nodes live in `src/core/nodes/`, grouped by domain. A node needs:

- a namespaced `type` (`flowforge.*` for built-ins),
- a Zod `configSchema` — this is what generates the inspector form,
- typed `inputs` / `outputs`, with `conditional: true` on any port that may not fire,
- `capabilities` declared honestly, especially `sideEffects`,
- an `execute` that throws a message a user can act on.

Register it in the relevant array export, then add a test. See
[docs/plugins.md](docs/plugins.md) for the full contract.

### Error messages

Write errors for the person who has to fix them. Say what went wrong, and what to
do about it:

```ts
throw new Error(
  'Web Search needs the BRAVE_SEARCH_API_KEY secret. Brave offers a free tier; add the key in Settings → Credentials.',
);
```

## Tests

Vitest, under `tests/`. The kernel is the part that must be covered — it is pure,
fast to test, and where correctness actually lives.

- Test observable behaviour, not internals.
- Every bug fix gets a regression test that fails without the fix.
- Use the helpers in `tests/helpers.ts` for graphs and stub nodes.
- Inject `now` and `sleep` into the executor rather than using real timers.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/). The scope is the
subsystem:

```
feat(nodes): add Anthropic-native provider
fix(executor): classify node failure as failed, not cancelled
docs(plugins): document ctx.invoke depth limits
```

## Pull requests

Explain the _why_, not just the _what_. Include:

- the problem being solved,
- the approach, and any alternative you rejected,
- how you verified it,
- screenshots for UI changes.

Keep PRs focused. A refactor bundled into a bug fix makes both harder to review.

## Reporting bugs

Use the issue templates. A workflow JSON export and the run id reproduce almost
anything, and save a round trip.

## Code of conduct

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
