import { describe, expect, it } from 'vitest';
import { findCycle, topologicalOrder, validateWorkflow } from '@/core/graph/validate';
import { isPortCompatible } from '@/core/graph/types';
import {
  collectReferences,
  referencedNodeIds,
  resolveConfig,
  resolveTemplate,
  type ExpressionScope,
} from '@/core/runtime/expression';
import { EncryptedVault, redact, truncateForTrace } from '@/core/runtime/secrets';
import { diffWorkflows, summarizeDiff } from '@/core/versioning/diff';
import { compareEvalRuns, percentile } from '@/core/eval/runner';
import { exactMatch, tokenF1 } from '@/core/eval/metrics';
import { aggregateRuns, normalizeErrorMessage } from '@/core/telemetry/aggregate';
import { chunkText } from '@/core/nodes/ai';
import { compare } from '@/core/nodes/logic';
import { parseCsv } from '@/core/nodes/data';
import {
  cosineSimilarity,
  HashEmbeddingProvider,
  MemoryVectorStore,
  stem,
} from '@/core/providers/vector';
import { estimateTokens, MockLLMProvider, priceOf } from '@/core/providers/llm';
import { MemoryStore } from '@/core/store/memory';
import { analyzeWorkflow, applyFix, longestPath } from '@/core/assistant/analyzer';
import type { RunRecord, EvalRun } from '@/core/store/types';
import { edge, graph, node, testRegistry } from './helpers';

const scope: ExpressionScope = {
  input: { question: 'why', nested: { deep: [1, 2, 3] } },
  nodes: { retrieve: { output: { docs: [{ text: 'hello' }], count: 2 } } },
  vars: { tone: 'warm' },
  run: { runId: 'run_1' },
};

describe('expressions', () => {
  it('returns the raw value for a lone expression', () => {
    expect(resolveTemplate('{{ $.nodes.retrieve.output.count }}', scope)).toBe(2);
    expect(resolveTemplate('{{ $.nodes.retrieve.output.docs }}', scope)).toEqual([
      { text: 'hello' },
    ]);
  });

  it('interpolates when mixed with literal text', () => {
    expect(resolveTemplate('Q: {{ $.input.question }}!', scope)).toBe('Q: why!');
  });

  it('indexes arrays and nested paths', () => {
    expect(resolveTemplate('{{ $.nodes.retrieve.output.docs[0].text }}', scope)).toBe('hello');
    expect(resolveTemplate('{{ $.input.nested.deep[2] }}', scope)).toBe(3);
  });

  it('falls back with ??', () => {
    expect(resolveTemplate('{{ $.vars.missing ?? "default" }}', scope)).toBe('default');
    expect(resolveTemplate('{{ $.vars.tone ?? "cold" }}', scope)).toBe('warm');
    expect(resolveTemplate('{{ $.vars.missing ?? 42 }}', scope)).toBe(42);
  });

  it('resolves undefined paths to undefined rather than throwing', () => {
    expect(resolveTemplate('{{ $.nope.at.all }}', scope)).toBeUndefined();
  });

  it('walks nested config objects', () => {
    const resolved = resolveConfig(
      { a: '{{ $.vars.tone }}', b: { c: ['{{ $.input.question }}'] }, d: 7 },
      scope,
    );
    expect(resolved).toEqual({ a: 'warm', b: { c: ['why'] }, d: 7 });
  });

  it('collects references for dependency analysis', () => {
    expect(collectReferences({ x: '{{ $.input.a }} and {{ $.vars.b }}' }).size).toBe(2);
    expect(referencedNodeIds({ x: '{{ $.nodes.retrieve.output.docs }}' })).toEqual([
      'retrieve',
    ]);
  });
});

