import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  NodeContext,
  NodeDefinition,
  NodeResult,
  UsageReport,
} from '@/core/registry/definition';
import { MockLLMProvider } from '@/core/providers/llm';
import { HashEmbeddingProvider, MemoryVectorStore } from '@/core/providers/vector';
import { EvalRunner } from '@/core/eval/runner';
import { WorkflowExecutor } from '@/core/runtime/executor';
import { FileStore } from '@/core/store/file';
import { BUILTIN_TEMPLATES } from '@/core/templates';
import { generateWorkflow, describeRegistry } from '@/core/assistant/generate';
import { edge, graph, node, testRegistry } from './helpers';

const registry = testRegistry();

interface Harness {
  ctx: NodeContext;
  logs: { level: string; message: string }[];
  partials: { portId: string; chunk: unknown }[];
  usage: UsageReport[];
  vector: MemoryVectorStore;
  state: Map<string, unknown>;
}

/**
 * Executes a single node definition against a stub context.
 *
 * Node logic is tested directly rather than through the scheduler — the scheduler
 * has its own suite, and mixing the two makes a failure ambiguous.
 */
function harness(overrides: Partial<NodeContext> = {}): Harness {
  const logs: Harness['logs'] = [];
  const partials: Harness['partials'] = [];
  const usage: UsageReport[] = [];
  const state = new Map<string, unknown>();
  const vector = new MemoryVectorStore();
  const embedding = new HashEmbeddingProvider(128);
  const llm = new MockLLMProvider();

  const ctx: NodeContext = {
    runId: 'run_test',
    nodeId: 'n1',
    workflowId: 'wf_test',
    signal: new AbortController().signal,
    depth: 0,
    log: (level, message) => void logs.push({ level, message }),
    reportUsage: (report) => void usage.push(report),
    emitPartial: (portId, chunk) => void partials.push({ portId, chunk }),
    getSecret: async () => undefined,
    state: {
      get: <T>(key: string) => state.get(key) as T | undefined,
      set: (key, value) => void state.set(key, value),
      keys: () => [...state.keys()],
    },
    providers: { llm: () => llm, embedding: () => embedding, vector: () => vector },
    invoke: async (workflowId, input) => ({ echoed: input, from: workflowId }),
    ...overrides,
  };

  return { ctx, logs, partials, usage, vector, state };
}

async function run(
  type: string,
  config: Record<string, unknown>,
  inputs: Record<string, unknown> = {},
  h: Harness = harness(),
): Promise<NodeResult> {
  const def = registry.get(type) as unknown as NodeDefinition<unknown>;
  const parsed = def.configSchema.parse(config);
  return def.execute({ config: parsed, inputs, ctx: h.ctx });
}

