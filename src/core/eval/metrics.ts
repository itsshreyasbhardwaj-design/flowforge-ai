import type { RunTrace } from '../runtime/events';
import type { EvalCase } from '../store/types';

export interface MetricContext {
  testCase: EvalCase;
  output: unknown;
  trace: RunTrace;
}

export interface Metric {
  id: string;
  label: string;
  description: string;
  /** Higher is better for `score`; for `cost`/`latency` lower is better. */
  direction: 'higher' | 'lower';
  unit?: string;
  /** Returns a number, or `null` when the metric does not apply to a case. */
  evaluate(ctx: MetricContext): number | null | Promise<number | null>;
}

function flatten(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    const values = Object.values(value as Record<string, unknown>);
    // A single-key output object is the common case; unwrap it so `exactMatch`
    // compares the value a user actually cares about.
    if (values.length === 1) return flatten(values[0]);
    return JSON.stringify(value);
  }
  return String(value);
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s]/g, '')
    .trim();
}

function tokenize(text: string): string[] {
  return normalize(text).split(' ').filter(Boolean);
}

export const exactMatch: Metric = {
  id: 'exactMatch',
  label: 'Exact match',
  description: 'Output equals the expected value after whitespace and case normalisation.',
  direction: 'higher',
  evaluate({ testCase, output }) {
    if (testCase.expected === undefined) return null;
    return normalize(flatten(output)) === normalize(flatten(testCase.expected)) ? 1 : 0;
  },
};

export const containsExpected: Metric = {
  id: 'contains',
  label: 'Contains expected',
  description: 'Output contains the expected string.',
  direction: 'higher',
  evaluate({ testCase, output }) {
    if (testCase.expected === undefined) return null;
    return normalize(flatten(output)).includes(normalize(flatten(testCase.expected))) ? 1 : 0;
  },
};

/**
 * Token-level F1 against the expected answer — the standard partial-credit
 * measure for extractive QA. More forgiving than exact match, far more
 * informative than "contains".
 */
export const tokenF1: Metric = {
  id: 'tokenF1',
  label: 'Token F1',
  description: 'Harmonic mean of token precision and recall against the expected answer.',
  direction: 'higher',
  evaluate({ testCase, output }) {
    if (testCase.expected === undefined) return null;
    const predicted = tokenize(flatten(output));
    const expected = tokenize(flatten(testCase.expected));
    if (predicted.length === 0 || expected.length === 0) {
      return predicted.length === expected.length ? 1 : 0;
    }

    const expectedCounts = new Map<string, number>();
    for (const token of expected) {
      expectedCounts.set(token, (expectedCounts.get(token) ?? 0) + 1);
    }

    let overlap = 0;
    for (const token of predicted) {
      const remaining = expectedCounts.get(token) ?? 0;
      if (remaining > 0) {
        overlap++;
        expectedCounts.set(token, remaining - 1);
      }
    }
    if (overlap === 0) return 0;

    const precision = overlap / predicted.length;
    const recall = overlap / expected.length;
    return Number(((2 * precision * recall) / (precision + recall)).toFixed(4));
  },
};

export const taskCompletion: Metric = {
  id: 'taskCompletion',
  label: 'Task completion',
  description: 'The run finished successfully and produced a non-empty output.',
  direction: 'higher',
  evaluate({ trace, output }) {
    if (trace.status !== 'succeeded') return 0;
    return flatten(output).trim().length > 0 ? 1 : 0;
  },
};

export const latencyMs: Metric = {
  id: 'latencyMs',
  label: 'Latency',
  description: 'Wall-clock duration of the run.',
  direction: 'lower',
  unit: 'ms',
  evaluate({ trace }) {
    return trace.durationMs ?? 0;
  },
};

export const costUsd: Metric = {
  id: 'costUsd',
  label: 'Cost',
  description: 'Total model spend for the run.',
  direction: 'lower',
  unit: 'USD',
  evaluate({ trace }) {
    return trace.usage.costUsd ?? 0;
  },
};

export const totalTokens: Metric = {
  id: 'totalTokens',
  label: 'Tokens',
  description: 'Prompt plus completion tokens across every model call.',
  direction: 'lower',
  unit: 'tokens',
  evaluate({ trace }) {
    return trace.usage.totalTokens ?? 0;
  },
};

/**
 * Structural proxy for reasoning quality: rewards runs that actually used their
 * retrieval and tool steps rather than answering from the model alone, and
 * penalises retries and errors.
 *
 * This is a heuristic, not a judge. For graded reasoning quality, register an
 * LLM-as-judge metric — see `docs/evaluation.md`.
 */
export const reasoningDepth: Metric = {
  id: 'reasoningDepth',
  label: 'Reasoning depth',
  description: 'Heuristic over executed steps, retries, and errors.',
  direction: 'higher',
  evaluate({ trace }) {
    const nodes = Object.values(trace.nodes);
    if (nodes.length === 0) return 0;
    const executed = nodes.filter((n) => n.status === 'succeeded').length;
    const failed = nodes.filter((n) => n.status === 'failed').length;
    const retries = nodes.reduce((sum, n) => sum + Math.max(0, n.attempts - 1), 0);
    const coverage = executed / nodes.length;
    const penalty = Math.min(0.6, failed * 0.3 + retries * 0.1);
    return Number(Math.max(0, coverage - penalty).toFixed(4));
  },
};

export const BUILTIN_METRICS: Metric[] = [
  exactMatch,
  containsExpected,
  tokenF1,
  taskCompletion,
  reasoningDepth,
  latencyMs,
  costUsd,
  totalTokens,
];

export class MetricRegistry {
  private readonly metrics = new Map<string, Metric>();

  constructor(metrics: Metric[] = BUILTIN_METRICS) {
    for (const metric of metrics) this.register(metric);
  }

  register(metric: Metric): this {
    this.metrics.set(metric.id, metric);
    return this;
  }

  get(id: string): Metric | undefined {
    return this.metrics.get(id);
  }

  list(): Metric[] {
    return [...this.metrics.values()];
  }

  resolve(ids: string[]): Metric[] {
    return ids.map((id) => this.metrics.get(id)).filter((m): m is Metric => Boolean(m));
  }
}