describe('graph validation', () => {
  const registry = testRegistry();

  it('accepts a well-formed graph', () => {
    const wf = graph(
      [
        node('t', 'flowforge.trigger_manual'),
        node('o', 'flowforge.output', { name: 'result' }),
      ],
      [edge('t', 'payload', 'o', 'value')],
    );
    expect(validateWorkflow(wf, registry).valid).toBe(true);
  });

  it('rejects unknown node types', () => {
    const result = validateWorkflow(graph([node('x', 'nope.nope')]), registry);
    expect(result.valid).toBe(false);
    expect(result.errors[0].code).toBe('UNKNOWN_NODE_TYPE');
  });

  it('rejects incompatible port types', () => {
    const wf = graph(
      [
        node('t', 'flowforge.trigger_manual'),
        node('e', 'flowforge.embedding'),
        node('s', 'flowforge.vector_search', { collection: 'c' }),
      ],
      [edge('t', 'payload', 'e', 'text'), edge('e', 'embeddings', 's', 'query')],
    );
    const result = validateWorkflow(wf, registry);
    expect(result.errors.some((e) => e.code === 'TYPE_MISMATCH')).toBe(true);
  });

  it('detects cycles', () => {
    const wf = graph(
      [
        node('a', 'flowforge.json', { operation: 'parse' }),
        node('b', 'flowforge.json', { operation: 'parse' }),
      ],
      [edge('a', 'value', 'b', 'value'), edge('b', 'value', 'a', 'value')],
    );
    expect(findCycle(wf)).not.toBeNull();
    expect(topologicalOrder(wf)).toBeNull();
  });

  it('flags a missing required input', () => {
    const result = validateWorkflow(
      graph([node('o', 'flowforge.output', { name: 'x' })]),
      registry,
    );
    expect(result.errors.some((e) => e.code === 'MISSING_REQUIRED_INPUT')).toBe(true);
  });

  it('does not flag templated config as a schema violation', () => {
    const wf = graph(
      [
        node('t', 'flowforge.trigger_manual'),
        node('h', 'flowforge.http', { url: '{{ $.input.endpoint }}', method: 'GET' }),
      ],
      [edge('t', 'payload', 'h', 'body')],
    );
    // `url` is not a valid URL yet — it becomes one at run time.
    expect(validateWorkflow(wf, registry).errors.some((e) => e.code === 'INVALID_CONFIG')).toBe(
      false,
    );
  });

  it('orders nodes topologically', () => {
    const wf = graph(
      [
        node('c', 'flowforge.json', { operation: 'parse' }),
        node('a', 'flowforge.json', { operation: 'parse' }),
        node('b', 'flowforge.json', { operation: 'parse' }),
      ],
      [edge('a', 'value', 'b', 'value'), edge('b', 'value', 'c', 'value')],
    );
    const order = topologicalOrder(wf)!;
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'));
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('c'));
  });

  it('describes port assignability', () => {
    expect(isPortCompatible('string', 'any')).toBe(true);
    expect(isPortCompatible('number', 'string')).toBe(true);
    expect(isPortCompatible('array', 'json')).toBe(true);
    expect(isPortCompatible('binary', 'number')).toBe(false);
  });
});

describe('secrets', () => {
  it('round-trips through AES-256-GCM', async () => {
    const vault = new EncryptedVault('a-sufficiently-long-master-key');
    await vault.set('API_KEY', 'sk-live-1234567890');
    expect(await vault.get('API_KEY')).toBe('sk-live-1234567890');
    expect(JSON.stringify(vault.export())).not.toContain('sk-live');
  });

  it('rejects a short master key', () => {
    expect(() => new EncryptedVault('short')).toThrow();
  });

  it('redacts by key name and by value', () => {
    const output = redact({ apiKey: 'visible', note: 'the token is hunter2hunter2' }, [
      'hunter2hunter2',
    ]) as Record<string, string>;
    expect(output.apiKey).not.toBe('visible');
    expect(output.note).not.toContain('hunter2hunter2');
  });

  it('truncates oversized values', () => {
    const big = truncateForTrace({ blob: 'x'.repeat(50_000) }, 1000) as {
      __truncated: boolean;
    };
    expect(big.__truncated).toBe(true);
  });
});

describe('versioning diff', () => {
  const before = graph(
    [node('a', 'flowforge.llm', { model: 'flowforge/mock', temperature: 0.7 })],
    [],
    { name: 'v1' },
  );

  it('reports config changes as modifications', () => {
    const after = structuredClone(before);
    after.nodes[0].config.temperature = 0.2;
    const diff = diffWorkflows(before, after);
    expect(diff.identical).toBe(false);
    expect(diff.summary.modified).toBe(1);
    expect(diff.nodes[0].changes[0].path).toBe('config.temperature');
  });

  it('treats a position-only change as a move, not a modification', () => {
    const after = structuredClone(before);
    after.nodes[0].position = { x: 999, y: 999 };
    const diff = diffWorkflows(before, after);
    expect(diff.summary.moved).toBe(1);
    expect(diff.summary.modified).toBe(0);
    expect(diff.identical).toBe(true);
    expect(summarizeDiff(diff)).toBe('No functional changes');
  });

  it('reports added and removed nodes and edges', () => {
    const after = structuredClone(before);
    after.nodes.push(node('b', 'flowforge.output', { name: 'r' }));
    after.edges.push(edge('a', 'text', 'b', 'value'));
    const diff = diffWorkflows(before, after);
    expect(diff.summary.added).toBe(1);
    expect(diff.edges).toHaveLength(1);
    expect(diff.edges[0].kind).toBe('added');
  });
});

