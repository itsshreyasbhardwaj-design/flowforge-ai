import type { LogEntry, UsageReport } from '../registry/definition';

export type RunStatus =
  'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'suspended';

export type NodeStatus =
  'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled' | 'suspended';

export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
  /** Set when the node exhausted its retry budget. */
  attempts?: number;
  code?: string;
}

export type TraceEvent =
  | { kind: 'run.started'; runId: string; workflowId: string; at: number; input: unknown }
  | {
      kind: 'run.finished';
      runId: string;
      at: number;
      status: RunStatus;
      durationMs: number;
      output: Record<string, unknown>;
      usage: UsageReport;
      error?: SerializedError;
    }
  | {
      kind: 'node.started';
      runId: string;
      nodeId: string;
      at: number;
      attempt: number;
      inputs: Record<string, unknown>;
    }
  | {
      kind: 'node.finished';
      runId: string;
      nodeId: string;
      at: number;
      durationMs: number;
      status: NodeStatus;
      outputs?: Record<string, unknown>;
      usage?: UsageReport;
      error?: SerializedError;
      debug?: Record<string, unknown>;
    }
  | { kind: 'node.skipped'; runId: string; nodeId: string; at: number; reason: string }
  | {
      kind: 'node.retrying';
      runId: string;
      nodeId: string;
      at: number;
      attempt: number;
      delayMs: number;
      error: SerializedError;
    }
  | {
      kind: 'node.partial';
      runId: string;
      nodeId: string;
      at: number;
      portId: string;
      chunk: unknown;
    }
  | { kind: 'node.log'; runId: string; nodeId: string; entry: LogEntry }
  | { kind: 'edge.activated'; runId: string; edgeId: string; at: number }
  | { kind: 'edge.skipped'; runId: string; edgeId: string; at: number };

export interface NodeTrace {
  nodeId: string;
  status: NodeStatus;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  attempts: number;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  usage?: UsageReport;
  logs: LogEntry[];
  error?: SerializedError;
  debug?: Record<string, unknown>;
  skipReason?: string;
}

export interface RunTrace {
  runId: string;
  workflowId: string;
  workflowVersion?: number;
  status: RunStatus;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  input: unknown;
  output: Record<string, unknown>;
  usage: UsageReport;
  nodes: Record<string, NodeTrace>;
  /** Ordered node ids as they started — the debugger timeline reads this. */
  order: string[];
  error?: SerializedError;
  /** How the run was started. */
  trigger?: 'manual' | 'api' | 'webhook' | 'schedule' | 'test' | 'eval';
}

export function serializeError(error: unknown, attempts?: number): SerializedError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      attempts,
      code: (error as NodeJS.ErrnoException).code,
    };
  }
  return { name: 'Error', message: String(error), attempts };
}

export function emptyUsage(): UsageReport {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0 };
}

export function mergeUsage(base: UsageReport, next: UsageReport | undefined): UsageReport {
  if (!next) return base;
  return {
    ...base,
    promptTokens: (base.promptTokens ?? 0) + (next.promptTokens ?? 0),
    completionTokens: (base.completionTokens ?? 0) + (next.completionTokens ?? 0),
    totalTokens: (base.totalTokens ?? 0) + (next.totalTokens ?? 0),
    costUsd: Number(((base.costUsd ?? 0) + (next.costUsd ?? 0)).toFixed(8)),
  };
}

/**
 * Folds a stream of trace events into a `RunTrace`.
 *
 * The same reducer runs server-side (to persist the final trace) and in the
 * browser (to render the live debugger from an SSE stream), so what a user sees
 * mid-run is exactly what gets stored.
 */
export function reduceTrace(trace: RunTrace | undefined, event: TraceEvent): RunTrace {
  const base: RunTrace =
    trace ??
    ({
      runId: '',
      workflowId: '',
      status: 'queued',
      startedAt: Date.now(),
      input: undefined,
      output: {},
      usage: emptyUsage(),
      nodes: {},
      order: [],
    } satisfies RunTrace);

  const nodeOf = (nodeId: string): NodeTrace =>
    base.nodes[nodeId] ?? { nodeId, status: 'pending', attempts: 0, logs: [] };

  switch (event.kind) {
    case 'run.started':
      return {
        ...base,
        runId: event.runId,
        workflowId: event.workflowId,
        status: 'running',
        startedAt: event.at,
        input: event.input,
      };

    case 'run.finished':
      return {
        ...base,
        status: event.status,
        finishedAt: event.at,
        durationMs: event.durationMs,
        output: event.output,
        usage: event.usage,
        error: event.error,
      };

    case 'node.started': {
      const node = nodeOf(event.nodeId);
      return {
        ...base,
        order: base.order.includes(event.nodeId) ? base.order : [...base.order, event.nodeId],
        nodes: {
          ...base.nodes,
          [event.nodeId]: {
            ...node,
            status: 'running',
            startedAt: node.startedAt ?? event.at,
            attempts: event.attempt,
            inputs: event.inputs,
          },
        },
      };
    }

    case 'node.finished': {
      const node = nodeOf(event.nodeId);
      return {
        ...base,
        usage: mergeUsage(base.usage, event.usage),
        nodes: {
          ...base.nodes,
          [event.nodeId]: {
            ...node,
            status: event.status,
            finishedAt: event.at,
            durationMs: event.durationMs,
            outputs: event.outputs,
            usage: event.usage,
            error: event.error,
            debug: event.debug,
          },
        },
      };
    }

    case 'node.skipped':
      return {
        ...base,
        nodes: {
          ...base.nodes,
          [event.nodeId]: {
            ...nodeOf(event.nodeId),
            status: 'skipped',
            finishedAt: event.at,
            skipReason: event.reason,
          },
        },
      };

    case 'node.retrying': {
      const node = nodeOf(event.nodeId);
      return {
        ...base,
        nodes: {
          ...base.nodes,
          [event.nodeId]: {
            ...node,
            attempts: event.attempt,
            logs: [
              ...node.logs,
              {
                level: 'warn',
                message: `Attempt ${event.attempt} failed: ${event.error.message}. Retrying in ${event.delayMs}ms.`,
                at: event.at,
              },
            ],
          },
        },
      };
    }

    case 'node.log': {
      const node = nodeOf(event.nodeId);
      return {
        ...base,
        nodes: {
          ...base.nodes,
          [event.nodeId]: { ...node, logs: [...node.logs, event.entry] },
        },
      };
    }

    case 'node.partial': {
      const node = nodeOf(event.nodeId);
      const existing = node.outputs?.[event.portId];
      const merged =
        typeof existing === 'string' && typeof event.chunk === 'string'
          ? existing + event.chunk
          : event.chunk;
      return {
        ...base,
        nodes: {
          ...base.nodes,
          [event.nodeId]: { ...node, outputs: { ...node.outputs, [event.portId]: merged } },
        },
      };
    }

    default:
      return base;
  }
}
