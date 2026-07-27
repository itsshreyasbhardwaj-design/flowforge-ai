import type { Workflow } from '../graph/types';
import type { WorkflowExecutor } from '../runtime/executor';
import type { EvalCaseResult, EvalRun, EvalSuite } from '../store/types';
import { MetricRegistry, type Metric } from './metrics';

export interface EvalRunnerOptions {
  executor: WorkflowExecutor;
  metrics?: MetricRegistry;
  /** How many cases to run at once. */
  concurrency?: number;
  signal?: AbortSignal;
  now?: () => number;
  idFactory?: () => string;
}

export interface RunSuiteOptions {
  suite: EvalSuite;
  graph: Workflow;
  version: number;
  label?: string;
  onProgress?: (completed: number, total: number) => void;
}

/**
 * Executes an evaluation suite against one version of a workflow.
 *
 * Every case gets its own run and its own trace, so a regression can be opened in
 * the normal debugger rather than a bespoke eval viewer. The comparison story is
 * built on this: run the same suite against two versions and diff the summaries.
 */
export class EvalRunner {
  private readonly metrics: MetricRegistry;
  private readonly concurrency: number;
  private readonly now: () => number;
  private readonly idFactory: () => string;

  constructor(private readonly options: EvalRunnerOptions) {
    this.metrics = options.metrics ?? new MetricRegistry();
    this.concurrency = Math.max(1, options.concurrency ?? 4);
    this.now = options.now ?? (() => Date.now());
    this.idFactory =
      options.idFactory ?? (() => `ev_${Math.random().toString(36).slice(2, 12)}`);
  }

  async run({ suite, graph, version, label, onProgress }: RunSuiteOptions): Promise<EvalRun> {
    const startedAt = new Date(this.now()).toISOString();
    const metrics = this.metrics.resolve(suite.metrics);
    const results: EvalCaseResult[] = new Array(suite.cases.length);
    let completed = 0;

    const runCase = async (index: number): Promise<void> => {
      const testCase = suite.cases[index];
      const runId = this.idFactory();
      try {
        const trace = await this.options.executor.execute(graph, {
          runId,
          input: testCase.input,
          signal: this.options.signal,
          trigger: 'eval',
        });

        const scores: Record<string, number> = {};
        for (const metric of metrics) {
          const score = await metric.evaluate({ testCase, output: trace.output, trace });
          if (score !== null) scores[metric.id] = score;
        }

        results[index] = {
          caseId: testCase.id,
          runId,
          status: trace.status === 'succeeded' ? gradeOf(scores, metrics) : 'errored',
          scores,
          output: trace.output,
          durationMs: trace.durationMs ?? 0,
          costUsd: trace.usage.costUsd ?? 0,
          totalTokens: trace.usage.totalTokens ?? 0,
          error: trace.error?.message,
        };
      } catch (error) {
        results[index] = {
          caseId: testCase.id,
          runId,
          status: 'errored',
          scores: {},
          output: null,
          durationMs: 0,
          costUsd: 0,
          totalTokens: 0,
          error: error instanceof Error ? error.message : String(error),
        };
      } finally {
        onProgress?.(++completed, suite.cases.length);
      }
    };

    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(this.concurrency, suite.cases.length) }, async () => {
        while (cursor < suite.cases.length && !this.options.signal?.aborted) {
          await runCase(cursor++);
        }
      }),
    );

    const finished = results.filter(Boolean);
    const durations = finished.map((r) => r.durationMs).sort((a, b) => a - b);

    return {
      id: this.idFactory(),
      suiteId: suite.id,
      workflowId: suite.workflowId,
      version,
      label,
      startedAt,
      finishedAt: new Date(this.now()).toISOString(),
      results: finished,
      summary: summarize(finished, metrics),
      passRate: finished.length
        ? Number(
            (finished.filter((r) => r.status === 'passed').length / finished.length).toFixed(4),
          )
        : 0,
      totalCostUsd: Number(finished.reduce((sum, r) => sum + r.costUsd, 0).toFixed(6)),
      p50LatencyMs: percentile(durations, 0.5),
      p95LatencyMs: percentile(durations, 0.95),
    };
  }
}

/**
 * A case passes when every *quality* metric that applied to it scored above 0.5.
 * Cost and latency are reported but never gate a pass — a slow correct answer is
 * still correct, and conflating the two hides real regressions.
 */
function gradeOf(scores: Record<string, number>, metrics: Metric[]): 'passed' | 'failed' {
  const quality = metrics.filter((m) => m.direction === 'higher' && m.id in scores);
  if (quality.length === 0) return 'passed';
  return quality.every((m) => scores[m.id] > 0.5) ? 'passed' : 'failed';
}

function summarize(results: EvalCaseResult[], metrics: Metric[]): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const metric of metrics) {
    const values = results
      .map((r) => r.scores[metric.id])
      .filter((v): v is number => typeof v === 'number');
    if (values.length === 0) continue;
    summary[metric.id] = Number(
      (values.reduce((sum, v) => sum + v, 0) / values.length).toFixed(4),
    );
  }
  return summary;
}

export function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

export interface MetricComparison {
  metric: string;
  baseline: number;
  candidate: number;
  delta: number;
  /** Direction-aware: true when the candidate is better. */
  improved: boolean;
}

export interface EvalComparison {
  baseline: EvalRun;
  candidate: EvalRun;
  metrics: MetricComparison[];
  passRateDelta: number;
  costDelta: number;
  latencyDelta: number;
  /** Cases that flipped from pass to fail — the regressions worth blocking on. */
  regressions: string[];
  fixes: string[];
}

/** Version-over-version comparison of two runs of the same suite. */
export function compareEvalRuns(
  baseline: EvalRun,
  candidate: EvalRun,
  registry = new MetricRegistry(),
): EvalComparison {
  const keys = new Set([...Object.keys(baseline.summary), ...Object.keys(candidate.summary)]);
  const metrics: MetricComparison[] = [...keys].map((key) => {
    const before = baseline.summary[key] ?? 0;
    const after = candidate.summary[key] ?? 0;
    const delta = Number((after - before).toFixed(4));
    const direction = registry.get(key)?.direction ?? 'higher';
    return {
      metric: key,
      baseline: before,
      candidate: after,
      delta,
      improved: direction === 'higher' ? delta > 0 : delta < 0,
    };
  });

  const baselineByCase = new Map(baseline.results.map((r) => [r.caseId, r]));
  const regressions: string[] = [];
  const fixes: string[] = [];
  for (const result of candidate.results) {
    const before = baselineByCase.get(result.caseId);
    if (!before) continue;
    if (before.status === 'passed' && result.status !== 'passed')
      regressions.push(result.caseId);
    if (before.status !== 'passed' && result.status === 'passed') fixes.push(result.caseId);
  }

  return {
    baseline,
    candidate,
    metrics,
    passRateDelta: Number((candidate.passRate - baseline.passRate).toFixed(4)),
    costDelta: Number((candidate.totalCostUsd - baseline.totalCostUsd).toFixed(6)),
    latencyDelta: candidate.p95LatencyMs - baseline.p95LatencyMs,
    regressions,
    fixes,
  };
}