describe('evaluation', () => {
  it('scores exact match with normalisation', async () => {
    const trace = { status: 'succeeded', durationMs: 1, usage: {}, nodes: {} } as never;
    expect(
      await exactMatch.evaluate({
        testCase: { id: 'c', input: null, expected: 'Hello There' },
        output: { answer: 'hello there' },
        trace,
      }),
    ).toBe(1);
  });

  it('gives partial credit with token F1', async () => {
    const trace = { status: 'succeeded', durationMs: 1, usage: {}, nodes: {} } as never;
    const score = (await tokenF1.evaluate({
      testCase: { id: 'c', input: null, expected: 'the quick brown fox' },
      output: 'the quick fox',
      trace,
    })) as number;
    expect(score).toBeGreaterThan(0.7);
    expect(score).toBeLessThan(1);
  });

  it('computes percentiles', () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5)).toBe(5);
    expect(percentile([], 0.95)).toBe(0);
  });

  it('identifies regressions between two runs', () => {
    const base = {
      id: 'r1',
      suiteId: 's',
      workflowId: 'w',
      version: 1,
      startedAt: '',
      results: [
        { caseId: 'c1', status: 'passed' },
        { caseId: 'c2', status: 'failed' },
      ],
      summary: { exactMatch: 0.5, costUsd: 0.01 },
      passRate: 0.5,
      totalCostUsd: 0.01,
      p50LatencyMs: 100,
      p95LatencyMs: 200,
    } as unknown as EvalRun;
    const candidate = {
      ...base,
      id: 'r2',
      version: 2,
      results: [
        { caseId: 'c1', status: 'failed' },
        { caseId: 'c2', status: 'passed' },
      ],
      summary: { exactMatch: 0.5, costUsd: 0.02 },
      p95LatencyMs: 350,
    } as unknown as EvalRun;

    const comparison = compareEvalRuns(base, candidate);
    expect(comparison.regressions).toEqual(['c1']);
    expect(comparison.fixes).toEqual(['c2']);
    expect(comparison.latencyDelta).toBe(150);
    // Cost went up, and lower is better for cost.
    expect(comparison.metrics.find((m) => m.metric === 'costUsd')?.improved).toBe(false);
  });
});

describe('telemetry', () => {
  const makeRun = (
    id: string,
    status: string,
    durationMs: number,
    cost: number,
  ): RunRecord => ({
    id,
    workflowId: 'w',
    createdAt: new Date().toISOString(),
    trace: {
      runId: id,
      workflowId: 'w',
      status,
      startedAt: Date.now(),
      durationMs,
      input: null,
      output: {},
      usage: { totalTokens: 100, costUsd: cost },
      order: ['n1'],
      nodes: {
        n1: {
          nodeId: 'n1',
          status: status === 'failed' ? 'failed' : 'succeeded',
          attempts: 1,
          logs: [],
          durationMs,
          usage: { model: 'flowforge/mock', provider: 'mock', totalTokens: 100, costUsd: cost },
          error:
            status === 'failed'
              ? { name: 'Error', message: 'timeout after 5000ms' }
              : undefined,
        },
      },
    } as never,
  });

  it('summarises success rate, latency, and cost', () => {
    const summary = aggregateRuns([
      makeRun('1', 'succeeded', 100, 0.01),
      makeRun('2', 'succeeded', 300, 0.02),
      makeRun('3', 'failed', 200, 0),
    ]);
    expect(summary.totalRuns).toBe(3);
    expect(summary.successRate).toBeCloseTo(0.6667, 3);
    expect(summary.p95LatencyMs).toBe(300);
    expect(summary.totalCostUsd).toBeCloseTo(0.03, 6);
    expect(summary.providers[0].model).toBe('flowforge/mock');
    expect(summary.errors[0].count).toBe(1);
  });

  it('groups errors that differ only by ids and numbers', () => {
    expect(normalizeErrorMessage('timeout after 5000ms')).toBe(
      normalizeErrorMessage('timeout after 9000ms'),
    );
  });

  it('handles an empty dataset', () => {
    const summary = aggregateRuns([]);
    expect(summary.totalRuns).toBe(0);
    expect(summary.successRate).toBe(0);
  });
});