describe('logic nodes', () => {
  it('condition activates exactly one port', async () => {
    const yes = await run(
      'flowforge.condition',
      { operator: 'equals', right: 'go' },
      { value: 'go' },
    );
    expect(Object.keys(yes.outputs)).toEqual(['true']);

    const no = await run(
      'flowforge.condition',
      { operator: 'equals', right: 'go' },
      { value: 'stop' },
    );
    expect(Object.keys(no.outputs)).toEqual(['false']);
  });

  it('router picks the first matching case, or the fallback', async () => {
    const cases = [
      { port: 'a', operator: 'contains' as const, value: 'urgent' },
      { port: 'b', operator: 'contains' as const, value: 'billing' },
    ];

    const matched = await run('flowforge.router', { cases }, { value: 'urgent billing issue' });
    expect(Object.keys(matched.outputs)).toEqual(['a']);

    const all = await run(
      'flowforge.router',
      { cases, matchAll: true },
      { value: 'urgent billing issue' },
    );
    expect(Object.keys(all.outputs).sort()).toEqual(['a', 'b']);

    const none = await run('flowforge.router', { cases }, { value: 'nothing relevant' });
    expect(Object.keys(none.outputs)).toEqual(['fallback']);
  });

  it('merge combines branches by strategy', async () => {
    const inputs = { a: 'first', b: 'second' };

    expect(
      (await run('flowforge.merge', { strategy: 'object' }, inputs)).outputs.value,
    ).toEqual({
      a: 'first',
      b: 'second',
    });
    expect((await run('flowforge.merge', { strategy: 'array' }, inputs)).outputs.value).toEqual(
      ['first', 'second'],
    );
    expect(
      (await run('flowforge.merge', { strategy: 'concatText', separator: ' | ' }, inputs))
        .outputs.value,
    ).toBe('first | second');
    expect(
      (await run('flowforge.merge', { strategy: 'firstPresent' }, { b: 'only b' })).outputs
        .value,
    ).toBe('only b');
  });

  it('parallel fans one value out to the configured branch count', async () => {
    const result = await run('flowforge.parallel', { branches: 3 }, { value: 42 });
    expect(Object.keys(result.outputs).sort()).toEqual(['a', 'b', 'c']);
    expect(result.outputs.a).toBe(42);
  });

  it('loop runs a sub-workflow per item and collects results', async () => {
    const h = harness();
    const result = await run(
      'flowforge.loop',
      { workflowId: 'wf_body', mode: 'sequential' },
      { items: ['x', 'y', 'z'] },
      h,
    );
    expect(result.outputs.count).toBe(3);
    expect(result.outputs.results as unknown[]).toHaveLength(3);
    expect((result.outputs.results as { echoed: { item: string } }[])[1].echoed.item).toBe('y');
  });

  it('loop in parallel mode preserves item order in the results array', async () => {
    // Deliberately resolves later items first to prove ordering is by index.
    const h = harness({
      invoke: async (_id, input) => {
        const { index } = input as { index: number };
        await new Promise((r) => setTimeout(r, (3 - index) * 5));
        return { index };
      },
    });
    const result = await run(
      'flowforge.loop',
      { workflowId: 'wf_body', mode: 'parallel', concurrency: 3 },
      { items: [0, 1, 2] },
      h,
    );
    expect(result.outputs.results).toEqual([{ index: 0 }, { index: 1 }, { index: 2 }]);
  });

  it('loop collects errors when continueOnError is set', async () => {
    const h = harness({
      invoke: async (_id, input) => {
        if ((input as { index: number }).index === 1) throw new Error('bad item');
        return { ok: true };
      },
    });
    const result = await run(
      'flowforge.loop',
      { workflowId: 'wf_body', continueOnError: true },
      { items: [1, 2, 3] },
      h,
    );
    expect(result.outputs.errors).toEqual([{ index: 1, message: 'bad item' }]);
  });

  it('loop caps iterations at maxItems', async () => {
    const result = await run(
      'flowforge.loop',
      { workflowId: 'wf_body', maxItems: 2 },
      { items: [1, 2, 3, 4, 5] },
    );
    expect(result.outputs.count).toBe(2);
  });

  it('human approval blocks until a decision is recorded', async () => {
    await expect(
      run('flowforge.human_approval', { mode: 'manual' }, { value: 'payload' }),
    ).rejects.toThrow(/waiting on a human decision/);

    const h = harness();
    h.state.set('approval:n1', 'approved');
    const approved = await run(
      'flowforge.human_approval',
      { mode: 'manual' },
      { value: 'p' },
      h,
    );
    expect(Object.keys(approved.outputs)).toEqual(['approved']);

    const auto = await run('flowforge.human_approval', { mode: 'autoApprove' }, { value: 'p' });
    expect(Object.keys(auto.outputs)).toEqual(['approved']);
  });

  it('timer waits and passes its value through', async () => {
    const result = await run('flowforge.timer', { delayMs: 5 }, { value: 'through' });
    expect(result.outputs.value).toBe('through');
  });

  it('subflow delegates and returns the child output', async () => {
    const result = await run('flowforge.subflow', { workflowId: 'wf_child' }, { input: 7 });
    expect(result.outputs.output).toEqual({ echoed: 7, from: 'wf_child' });
  });
});

