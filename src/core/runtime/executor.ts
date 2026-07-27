import { validateWorkflow } from '../graph/validate';
import {
  DEFAULT_NODE_POLICY,
  isSecretRef,
  type NodePolicy,
  type Workflow,
  type WorkflowNode,
} from '../graph/types';
import type {
  LogEntry,
  LogLevel,
  NodeContext,
  NodeDefinition,
  NodeResult,
  UsageReport,
} from '../registry/definition';
import type { NodeRegistry } from '../registry/registry';
import { resolveConfig, type ExpressionScope } from './expression';
import {
  emptyUsage,
  mergeUsage,
  reduceTrace,
  serializeError,
  type RunTrace,
  type TraceEvent,
} from './events';
import { EnvSecretVault, redact, truncateForTrace, type SecretVault } from './secrets';

export class WorkflowValidationError extends Error {
  constructor(public readonly issues: { message: string; nodeId?: string }[]) {
    super(`Workflow is not runnable:\n${issues.map((i) => `  • ${i.message}`).join('\n')}`);
    this.name = 'WorkflowValidationError';
  }
}

export class NodeTimeoutError extends Error {
  constructor(nodeId: string, ms: number) {
    super(`Node "${nodeId}" exceeded its ${ms}ms timeout`);
    this.name = 'NodeTimeoutError';
  }
}

export class RunCancelledError extends Error {
  constructor() {
    super('Run was cancelled');
    this.name = 'RunCancelledError';
  }
}

export class MaxDepthExceededError extends Error {
  constructor(depth: number) {
    super(`Sub-workflow nesting exceeded the maximum depth of ${depth}`);
    this.name = 'MaxDepthExceededError';
  }
}

export interface ExecutorOptions {
  registry: NodeRegistry;
  vault?: SecretVault;
  /** Required for `loop` / `parallel` / `subflow` nodes to resolve their targets. */
  loadWorkflow?: (workflowId: string) => Promise<Workflow>;
  /** Injected for deterministic tests. */
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  maxDepth?: number;
  /** Cap on how much of any single value is written into the trace. */
  maxTraceBytes?: number;
}

export interface RunOptions {
  runId?: string;
  input?: unknown;
  signal?: AbortSignal;
  depth?: number;
  trigger?: RunTrace['trigger'];
  workflowVersion?: number;
}

type EdgeState = 'pending' | 'delivered' | 'skipped';
type NodeState = 'pending' | 'running' | 'done' | 'skipped' | 'failed';

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new RunCancelledError());
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new RunCancelledError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/**
 * The scheduler.
 *
 * Execution is event-driven rather than layer-by-layer: a node becomes runnable
 * the instant every inbound edge has resolved (delivered *or* skipped), so
 * independent branches overlap naturally and a slow node never blocks a sibling.
 *
 * Branching needs no special cases. A node result simply omits the output ports
 * it did not activate; edges leaving those ports are marked `skipped`, and a node
 * whose inbound edges are all skipped is itself skipped, transitively. That single
 * rule implements `if`, `switch`, guard clauses, and error routing.
 */
export class WorkflowExecutor {
  private readonly registry: NodeRegistry;
  private readonly vault: SecretVault;
  private readonly loadWorkflow?: (id: string) => Promise<Workflow>;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly maxDepth: number;
  private readonly maxTraceBytes: number;

  constructor(options: ExecutorOptions) {
    this.registry = options.registry;
    this.vault = options.vault ?? new EnvSecretVault();
    this.loadWorkflow = options.loadWorkflow;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? defaultSleep;
    this.maxDepth = options.maxDepth ?? 5;
    this.maxTraceBytes = options.maxTraceBytes ?? 32_000;
  }

  /** Run to completion, returning the folded trace. */
  async execute(workflow: Workflow, options: RunOptions = {}): Promise<RunTrace> {
    let trace: RunTrace | undefined;
    for await (const event of this.run(workflow, options)) {
      trace = reduceTrace(trace, event);
    }
    if (!trace) throw new Error('Executor produced no events');
    return trace;
  }