describe('node helpers', () => {
  it('chunks text with overlap', () => {
    const chunks = chunkText('a'.repeat(2500), 1000, 100);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks[0].length).toBeLessThanOrEqual(1000);
  });

  it('compares values across every operator', () => {
    expect(compare('hello world', 'contains', 'world')).toBe(true);
    expect(compare(['a', 'b'], 'contains', 'a')).toBe(true);
    expect(compare(5, 'greaterThan', 3)).toBe(true);
    expect(compare('', 'isEmpty', null)).toBe(true);
    expect(compare([], 'isEmpty', null)).toBe(true);
    expect(compare('abc123', 'matches', '^[a-z]+\\d+$')).toBe(true);
    expect(compare('x', 'matches', '[')).toBe(false);
  });

  it('parses CSV with quoted fields and embedded delimiters', () => {
    const { rows, columns } = parseCsv('name,note\n"Ada","likes, commas"\nGrace,"said ""hi"""');
    expect(columns).toEqual(['name', 'note']);
    expect(rows[0].note).toBe('likes, commas');
    expect(rows[1].note).toBe('said "hi"');
  });
});

describe('providers', () => {
  it('produces deterministic mock completions', async () => {
    const provider = new MockLLMProvider();
    const request = {
      model: 'flowforge/mock',
      messages: [{ role: 'user' as const, content: 'what is 2+2?' }],
    };
    const a = await provider.complete(request);
    const b = await provider.complete(request);
    expect(a.text).toBe(b.text);
    expect(a.usage.totalTokens).toBeGreaterThan(0);
  });

  it('honours fixtures', async () => {
    const provider = new MockLLMProvider({ 'special question': 'special answer' });
    const response = await provider.complete({
      model: 'flowforge/mock',
      messages: [{ role: 'user', content: 'a special question here' }],
    });
    expect(response.text).toBe('special answer');
  });

  it('embeds deterministically and ranks by similarity', async () => {
    const embedder = new HashEmbeddingProvider(128);
    const store = new MemoryVectorStore();
    const docs = ['cats are small feline pets', 'the stock market closed higher today'];
    const vectors = await embedder.embed(docs);

    await store.upsert(
      'c',
      docs.map((text, i) => ({ id: String(i), vector: vectors[i], text })),
    );
    const [query] = await embedder.embed(['small feline pets']);
    const matches = await store.query('c', query, 2);

    expect(matches[0].text).toBe(docs[0]);
    expect(matches[0].score).toBeGreaterThan(matches[1].score);
    // Same input, same vector.
    expect((await embedder.embed([docs[0]]))[0]).toEqual(vectors[0]);
  });

  it('collapses inflections when stemming', () => {
    expect(stem('refunds')).toBe('refund');
    expect(stem('shipping')).toBe('ship');
    expect(stem('accepted')).toBe('accept');
    expect(stem('policies')).toBe('policy');
    // Short tokens and non-suffixed words are left alone.
    expect(stem('day')).toBe('day');
    expect(stem('window')).toBe('window');
  });

  it('separates relevant from irrelevant text by a usable margin', async () => {
    const embedder = new HashEmbeddingProvider(256);
    const [query, relevant, irrelevant] = await embedder.embed([
      'What is the refund window?',
      'Refunds are accepted within 30 days of delivery.',
      'Shipping is free above $50 in the continental US.',
    ]);

    const hit = cosineSimilarity(query, relevant);
    const miss = cosineSimilarity(query, irrelevant);

    // The default template filters at 0.1, so a real match has to clear it even
    // though "refund" and "refunds" never share a literal token.
    expect(hit).toBeGreaterThan(0.1);
    expect(miss).toBeLessThan(hit);
  });

  it('computes cosine similarity', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it('prices known models and ignores unknown ones', () => {
    expect(priceOf('openai/gpt-4.1', 1_000_000, 0)).toBeCloseTo(2);
    expect(priceOf('nope/nope', 1_000_000, 1_000_000)).toBe(0);
    expect(estimateTokens('')).toBe(0);
  });
});

describe('store versioning', () => {
  const seed = async () => {
    const store = new MemoryStore();
    const now = new Date().toISOString();
    await store.createWorkflow(
      {
        id: 'w1',
        name: 'Demo',
        ownerId: 'u1',
        tags: [],
        createdAt: now,
        updatedAt: now,
        draftVersion: 1,
      },
      graph([node('t', 'flowforge.trigger_manual')]),
    );
    return store;
  };

  it('publishes and opens a fresh draft', async () => {
    const store = await seed();
    const published = await store.publish('w1', 'first release');

    expect(published.version).toBe(1);
    expect(published.status).toBe('published');

    const record = await store.getWorkflow('w1');
    expect(record?.publishedVersion).toBe(1);
    expect(record?.draftVersion).toBe(2);
    expect(await store.listVersions('w1')).toHaveLength(2);
  });

  it('keeps the published graph immutable when the draft changes', async () => {
    const store = await seed();
    await store.publish('w1');
    await store.saveDraft(
      'w1',
      graph([
        node('t', 'flowforge.trigger_manual'),
        node('x', 'flowforge.output', { name: 'r' }),
      ]),
    );

    const published = await store.getVersion('w1', 1);
    expect(published?.graph.nodes).toHaveLength(1);
    expect((await store.getVersion('w1', 2))?.graph.nodes).toHaveLength(2);
    // Execution resolves the published version, not the draft.
    expect((await store.resolveGraph('w1'))?.nodes).toHaveLength(1);
  });

  it('rolls a previous version back into the draft', async () => {
    const store = await seed();
    await store.publish('w1');
    await store.saveDraft('w1', graph([node('changed', 'flowforge.trigger_manual')]));
    await store.rollback('w1', 1);

    expect((await store.resolveGraph('w1', 2))?.nodes[0].id).toBe('t');
  });
});

describe('assistant analyzer', () => {
  const registry = testRegistry();

  it('flags a hard-coded credential as critical', () => {
    const wf = graph(
      [
        node('t', 'flowforge.trigger_manual'),
        node('h', 'flowforge.http', {
          url: 'https://api.example.com',
          method: 'GET',
          headers: { Authorization: 'Bearer sk-live-abcdefghijklmnop' },
        }),
      ],
      [edge('t', 'payload', 'h', 'body')],
    );
    const suggestions = analyzeWorkflow(wf, registry);
    expect(suggestions[0].severity).toBe('critical');
    expect(suggestions[0].title).toContain('hard-coded');
  });

  it('suggests an empty-result branch for retrieval', () => {
    const wf = graph(
      [
        node('t', 'flowforge.trigger_manual'),
        node('s', 'flowforge.vector_search', { collection: 'c', minScore: 0 }),
      ],
      [edge('t', 'payload', 's', 'query')],
    );
    const ids = analyzeWorkflow(wf, registry).map((s) => s.id);
    expect(ids).toContain('quality:no-empty-branch:s');
    expect(ids).toContain('quality:minScore:s');
  });

  it('applies an automatic fix without mutating the original', () => {
    const wf = graph([node('a', 'flowforge.llm', { temperature: 1.9 })]);
    const fixed = applyFix(wf, {
      kind: 'setConfig',
      nodeId: 'a',
      patch: { temperature: 0.7 },
    });
    expect(fixed.nodes[0].config.temperature).toBe(0.7);
    expect(wf.nodes[0].config.temperature).toBe(1.9);
  });

  it('measures critical-path depth', () => {
    const wf = graph(
      [
        node('a', 'flowforge.json', { operation: 'parse' }),
        node('b', 'flowforge.json', { operation: 'parse' }),
        node('c', 'flowforge.json', { operation: 'parse' }),
      ],
      [edge('a', 'value', 'b', 'value'), edge('b', 'value', 'c', 'value')],
    );
    expect(longestPath(wf)).toBe(3);
  });
});

describe('store patch semantics', () => {
  it('ignores undefined keys instead of wiping stored values', async () => {
    const store = new MemoryStore();
    const now = new Date().toISOString();
    await store.createWorkflow(
      {
        id: 'w1',
        name: 'Keep me',
        description: 'Original',
        ownerId: 'u1',
        tags: ['a'],
        createdAt: now,
        updatedAt: now,
        draftVersion: 1,
      },
      graph([node('t', 'flowforge.trigger_manual')]),
    );

    // A patch assembled from optional request fields carries explicit undefineds.
    const updated = await store.updateWorkflow('w1', {
      name: undefined,
      description: undefined,
      tags: undefined,
    });

    expect(updated.name).toBe('Keep me');
    expect(updated.description).toBe('Original');
    expect(updated.tags).toEqual(['a']);

    const renamed = await store.updateWorkflow('w1', { name: 'Renamed' });
    expect(renamed.name).toBe('Renamed');
    expect(renamed.description).toBe('Original');
  });
});