describe('data nodes', () => {
  it('json performs each operation', async () => {
    expect(
      (await run('flowforge.json', { operation: 'parse' }, { value: '{"a":1}' })).outputs.value,
    ).toEqual({ a: 1 });
    expect(
      (
        await run(
          'flowforge.json',
          { operation: 'stringify', pretty: false },
          { value: { a: 1 } },
        )
      ).outputs.value,
    ).toBe('{"a":1}');
    expect(
      (
        await run(
          'flowforge.json',
          { operation: 'pick', keys: ['a'] },
          { value: { a: 1, b: 2 } },
        )
      ).outputs.value,
    ).toEqual({ a: 1 });
    expect(
      (
        await run(
          'flowforge.json',
          { operation: 'omit', keys: ['a'] },
          { value: { a: 1, b: 2 } },
        )
      ).outputs.value,
    ).toEqual({ b: 2 });
    expect(
      (
        await run(
          'flowforge.json',
          { operation: 'set', path: 'nested.deep', value: 9 },
          { value: {} },
        )
      ).outputs.value,
    ).toEqual({ nested: { deep: 9 } });
  });

  it('json parse leaves malformed input as a string rather than throwing', async () => {
    const result = await run('flowforge.json', { operation: 'parse' }, { value: 'not json {' });
    expect(result.outputs.value).toBe('not json {');
  });

  it('csv parses rows and reports columns', async () => {
    const result = await run(
      'flowforge.csv',
      {},
      { text: 'name,role\nAda,engineer\nGrace,admiral' },
    );
    expect(result.outputs.columns).toEqual(['name', 'role']);
    expect(result.outputs.count).toBe(2);
    expect((result.outputs.rows as Record<string, string>[])[1]).toEqual({
      name: 'Grace',
      role: 'admiral',
    });
  });

  it('text splitter chunks with overlap', async () => {
    const result = await run(
      'flowforge.text_splitter',
      { chunkSize: 50, overlap: 10 },
      { text: 'a'.repeat(200) },
    );
    expect(result.outputs.count as number).toBeGreaterThan(3);
  });

  it('function runs sandboxed JavaScript and captures console output', async () => {
    const h = harness();
    const result = await run(
      'flowforge.function',
      { code: 'console.log("hello from sandbox"); return { value: input * 2 };' },
      { input: 21 },
      h,
    );
    expect(result.outputs.value).toBe(42);
    expect(h.logs.some((l) => l.message.includes('hello from sandbox'))).toBe(true);
  });

  it('function cannot reach require, process, or the filesystem', async () => {
    await expect(
      run('flowforge.function', { code: 'return { value: typeof require };' }, {}),
    ).resolves.toMatchObject({ outputs: { value: 'undefined' } });

    await expect(
      run('flowforge.function', { code: 'return { value: typeof process };' }, {}),
    ).resolves.toMatchObject({ outputs: { value: 'undefined' } });
  });

  it('function surfaces a syntax error as an actionable message', async () => {
    await expect(
      run('flowforge.function', { code: 'this is not javascript' }, {}),
    ).rejects.toThrow(/Function node failed/);
  });

  it('function wraps a non-object return value', async () => {
    const result = await run('flowforge.function', { code: 'return 5;' }, {});
    expect(result.outputs).toEqual({ value: 5 });
  });

  it('python refuses to run without an isolated runner', async () => {
    await expect(run('flowforge.python', { code: 'x = 1' }, {})).rejects.toThrow(
      /needs an isolated runner/,
    );
  });
});

