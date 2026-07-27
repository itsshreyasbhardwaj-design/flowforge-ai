import { describe, expect, it } from 'vitest';
import { WorkflowExecutor } from '@/core/runtime/executor';
import type { TraceEvent } from '@/core/runtime/events';
import { echoNode, edge, flakyNode, graph, node, testRegistry, trackerNode } from './helpers';

describe('WorkflowExecutor', () => {
  it('runs a linear graph and threads values through edges', async () => {
    const registry = testRegistry([echoNode as never]);
    const executor = new WorkflowExecutor({ registry });

    const workflow = graph(
      [
        node('trigger', 'flowforge.trigger_manual'),
        node('a', 'test.echo'),
        node('out', 'flowforge.output', { name: 'result' }),
      ],
      [edge('trigger', 'payload', 'a', 'value'), edge('a', 'value', 'out', 'value')],
    );

    const trace = await executor.execute(workflow, { input: { hello: 'world' } });

    expect(trace.status).toBe('succeeded');
    expect(trace.nodes.a.status).toBe('succeeded');
    expect(trace.nodes.a.outputs?.value).toEqual({ hello: 'world' });
    expect(trace.output).toEqual({ out: { hello: 'world' } });
  });

  it('skips the branch a condition did not take, transitively', async () => {
    const registry = testRegistry([echoNode as never]);
    const executor = new WorkflowExecutor({ registry });

    const workflow = graph(
      [
        node('trigger', 'flowforge.trigger_manual'),
        node('cond', 'flowforge.condition', { operator: 'equals', right: 'yes' }),
        node('taken', 'test.echo'),
        node('untaken', 'test.echo'),
        node('downstream', 'test.echo'),
      ],
      [
        edge('trigger', 'payload', 'cond', 'value'),
        edge('cond', 'true', 'taken', 'value'),
        edge('cond', 'false', 'untaken', 'value'),
        edge('untaken', 'value', 'downstream', 'value'),
      ],
    );

    const trace = await executor.execute(workflow, { input: 'yes' });

    expect(trace.status).toBe('succeeded');
    expect(trace.nodes.taken.status).toBe('succeeded');
    expect(trace.nodes.untaken.status).toBe('skipped');
    // The skip must propagate past the immediate child.
    expect(trace.nodes.downstream.status).toBe('skipped');
  });

  it('runs independent branches concurrently', async () => {
    const log: string[] = [];
    const registry = testRegistry([trackerNode(log, 25) as never, echoNode as never]);
    const executor = new WorkflowExecutor({ registry });

    const workflow = graph(
      [
        node('trigger', 'flowforge.trigger_manual'),
        node('fan', 'flowforge.parallel', { branches: 2 }),
        node('left', 'test.tracker', { tag: 'left' }),
        node('right', 'test.tracker', { tag: 'right' }),
      ],
      [
        edge('trigger', 'payload', 'fan', 'value'),
        edge('fan', 'a', 'left', 'value'),
        edge('fan', 'b', 'right', 'value'),
      ],
      { concurrency: 4 },
    );

    await executor.execute(workflow, { input: 1 });

    // Both start before either finishes — proof they overlapped rather than queued.
    expect(log.slice(0, 2).sort()).toEqual(['start:left', 'start:right']);
  });

  it('honours the concurrency ceiling', async () => {
    const log: string[] = [];
    const registry = testRegistry([trackerNode(log, 15) as never]);
    const executor = new WorkflowExecutor({ registry });

    const workflow = graph(
      [
        node('trigger', 'flowforge.trigger_manual'),
        node('n1', 'test.tracker', { tag: '1' }),
        node('n2', 'test.tracker', { tag: '2' }),
        node('n3', 'test.tracker', { tag: '3' }),
      ],
      [
        edge('trigger', 'payload', 'n1', 'value'),
        edge('trigger', 'payload', 'n2', 'value'),
        edge('trigger', 'payload', 'n3', 'value'),
      ],
      { concurrency: 1 },
    );

    await executor.execute(workflow, { input: 1 });

    // With concurrency 1 every node must fully finish before the next starts.
    for (let i = 0; i < log.length; i += 2) {
      expect(log[i].startsWith('start:')).toBe(true);
      expect(log[i + 1]).toBe(log[i].replace('start:', 'end:'));
    }
  });

  it('retries a failing node with backoff and then succeeds', async () => {
    const flaky = flakyNode();
    const registry = testRegistry([flaky.definition as never]);
    const slept: number[] = [];
    const executor = new WorkflowExecutor({
      registry,
      sleep: async (ms) => void slept.push(ms),
    });

    const workflow = graph([
      node(
        'f',
        'test.flaky',
        { failTimes: 2 },
        { policy: { retries: 3, retryBackoffMs: 100 } },
      ),
    ]);

    const trace = await executor.execute(workflow, {});

    expect(trace.status).toBe('succeeded');
    expect(flaky.attempts()).toBe(3);
    expect(slept).toEqual([100, 200]);
  });

  it('fails the run when retries are exhausted', async () => {
    const flaky = flakyNode();
    const registry = testRegistry([flaky.definition as never]);
    const executor = new WorkflowExecutor({ registry, sleep: async () => {} });

    const workflow = graph([
      node('f', 'test.flaky', { failTimes: 99 }, { policy: { retries: 1 } }),
    ]);

    const trace = await executor.execute(workflow, {});

    expect(trace.status).toBe('failed');
    expect(trace.nodes.f.status).toBe('failed');
    expect(trace.error?.message).toContain('boom');
  });

  it('routes errors to the error port when the policy says so', async () => {
    const flaky = flakyNode();
    const registry = testRegistry([flaky.definition as never, echoNode as never]);
    const executor = new WorkflowExecutor({ registry, sleep: async () => {} });

    const workflow = graph(
      [
        node('f', 'test.flaky', { failTimes: 99 }, { policy: { onError: 'route' } }),
        node('handler', 'test.echo'),
      ],
      [edge('f', 'error', 'handler', 'value')],
    );

    const trace = await executor.execute(workflow, {});

    expect(trace.status).toBe('succeeded');
    expect(trace.nodes.handler.status).toBe('succeeded');
    expect((trace.nodes.handler.outputs?.value as { message: string }).message).toContain(
      'boom',
    );
  });

  it('enforces the per-node timeout', async () => {
    const registry = testRegistry([trackerNode([], 200) as never]);
    const executor = new WorkflowExecutor({ registry });

    const workflow = graph([
      node('slow', 'test.tracker', { tag: 'slow' }, { policy: { timeoutMs: 20 } }),
    ]);

    const trace = await executor.execute(workflow, {});

    expect(trace.status).toBe('failed');
    expect(trace.error?.message).toContain('timeout');
  });

  it('cancels an in-flight run', async () => {
    const registry = testRegistry([trackerNode([], 500) as never]);
    const executor = new WorkflowExecutor({ registry });
    const controller = new AbortController();

    const workflow = graph([node('slow', 'test.tracker', { tag: 'slow' })]);
    const promise = executor.execute(workflow, { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);

    const trace = await promise;
    expect(trace.status).toBe('cancelled');
  });

  it('refuses to run an invalid workflow', async () => {
    const registry = testRegistry();
    const executor = new WorkflowExecutor({ registry });

    const workflow = graph([node('mystery', 'does.not.exist')]);
    const trace = await executor.execute(workflow, {});

    expect(trace.status).toBe('failed');
    expect(trace.error?.message).toContain('Unknown node type');
  });

  it('rejects cycles rather than looping forever', async () => {
    const registry = testRegistry([echoNode as never]);
    const executor = new WorkflowExecutor({ registry });

    const workflow = graph(
      [node('a', 'test.echo'), node('b', 'test.echo')],
      [edge('a', 'value', 'b', 'value'), edge('b', 'value', 'a', 'value')],
    );

    const trace = await executor.execute(workflow, {});
    expect(trace.status).toBe('failed');
    expect(trace.error?.message).toContain('acyclic');
  });

  it('resolves expressions against upstream node outputs', async () => {
    const registry = testRegistry([echoNode as never]);
    const executor = new WorkflowExecutor({ registry });

    const workflow = graph(
      [
        node('src', 'test.echo', { constant: { name: 'Ada' } }),
        node('fn', 'flowforge.function', {
          code: 'return { value: "hello " + input };',
        }),
      ],
      [],
    );
    // The function node reads the upstream value purely through an expression.
    workflow.nodes[1].config.code = 'return { value: "hello " + input };';
    workflow.edges.push(edge('src', 'value', 'fn', 'input'));

    const trace = await executor.execute(workflow, {});
    expect(trace.status).toBe('succeeded');
    expect(trace.nodes.fn.outputs?.value).toBe('hello [object Object]');
  });

  it('streams trace events in order', async () => {
    const registry = testRegistry([echoNode as never]);
    const executor = new WorkflowExecutor({ registry });
    const workflow = graph([node('a', 'test.echo', { constant: 1 })]);

    const events: TraceEvent[] = [];
    for await (const event of executor.run(workflow, {})) events.push(event);

    expect(events[0].kind).toBe('run.started');
    expect(events.at(-1)?.kind).toBe('run.finished');
    expect(events.some((e) => e.kind === 'node.started')).toBe(true);
    expect(events.some((e) => e.kind === 'node.finished')).toBe(true);
  });

  it('invokes sub-workflows and rolls their usage into the parent', async () => {
    const registry = testRegistry([echoNode as never]);
    const child = graph([node('inner', 'flowforge.output', { name: 'value' })], [], {
      id: 'wf_child',
    });
    child.nodes[0].config = { name: 'value' };
    child.nodes.unshift(node('t', 'flowforge.trigger_manual'));
    child.edges.push(edge('t', 'payload', 'inner', 'value'));

    const executor = new WorkflowExecutor({
      registry,
      loadWorkflow: async () => child,
    });

    const parent = graph(
      [
        node('trigger', 'flowforge.trigger_manual'),
        node('sub', 'flowforge.subflow', { workflowId: 'wf_child' }),
      ],
      [edge('trigger', 'payload', 'sub', 'input')],
    );

    const trace = await executor.execute(parent, { input: { n: 7 } });

    expect(trace.status).toBe('succeeded');
    expect(trace.nodes.sub.outputs?.output).toEqual({ inner: { n: 7 } });
  });

  it('stops runaway sub-workflow recursion', async () => {
    const registry = testRegistry();
    const selfReferential = graph(
      [
        node('trigger', 'flowforge.trigger_manual'),
        node('sub', 'flowforge.subflow', { workflowId: 'wf_loop' }),
      ],
      [edge('trigger', 'payload', 'sub', 'input')],
      { id: 'wf_loop' },
    );

    const executor = new WorkflowExecutor({
      registry,
      maxDepth: 2,
      loadWorkflow: async () => selfReferential,
    });

    const trace = await executor.execute(selfReferential, { input: 1 });
    expect(trace.status).toBe('failed');
  });

  it('redacts secret values from the trace', async () => {
    const registry = testRegistry([echoNode as never]);
    const executor = new WorkflowExecutor({
      registry,
      vault: { get: async (key) => (key === 'MY_KEY' ? 'super-secret-value' : undefined) },
    });

    const workflow = graph([
      node('a', 'test.echo', { constant: { token: { $secret: 'MY_KEY' } } }),
    ]);

    const trace = await executor.execute(workflow, {});
    const serialized = JSON.stringify(trace);

    expect(trace.status).toBe('succeeded');
    expect(serialized).not.toContain('super-secret-value');
  });
});