  /**
   * Stream trace events as the run progresses. The API layer pipes this straight
   * to SSE; the debugger folds it with the same `reduceTrace` used server-side.
   */
  async *run(workflow: Workflow, options: RunOptions = {}): AsyncGenerator<TraceEvent> {
    const queue: TraceEvent[] = [];
    let wake: (() => void) | null = null;
    let finished = false;

    const emit = (event: TraceEvent): void => {
      queue.push(event);
      const w = wake;
      wake = null;
      w?.();
    };

    const driver = this.drive(workflow, options, emit).finally(() => {
      finished = true;
      const w = wake;
      wake = null;
      w?.();
    });
    // The driver never rejects (failures become `run.finished` events), but guard
    // against an unhandled rejection if that invariant is ever broken.
    driver.catch(() => {});

    while (true) {
      while (queue.length) yield queue.shift()!;
      if (finished) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
    await driver;
  }

  private async drive(
    workflow: Workflow,
    options: RunOptions,
    emit: (event: TraceEvent) => void,
  ): Promise<void> {
    const runId = options.runId ?? `run_${Math.random().toString(36).slice(2, 12)}`;
    const depth = options.depth ?? 0;
    const startedAt = this.now();

    emit({
      kind: 'run.started',
      runId,
      workflowId: workflow.id,
      at: startedAt,
      input: this.forTrace(options.input, []),
    });

    const finish = (
      status: RunTrace['status'],
      output: Record<string, unknown>,
      usage: UsageReport,
      error?: unknown,
    ): void => {
      const at = this.now();
      emit({
        kind: 'run.finished',
        runId,
        at,
        status,
        durationMs: at - startedAt,
        output,
        usage,
        error: error === undefined ? undefined : serializeError(error),
      });
    };

    if (depth > this.maxDepth) {
      finish('failed', {}, emptyUsage(), new MaxDepthExceededError(this.maxDepth));
      return;
    }

    const validation = validateWorkflow(workflow, this.registry);
    if (!validation.valid) {
      finish('failed', {}, emptyUsage(), new WorkflowValidationError(validation.errors));
      return;
    }

    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onExternalAbort, { once: true });
    if (options.signal?.aborted) controller.abort();

    const nodeState = new Map<string, NodeState>(workflow.nodes.map((n) => [n.id, 'pending']));
    const edgeState = new Map<string, EdgeState>(workflow.edges.map((e) => [e.id, 'pending']));
    /** Values delivered to a node, keyed by target port. Later writes win. */
    const delivered = new Map<string, Record<string, unknown>>();
    const nodeOutputs: Record<string, { output: Record<string, unknown> }> = {};
    const runState = new Map<string, unknown>();
    // Trigger nodes read the run payload from state rather than an input port,
    // since by definition they have none.
    runState.set('__runInput', options.input);
    const usedSecrets = new Set<string>();
    let totalUsage = emptyUsage();

    const inboundByNode = new Map<string, typeof workflow.edges>();
    const outboundByNode = new Map<string, typeof workflow.edges>();
    for (const node of workflow.nodes) {
      inboundByNode.set(node.id, []);
      outboundByNode.set(node.id, []);
    }
    for (const edge of workflow.edges) {
      inboundByNode.get(edge.target)?.push(edge);
      outboundByNode.get(edge.source)?.push(edge);
    }

    const scope = (): ExpressionScope => ({
      input: options.input,
      nodes: nodeOutputs,
      vars: workflow.variables ?? {},
      run: { runId, workflowId: workflow.id, now: new Date(this.now()).toISOString(), depth },
    });

    const skipNode = (nodeId: string, reason: string): void => {
      if (nodeState.get(nodeId) !== 'pending') return;
      nodeState.set(nodeId, 'skipped');
      emit({ kind: 'node.skipped', runId, nodeId, at: this.now(), reason });
      for (const edge of outboundByNode.get(nodeId) ?? []) {
        if (edgeState.get(edge.id) === 'pending') {
          edgeState.set(edge.id, 'skipped');
          emit({ kind: 'edge.skipped', runId, edgeId: edge.id, at: this.now() });
        }
      }
    };

    /** `ready` when every inbound edge has resolved; `skip` when it can never run. */
    const readiness = (node: WorkflowNode): 'ready' | 'blocked' | 'skip' => {
      if (node.disabled) return 'skip';
      const inbound = inboundByNode.get(node.id) ?? [];
      if (inbound.some((e) => edgeState.get(e.id) === 'pending')) return 'blocked';
      if (inbound.length > 0 && inbound.every((e) => edgeState.get(e.id) === 'skipped')) {
        return 'skip';
      }

      const def = this.registry.tryGet(node.type);
      if (!def) return 'skip';
      const values = delivered.get(node.id) ?? {};
      for (const port of def.inputs) {
        if (!port.required) continue;
        if (port.id in values) continue;
        if (node.config[port.id] !== undefined) continue;
        return 'skip';
      }
      return 'ready';
    };

    const running = new Map<string, Promise<void>>();
    const concurrency = Math.max(1, workflow.concurrency ?? 8);
    let fatalError: unknown;

    const executeNode = async (node: WorkflowNode): Promise<void> => {
      const def = this.registry.get(node.type) as unknown as NodeDefinition<unknown>;
      const policy: NodePolicy = {
        ...DEFAULT_NODE_POLICY,
        ...workflow.policy,
        ...node.policy,
      };
      const inputs = { ...(delivered.get(node.id) ?? {}) };
      const logs: LogEntry[] = [];
      let nodeUsage: UsageReport | undefined;

      const ctx: NodeContext = {
        runId,
        nodeId: node.id,
        workflowId: workflow.id,
        signal: controller.signal,
        depth,
        log: (level: LogLevel, message: string, data?: unknown) => {
          const entry: LogEntry = {
            level,
            message,
            data: data === undefined ? undefined : this.forTrace(data, [...usedSecrets]),
            at: this.now(),
          };
          logs.push(entry);
          emit({ kind: 'node.log', runId, nodeId: node.id, entry });
        },
        reportUsage: (usage: UsageReport) => {
          nodeUsage = mergeUsage(nodeUsage ?? emptyUsage(), usage);
        },
        emitPartial: (portId: string, chunk: unknown) => {
          emit({ kind: 'node.partial', runId, nodeId: node.id, at: this.now(), portId, chunk });
        },
        getSecret: async (key: string) => {
          const value = await this.vault.get(key);
          if (value) usedSecrets.add(value);
          return value;
        },
        state: {
          get: <T = unknown>(key: string) => runState.get(key) as T | undefined,
          set: (key: string, value: unknown) => void runState.set(key, value),
          keys: () => [...runState.keys()],
        },
        providers: {
          llm: (name?: string) => this.registry.llm(name),
          embedding: (name?: string) => this.registry.embedding(name),
          vector: (name?: string) => this.registry.vector(name),
        },
        invoke: async (workflowId: string, input: unknown) => {
          if (!this.loadWorkflow) {
            throw new Error(
              'This executor was created without `loadWorkflow`, so sub-workflows cannot be resolved.',
            );
          }
          const child = await this.loadWorkflow(workflowId);
          const childTrace = await this.execute(child, {
            input,
            signal: controller.signal,
            depth: depth + 1,
            trigger: options.trigger,
          });
          totalUsage = mergeUsage(totalUsage, childTrace.usage);
          if (childTrace.status === 'failed') {
            throw new Error(
              `Sub-workflow "${child.name}" failed: ${childTrace.error?.message ?? 'unknown error'}`,
            );
          }
          return childTrace.output;
        },
      };

      const { config, resolved } = await this.prepareConfig(node, def, scope(), usedSecrets);

      // Validation accepts a config literal in place of an unconnected required
      // input, so execution has to honour the same rule — otherwise a workflow
      // passes validation and then fails at run time with a missing input.
      // An edge always wins over a literal.
      for (const port of def.inputs) {
        if (port.id in inputs) continue;
        const literal = (resolved as Record<string, unknown>)[port.id];
        if (literal !== undefined) inputs[port.id] = literal;
      }
      const maxAttempts = policy.retries + 1;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (controller.signal.aborted) throw new RunCancelledError();

        const attemptStart = this.now();
        emit({
          kind: 'node.started',
          runId,
          nodeId: node.id,
          at: attemptStart,
          attempt,
          inputs: this.forTrace(inputs, [...usedSecrets]) as Record<string, unknown>,
        });

        try {
          const result = await this.withTimeout(
            () => def.execute({ config, inputs, ctx }),
            policy.timeoutMs,
            node.id,
            controller.signal,
          );
          const finishedAt = this.now();
          const usage = nodeUsage ? mergeUsage(nodeUsage, result.usage) : result.usage;
          totalUsage = mergeUsage(totalUsage, usage);
          result.logs?.forEach((entry) => {
            emit({ kind: 'node.log', runId, nodeId: node.id, entry });
          });

          nodeOutputs[node.id] = { output: result.outputs };
          nodeState.set(node.id, 'done');
          emit({
            kind: 'node.finished',
            runId,
            nodeId: node.id,
            at: finishedAt,
            durationMs: finishedAt - attemptStart,
            status: 'succeeded',
            outputs: this.forTrace(result.outputs, [...usedSecrets]) as Record<string, unknown>,
            usage,
            debug: result.debug,
          });
          this.deliver(node, result, outboundByNode, edgeState, delivered, emit, runId);
          return;
        } catch (error) {
          if (error instanceof RunCancelledError) throw error;
          const isLastAttempt = attempt === maxAttempts;
          if (!isLastAttempt) {
            const delayMs = policy.retryBackoffMs * 2 ** (attempt - 1);
            emit({
              kind: 'node.retrying',
              runId,
              nodeId: node.id,
              at: this.now(),
              attempt,
              delayMs,
              error: serializeError(error),
            });
            await this.sleep(delayMs, controller.signal);
            continue;
          }

          const finishedAt = this.now();
          const routed =
            policy.onError === 'route' && def.outputs.some((p) => p.id === 'error');

          nodeState.set(node.id, routed || policy.onError === 'continue' ? 'done' : 'failed');
          emit({
            kind: 'node.finished',
            runId,
            nodeId: node.id,
            at: finishedAt,
            durationMs: finishedAt - attemptStart,
            status: routed || policy.onError === 'continue' ? 'succeeded' : 'failed',
            error: serializeError(error, attempt),
            usage: nodeUsage,
          });

          if (routed) {
            const errorResult: NodeResult = {
              outputs: { error: serializeError(error, attempt) },
            };
            nodeOutputs[node.id] = { output: errorResult.outputs };
            this.deliver(node, errorResult, outboundByNode, edgeState, delivered, emit, runId);
            return;
          }
          if (policy.onError === 'continue') {
            nodeOutputs[node.id] = { output: {} };
            this.deliver(
              node,
              { outputs: {} },
              outboundByNode,
              edgeState,
              delivered,
              emit,
              runId,
            );
            return;
          }
          throw error;
        }
      }
    };