describe('AI nodes', () => {
  it('llm calls the provider and reports usage', async () => {
    const result = await run(
      'flowforge.llm',
      { model: 'flowforge/mock', prompt: 'Say hello', stream: false },
      {},
    );
    expect(result.outputs.text).toContain('Mock response');
    expect(result.usage?.totalTokens).toBeGreaterThan(0);
  });

  it('llm estimates usage on the streaming path', async () => {
    const h = harness();
    const result = await run(
      'flowforge.llm',
      { model: 'flowforge/mock', prompt: 'Say hello', stream: true },
      {},
      h,
    );
    // Streaming reports no usage frame, so a zero here would silently break costs.
    expect(result.usage?.totalTokens).toBeGreaterThan(0);
    expect(h.partials.length).toBeGreaterThan(0);
    expect(h.partials.every((p) => p.portId === 'text')).toBe(true);
  });

  it('llm exposes a json port only when the reply parses', async () => {
    const json = await run(
      'flowforge.llm',
      { model: 'flowforge/mock', prompt: 'q', jsonMode: true, stream: false },
      {},
    );
    expect(json.outputs).toHaveProperty('json');

    const text = await run(
      'flowforge.llm',
      { model: 'flowforge/mock', prompt: 'q', jsonMode: false, stream: false },
      {},
    );
    expect(text.outputs).not.toHaveProperty('json');
  });

  it('llm folds retrieved context into the prompt', async () => {
    const result = await run(
      'flowforge.llm',
      { model: 'flowforge/mock', prompt: 'Answer', stream: false },
      { context: [{ text: 'The sky is blue.' }] },
    );
    expect(result.outputs.text).toContain('The sky is blue.');
  });

  it('prompt substitutes runtime variables', async () => {
    const result = await run(
      'flowforge.prompt',
      { template: 'Hello {{ name }}, you are {{ role }}.' },
      { variables: { name: 'Ada', role: 'an engineer' } },
    );
    expect(result.outputs.text).toBe('Hello Ada, you are an engineer.');
    expect(result.outputs.messages).toEqual([
      { role: 'user', content: 'Hello Ada, you are an engineer.' },
    ]);
  });

  it('embedding produces one vector per input', async () => {
    const result = await run('flowforge.embedding', {}, { text: ['one', 'two'] });
    expect(result.outputs.embeddings).toHaveLength(2);
    expect(result.outputs.dimensions).toBe(128);
  });

  it('knowledge base chunks, embeds, and writes to the store', async () => {
    const h = harness();
    const result = await run(
      'flowforge.knowledge',
      { collection: 'kb', chunkSize: 100, chunkOverlap: 0 },
      { documents: ['x'.repeat(350)] },
      h,
    );
    expect(result.outputs.chunks as number).toBeGreaterThan(1);
    expect(await h.vector.count('kb')).toBe(result.outputs.chunks);
  });

  it('vector search activates the empty port when nothing clears the floor', async () => {
    const h = harness();
    await run(
      'flowforge.knowledge',
      { collection: 'kb' },
      { documents: ['Refunds are accepted within 30 days of delivery.'] },
      h,
    );

    const hit = await run(
      'flowforge.vector_search',
      { collection: 'kb', topK: 3, minScore: 0.1 },
      { query: 'What is the refund window?' },
      h,
    );
    expect(hit.outputs).toHaveProperty('documents');
    expect(hit.outputs.text).toContain('Refunds');

    const miss = await run(
      'flowforge.vector_search',
      { collection: 'kb', topK: 3, minScore: 0.9 },
      { query: 'quantum chromodynamics' },
      h,
    );
    expect(Object.keys(miss.outputs)).toEqual(['empty']);
  });

  it('memory appends, reads, and clears within a run', async () => {
    const h = harness();
    await run('flowforge.memory', { key: 'chat', operation: 'append' }, { value: 'first' }, h);
    const second = await run(
      'flowforge.memory',
      { key: 'chat', operation: 'append', role: 'assistant' },
      { value: 'second' },
      h,
    );
    expect(second.outputs.size).toBe(2);

    const read = await run('flowforge.memory', { key: 'chat', operation: 'read' }, {}, h);
    expect(read.outputs.size).toBe(2);

    const cleared = await run('flowforge.memory', { key: 'chat', operation: 'clear' }, {}, h);
    expect(cleared.outputs.size).toBe(0);
  });

  it('memory drops the oldest entries past maxMessages', async () => {
    const h = harness();
    for (const value of ['a', 'b', 'c']) {
      await run(
        'flowforge.memory',
        { key: 'chat', operation: 'append', maxMessages: 2 },
        { value },
        h,
      );
    }
    const read = await run('flowforge.memory', { key: 'chat', operation: 'read' }, {}, h);
    expect(read.outputs.size).toBe(2);
    expect((read.outputs.messages as { content: string }[])[0].content).toBe('b');
  });

  it('agent treats unparseable output as its final answer', async () => {
    // The offline model returns prose, not a tool call — an agent that hard-failed
    // on that would be unusable against any real model that drifts.
    const result = await run(
      'flowforge.agent',
      { name: 'Solo', model: 'flowforge/mock', instructions: 'Answer directly.' },
      { task: 'What is 2 + 2?' },
    );
    expect(result.outputs.iterations).toBe(1);
    expect(String(result.outputs.result)).toContain('Mock response');
  });

  it('agent delegates to a tool workflow and feeds the result back', async () => {
    const calls: string[] = [];
    let turn = 0;
    const scripted = {
      name: 'scripted',
      models: ['scripted/model'] as const,
      async complete() {
        turn += 1;
        return {
          text:
            turn === 1
              ? JSON.stringify({ action: 'tool', tool: 'search', input: { q: 'agents' } })
              : JSON.stringify({ action: 'final', answer: 'Found three sources.' }),
          finishReason: 'stop' as const,
          usage: { totalTokens: 10 },
        };
      },
    };

    const h = harness({
      providers: {
        llm: () => scripted,
        embedding: () => new HashEmbeddingProvider(64),
        vector: () => new MemoryVectorStore(),
      },
      invoke: async (workflowId) => {
        calls.push(workflowId);
        return { sources: 3 };
      },
    });

    const result = await run(
      'flowforge.agent',
      {
        name: 'Researcher',
        model: 'scripted/model',
        tools: [{ name: 'search', description: 'Search', workflowId: 'wf_search' }],
      },
      { task: 'Research agent frameworks' },
      h,
    );

    expect(calls).toEqual(['wf_search']);
    expect(result.outputs.result).toBe('Found three sources.');
    expect(result.outputs.iterations).toBe(2);
  });

  it('agent recovers when the model names a tool that does not exist', async () => {
    let turn = 0;
    const scripted = {
      name: 'scripted',
      models: ['scripted/model'] as const,
      async complete() {
        turn += 1;
        return {
          text:
            turn === 1
              ? JSON.stringify({ action: 'tool', tool: 'nonexistent', input: {} })
              : JSON.stringify({ action: 'final', answer: 'Recovered.' }),
          finishReason: 'stop' as const,
          usage: {},
        };
      },
    };
    const h = harness({
      providers: {
        llm: () => scripted,
        embedding: () => new HashEmbeddingProvider(64),
        vector: () => new MemoryVectorStore(),
      },
    });

    const result = await run(
      'flowforge.agent',
      {
        model: 'scripted/model',
        tools: [{ name: 'real', description: 'A real tool', workflowId: 'wf_real' }],
      },
      { task: 'Do the thing' },
      h,
    );
    expect(result.outputs.result).toBe('Recovered.');
  });
});

