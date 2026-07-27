# Plugin development

A FlowForge plugin is a plain object. No build step, no manifest format, no
lifecycle hooks.

```ts
interface Plugin {
  name: string;
  version: string;
  nodes?: NodeDefinition[];
  llmProviders?: LLMProvider[];
  embeddingProviders?: EmbeddingProvider[];
  vectorStores?: VectorStore[];
}

registry.use(myPlugin);
```

Every node shipped with FlowForge is written against this exact API. If a built-in
can do something your node cannot, that is a bug.

## The node contract

```ts
export const myNode = defineNode({
  type: 'acme.my-node',       // namespaced and unique
  version: '1.0.0',
  label: 'My Node',
  description: 'One sentence — this is what the palette shows.',
  category: 'data',
  icon: 'Sparkles',           // see src/components/ui/node-icon.tsx

  configSchema: z.object({ … }),
  configUi: { … },            // widget hints for the generated form

  inputs:  [{ id: 'in',  label: 'In',  type: 'string', required: true }],
  outputs: [{ id: 'out', label: 'Out', type: 'json' }],

  secrets: [{ key: 'ACME_API_KEY', label: 'Acme API key', required: true }],
  capabilities: { sideEffects: true },

  async execute({ config, inputs, ctx }) {
    return { outputs: { out: … } };
  },
});
```

`TConfig` is inferred from `configSchema`, so `config` inside `execute` is fully
typed with no casts.

### Port types

`any`, `string`, `number`, `boolean`, `json`, `array`, `binary`, `message`,
`document`, `embedding`, `trigger`.

`json` is the structural top type for anything serialisable. Assignability is
enforced when a connection is drawn, so an invalid edge cannot be created.

### Conditional ports — how branching works

**This is the most important idea in the node contract.** A node controls
downstream execution purely by which output ports appear in its result:

```ts
// Fires exactly one branch. The other is skipped, transitively.
return { outputs: matched ? { true: value } : { false: value } };
```

Mark any port that may not fire with `conditional: true`. A node whose inbound
edges are all skipped is itself skipped. That is how `if`, `switch`, guard
clauses, retrieval fallbacks, and error routing are all implemented — with no
engine support beyond this one rule.

### `NodeContext`

```ts
interface NodeContext {
  runId: string;
  nodeId: string;
  workflowId: string;
  signal: AbortSignal; // aborts on cancellation or timeout — always honour it
  depth: number; // sub-workflow nesting level

  log(level, message, data?): void;
  reportUsage(usage): void; // call more than once when streaming
  emitPartial(portId, chunk): void; // live output in the debugger

  getSecret(key): Promise<string | undefined>;

  state: {
    // run-scoped, shared across all nodes
    get<T>(key): T | undefined;
    set(key, value): void;
    keys(): string[];
  };

  providers: {
    llm(name?): LLMProvider;
    embedding(name?): EmbeddingProvider;
    vector(name?): VectorStore;
  };

  invoke(workflowId, input): Promise<Record<string, unknown>>; // depth-limited
}
```

Always pass `ctx.signal` into any `fetch` you make. A node that ignores it keeps
running after a user presses Stop.

### Secrets

Never read `process.env` directly. Declare what you need and resolve it through
the context, so the value is encrypted at rest and automatically redacted from
traces:

```ts
secrets: [{ key: 'ACME_API_KEY', label: 'Acme API key', required: true }],

async execute({ ctx }) {
  const key = await ctx.getSecret('ACME_API_KEY');
  if (!key) {
    throw new Error(
      'This node needs the ACME_API_KEY secret. Add it in Settings → Credentials.',
    );
  }
}
```

Users can also pass `{ "$secret": "ACME_API_KEY" }` as any config value; the
executor resolves it before `execute` runs.

### Error messages

Errors surface directly in the debugger. Write them for the person who has to fix
the problem — say what happened _and_ what to do:

```ts
// Good
throw new Error(
  'Brave Search returned 401. Check that BRAVE_SEARCH_API_KEY is valid in Settings → Credentials.',
);

// Not useful
throw new Error('Request failed');
```

### Capabilities

Declare these honestly — the workflow analyzer reads them:

| Flag              | Meaning                                                                                               |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| `sideEffects`     | Observable external effect. The analyzer will suggest retries, and warn about non-idempotent retries. |
| `deterministic`   | Same inputs always produce the same outputs. Enables caching.                                         |
| `suspends`        | May halt the run pending an external decision.                                                        |
| `invokesSubflows` | Uses `ctx.invoke`.                                                                                    |

## Custom providers

### LLM

```ts
class MyProvider implements LLMProvider {
  readonly name = 'my-provider';
  readonly models = ['my-org/my-model'] as const;

  async complete(req: LLMRequest): Promise<LLMResponse> {
    return {
      text: '…',
      finishReason: 'stop',
      usage: { model: req.model, promptTokens, completionTokens, totalTokens, costUsd },
    };
  }

  async *stream(req: LLMRequest): AsyncIterable<string> { … }   // optional
}
```

Report `usage` accurately — it feeds the cost dashboard and every evaluation
report. If your API does not return token counts on the streaming path, estimate
them (`estimateTokens` + `priceOf` in `src/core/providers/llm.ts`) rather than
reporting zero. Silent zeros make every cost number wrong.

### Vector store

Implement `upsert`, `query`, `delete`, and `count`. `query` returns matches sorted
by descending cosine score.

## The Python runner

The Python node deliberately ships without a runner: executing arbitrary Python in
the web process would be a remote-code-execution hole. Point `PYTHON_RUNNER_URL`
at an isolated service that accepts:

```json
{ "code": "result = {'value': input}", "input": {} }
```

and returns:

```json
{ "result": { "value": … }, "stdout": "…" }
```

Run it in a container with no network egress, a read-only filesystem, a memory
cap, and a wall-clock timeout.

## Testing a node

```ts
import { WorkflowExecutor, NodeRegistry } from '@/core';

const registry = new NodeRegistry().registerNode(myNode);
const executor = new WorkflowExecutor({ registry });

const trace = await executor.execute(
  { id: 'w', name: 'test', nodes: [{ id: 'n', type: 'acme.my-node', position: { x: 0, y: 0 }, config: {} }], edges: [] },
  { input: { … } },
);

expect(trace.status).toBe('succeeded');
expect(trace.nodes.n.outputs).toEqual({ out: … });
```

Inject `now` and `sleep` into the executor to test retry and timeout behaviour
without real delays. See `tests/helpers.ts`.

## Publishing

There is no hosted plugin registry yet (it is on the roadmap). For now, publish an
npm package exporting a `Plugin`, and document the `registry.use()` call consumers
need to add.