    try {
      while (true) {
        if (controller.signal.aborted) throw new RunCancelledError();

        let launched = false;
        for (const node of workflow.nodes) {
          if (running.size >= concurrency) break;
          if (nodeState.get(node.id) !== 'pending') continue;
          const state = readiness(node);
          if (state === 'skip') {
            skipNode(node.id, node.disabled ? 'Node is disabled' : 'Upstream branch not taken');
            launched = true;
            continue;
          }
          if (state !== 'ready') continue;

          nodeState.set(node.id, 'running');
          launched = true;
          const promise = executeNode(node)
            .catch((error: unknown) => {
              nodeState.set(node.id, 'failed');
              fatalError ??= error;
              controller.abort();
            })
            .finally(() => void running.delete(node.id));
          running.set(node.id, promise);
        }

        if (running.size > 0) {
          await Promise.race(running.values());
          continue;
        }
        if (!launched) break;
      }

      await Promise.allSettled(running.values());

      if (fatalError) {
        const cancelled = fatalError instanceof RunCancelledError;
        finish(cancelled ? 'cancelled' : 'failed', {}, totalUsage, fatalError);
        return;
      }

      const output = this.collectOutput(workflow, nodeOutputs, nodeState);
      finish(
        'succeeded',
        this.forTrace(output, [...usedSecrets]) as Record<string, unknown>,
        totalUsage,
      );
    } catch (error) {
      await Promise.allSettled(running.values());
      // A node failure aborts the controller to stop its siblings, which then
      // surfaces here as a cancellation. The *first* recorded failure is the real
      // cause, so classify on that rather than on whatever unwound the loop.
      const cause = fatalError ?? error;
      finish(
        cause instanceof RunCancelledError ? 'cancelled' : 'failed',
        {},
        totalUsage,
        cause,
      );
    } finally {
      options.signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  /** Mark outbound edges delivered or skipped based on which ports the node activated. */
  private deliver(
    node: WorkflowNode,
    result: NodeResult,
    outboundByNode: Map<string, Workflow['edges']>,
    edgeState: Map<string, EdgeState>,
    delivered: Map<string, Record<string, unknown>>,
    emit: (event: TraceEvent) => void,
    runId: string,
  ): void {
    for (const edge of outboundByNode.get(node.id) ?? []) {
      const activated = Object.prototype.hasOwnProperty.call(result.outputs, edge.sourcePort);
      if (activated) {
        edgeState.set(edge.id, 'delivered');
        const bucket = delivered.get(edge.target) ?? {};
        bucket[edge.targetPort] = result.outputs[edge.sourcePort];
        delivered.set(edge.target, bucket);
        emit({ kind: 'edge.activated', runId, edgeId: edge.id, at: this.now() });
      } else {
        edgeState.set(edge.id, 'skipped');
        emit({ kind: 'edge.skipped', runId, edgeId: edge.id, at: this.now() });
      }
    }
  }

  /**
   * Resolve `{{ }}` expressions, inject secrets, then validate against the node's
   * schema. Validation happens *after* resolution so a templated field is checked
   * against its real runtime value, not the template string.
   */
  private async prepareConfig(
    node: WorkflowNode,
    def: NodeDefinition<unknown>,
    scope: ExpressionScope,
    usedSecrets: Set<string>,
  ): Promise<{ config: unknown; resolved: unknown }> {
    const resolved = await this.injectSecrets(resolveConfig(node.config, scope), usedSecrets);
    const parsed = def.configSchema.safeParse(resolved);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ');
      throw new Error(`Invalid configuration for "${def.label}" — ${detail}`);
    }
    // `resolved` is returned alongside the parsed config because Zod strips keys
    // the schema does not declare — including port-name literals, which are not
    // config fields but still need to reach the node as inputs.
    return { config: parsed.data, resolved };
  }