describe('io nodes', () => {
  it('manual trigger prefers the run input over the configured sample', async () => {
    const h = harness();
    h.state.set('__runInput', { from: 'run' });
    expect(
      (await run('flowforge.trigger_manual', { sample: { from: 'config' } }, {}, h)).outputs,
    ).toEqual({ payload: { from: 'run' } });

    const empty = harness();
    expect(
      (await run('flowforge.trigger_manual', { sample: { from: 'config' } }, {}, empty))
        .outputs,
    ).toEqual({ payload: { from: 'config' } });
  });

  it('webhook trigger exposes body, headers, and query', async () => {
    const h = harness();
    h.state.set('__request', { body: { a: 1 }, headers: { 'x-test': '1' }, query: { b: '2' } });
    const result = await run('flowforge.trigger_webhook', {}, {}, h);
    expect(result.outputs.body).toEqual({ a: 1 });
    expect(result.outputs.headers).toEqual({ 'x-test': '1' });
  });

  it('output passes its value through', async () => {
    expect(
      (await run('flowforge.output', { name: 'r' }, { value: 'done' })).outputs.value,
    ).toBe('done');
  });

  it('slack explains what to configure when no webhook URL is available', async () => {
    await expect(run('flowforge.slack', { text: 'hi' }, {})).rejects.toThrow(
      /SLACK_WEBHOOK_URL secret/,
    );
  });

  it('web search explains what to configure when no key is available', async () => {
    await expect(run('flowforge.web_search', { query: 'x' }, {})).rejects.toThrow(
      /BRAVE_SEARCH_API_KEY/,
    );
  });

  it('http posts a body and parses a JSON response', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await run(
      'flowforge.http',
      { method: 'POST', url: 'https://example.com/api' },
      { body: { hello: 'world' } },
    );

    expect(result.outputs.status).toBe(200);
    expect(result.outputs.data).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it('http routes a non-2xx response to the error port when configured', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    );

    const result = await run('flowforge.http', {
      url: 'https://example.com',
      throwOnError: false,
    });
    expect(result.outputs).toHaveProperty('error');
    expect(result.outputs.status).toBe(500);

    await expect(
      run('flowforge.http', { url: 'https://example.com', throwOnError: true }),
    ).rejects.toThrow(/HTTP 500/);
    vi.unstubAllGlobals();
  });
});

describe('bundled templates', () => {
  it.each(BUILTIN_TEMPLATES.map((t) => [t.id, t] as const))(
    '%s validates',
    async (_id, template) => {
      const executor = new WorkflowExecutor({
        registry,
        loadWorkflow: async () => template.graph,
      });
      // Every shipped template must at minimum be a runnable graph.
      const trace = await executor.execute(template.graph, { input: {} });
      expect(trace.error?.message ?? '').not.toContain('not runnable');
    },
  );

  it('the RAG template answers from context and falls back without it', async () => {
    const rag = BUILTIN_TEMPLATES.find((t) => t.id === 'tpl_rag')!;
    const executor = new WorkflowExecutor({ registry: testRegistry() });

    const answered = await executor.execute(rag.graph, {
      input: {
        question: 'What is the refund window?',
        documents: ['Refunds are accepted within 30 days of delivery.'],
      },
    });
    expect(answered.status).toBe('succeeded');
    expect(answered.nodes.answer.status).toBe('succeeded');
    expect(answered.nodes.fallback.status).toBe('skipped');

    // A fresh registry means a fresh, empty vector store.
    const empty = new WorkflowExecutor({ registry: testRegistry() });
    const fellBack = await empty.execute(rag.graph, {
      input: { question: 'What is the refund window?', documents: [] },
    });
    expect(fellBack.status).toBe('succeeded');
    expect(fellBack.nodes.answer.status).toBe('skipped');
    expect(fellBack.nodes.fallback.status).toBe('succeeded');
  });
});