  private async injectSecrets(value: unknown, used: Set<string>): Promise<unknown> {
    if (isSecretRef(value)) {
      const secret = await this.vault.get(value.$secret);
      if (secret) used.add(secret);
      return secret;
    }
    if (Array.isArray(value)) {
      return Promise.all(value.map((item) => this.injectSecrets(item, used)));
    }
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        out[key] = await this.injectSecrets(val, used);
      }
      return out;
    }
    return value;
  }

  private async withTimeout<T>(
    fn: () => Promise<T>,
    timeoutMs: number,
    nodeId: string,
    signal: AbortSignal,
  ): Promise<T> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return fn();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        fn(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new NodeTimeoutError(nodeId, timeoutMs)), timeoutMs);
          signal.addEventListener('abort', () => reject(new RunCancelledError()), {
            once: true,
          });
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * The run's return value. Nodes in the `output` category define the contract;
   * if a workflow declares none, every leaf node's outputs are returned keyed by id.
   */
  private collectOutput(
    workflow: Workflow,
    nodeOutputs: Record<string, { output: Record<string, unknown> }>,
    nodeState: Map<string, NodeState>,
  ): Record<string, unknown> {
    const outputNodes = workflow.nodes.filter(
      (n) => this.registry.tryGet(n.type)?.category === 'output',
    );
    const source = outputNodes.length
      ? outputNodes
      : workflow.nodes.filter((n) => !workflow.edges.some((e) => e.source === n.id));

    const result: Record<string, unknown> = {};
    for (const node of source) {
      if (nodeState.get(node.id) !== 'done') continue;
      const outputs = nodeOutputs[node.id]?.output ?? {};
      const key = node.label ?? node.id;
      result[key] = Object.keys(outputs).length === 1 ? Object.values(outputs)[0] : outputs;
    }
    return result;
  }

  private forTrace(value: unknown, secrets: string[]): unknown {
    return truncateForTrace(redact(value, secrets), this.maxTraceBytes);
  }
}