describe('evaluation runner', () => {
  it('scores every case and summarises the suite', async () => {
    const executor = new WorkflowExecutor({ registry });
    let counter = 0;
    const runner = new EvalRunner({
      executor,
      concurrency: 2,
      idFactory: () => `ev_${counter++}`,
    });

    const workflow = graph(
      [
        node('t', 'flowforge.trigger_manual'),
        // The trigger emits the run input directly on `payload`, so `input` here
        // is already the case's input object.
        node('fn', 'flowforge.function', {
          code: 'return { value: String(input?.q ?? "") };',
        }),
        node('out', 'flowforge.output', { name: 'answer' }),
      ],
      [edge('t', 'payload', 'fn', 'input'), edge('fn', 'value', 'out', 'value')],
    );

    const result = await runner.run({
      version: 1,
      graph: workflow,
      suite: {
        id: 'suite_1',
        workflowId: workflow.id,
        name: 'echo',
        createdAt: new Date(0).toISOString(),
        metrics: ['exactMatch', 'taskCompletion', 'latencyMs'],
        cases: [
          { id: 'c1', input: { q: 'hello' }, expected: 'hello' },
          { id: 'c2', input: { q: 'world' }, expected: 'mismatch' },
        ],
      },
    });

    expect(result.results).toHaveLength(2);
    expect(result.results.find((r) => r.caseId === 'c1')?.status).toBe('passed');
    expect(result.results.find((r) => r.caseId === 'c2')?.status).toBe('failed');
    expect(result.passRate).toBe(0.5);
    expect(result.summary.exactMatch).toBe(0.5);
  });
});

describe('file store', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'flowforge-'));
  });

  it('persists across instances', async () => {
    const path = join(dir, 'store.json');
    const store = await new FileStore(path, 0).load();
    const now = new Date().toISOString();

    await store.createWorkflow(
      {
        id: 'w1',
        name: 'Persisted',
        ownerId: 'u1',
        tags: [],
        createdAt: now,
        updatedAt: now,
        draftVersion: 1,
      },
      graph([node('t', 'flowforge.trigger_manual')]),
    );
    await store.publish('w1', 'first');
    await store.close();

    const reopened = await new FileStore(path, 0).load();
    const record = await reopened.getWorkflow('w1');
    expect(record?.name).toBe('Persisted');
    expect(record?.publishedVersion).toBe(1);
    expect(await reopened.listVersions('w1')).toHaveLength(2);

    await rm(dir, { recursive: true, force: true });
  });
});

describe('assistant generation', () => {
  it('describes every registered node to the model', () => {
    const description = describeRegistry(registry);
    expect(description).toContain('flowforge.llm');
    expect(description).toContain('flowforge.condition');
  });

  it('repairs invalid node types and ports instead of failing', async () => {
    const provider = {
      name: 'scripted',
      models: ['scripted/model'] as const,
      async complete() {
        return {
          text: JSON.stringify({
            name: 'Generated',
            nodes: [
              { id: 'trigger', type: 'flowforge.trigger_manual', config: {} },
              { id: 'ghost', type: 'does.not.exist', config: {} },
              { id: 'out', type: 'flowforge.output', config: { name: 'r' } },
            ],
            edges: [
              // A port name the model invented, and an edge to the dropped node.
              { source: 'trigger', sourcePort: 'made_up', target: 'out', targetPort: 'value' },
              { source: 'ghost', sourcePort: 'x', target: 'out', targetPort: 'value' },
            ],
          }),
          finishReason: 'stop' as const,
          usage: {},
        };
      },
    };

    const result = await generateWorkflow({ prompt: 'anything', registry, provider });

    expect(result.workflow.nodes.map((n) => n.id)).toEqual(['trigger', 'out']);
    expect(result.repairs.some((r) => r.includes('unknown type'))).toBe(true);
    expect(result.repairs.some((r) => r.includes('Remapped'))).toBe(true);
    expect(result.workflow.edges[0].sourcePort).toBe('payload');
  });

  it('returns an actionable message when the model emits no JSON', async () => {
    const provider = {
      name: 'scripted',
      models: ['scripted/model'] as const,
      async complete() {
        return { text: 'I am not JSON.', finishReason: 'stop' as const, usage: {} };
      },
    };

    const result = await generateWorkflow({ prompt: 'anything', registry, provider });
    expect(result.workflow.nodes).toHaveLength(0);
    expect(result.issues[0]).toContain('did not return valid JSON');
  });
});
