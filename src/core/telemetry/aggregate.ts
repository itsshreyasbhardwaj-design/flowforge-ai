import { percentile } from '../eval/runner';
import type { RunRecord } from '../store/types';

export interface TimeBucket {
  /** ISO timestamp of the bucket start. */
  at: string;
  runs: number;
  failures: number;
  totalTokens: number;
  costUsd: number;
  avgLatencyMs: number;
}

export interface NodeHotspot {
  nodeId: string;
  label: string;
  executions: number;
  failures: number;
  errorRate: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  totalCostUsd: number;
  /** Share of total run time spent in this node. */
  timeShare: number;
}

export interface ProviderUsage {
  provider: string;
  model: string;
  calls: number;
  totalTokens: number;
  costUsd: number;
}

export interface ErrorGroup {
  message: string;
  count: number;
  lastSeen: string;
  nodeIds: string[];
}

export interface ObservabilitySummary {
  totalRuns: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  successRate: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  totalTokens: number;
  totalCostUsd: number;
  avgCostPerRun: number;
  buckets: TimeBucket[];
  hotspots: NodeHotspot[];
  providers: ProviderUsage[];
  errors: ErrorGroup[];
}

export interface AggregateOptions {
  /** Bucket width in ms. Defaults to one hour. */
  bucketMs?: number;
  /** Number of buckets to emit, ending at `now`. */
  buckets?: number;
  now?: number;
}

/**
 * Folds raw run records into the numbers the observability dashboard shows.
 *
 * Runs deliberately, not incrementally: at the scale a single FlowForge instance
 * holds (bounded by the store's retention ceiling) a full scan is microseconds and
 * avoids a whole class of counter-drift bugs. A Postgres deployment should push
 * this into SQL — see `docs/observability.md`.
 */
export function aggregateRuns(
  runs: RunRecord[],
  options: AggregateOptions = {},
): ObservabilitySummary {
  const bucketMs = options.bucketMs ?? 3_600_000;
  const bucketCount = options.buckets ?? 24;
  const now = options.now ?? Date.now();

  const succeeded = runs.filter((r) => r.trace.status === 'succeeded').length;
  const failed = runs.filter((r) => r.trace.status === 'failed').length;
  const cancelled = runs.filter((r) => r.trace.status === 'cancelled').length;

  const durations = runs
    .map((r) => r.trace.durationMs ?? 0)
    .filter((d) => d > 0)
    .sort((a, b) => a - b);

  const totalTokens = runs.reduce((sum, r) => sum + (r.trace.usage.totalTokens ?? 0), 0);
  const totalCostUsd = runs.reduce((sum, r) => sum + (r.trace.usage.costUsd ?? 0), 0);

  // --- time buckets -------------------------------------------------------
  const start = now - bucketCount * bucketMs;
  const buckets: TimeBucket[] = Array.from({ length: bucketCount }, (_, i) => ({
    at: new Date(start + i * bucketMs).toISOString(),
    runs: 0,
    failures: 0,
    totalTokens: 0,
    costUsd: 0,
    avgLatencyMs: 0,
  }));
  const bucketDurations: number[][] = Array.from({ length: bucketCount }, () => []);

  for (const run of runs) {
    const at = Date.parse(run.createdAt);
    if (Number.isNaN(at) || at < start) continue;
    const index = Math.min(bucketCount - 1, Math.floor((at - start) / bucketMs));
    if (index < 0) continue;
    const bucket = buckets[index];
    bucket.runs++;
    if (run.trace.status === 'failed') bucket.failures++;
    bucket.totalTokens += run.trace.usage.totalTokens ?? 0;
    bucket.costUsd += run.trace.usage.costUsd ?? 0;
    bucketDurations[index].push(run.trace.durationMs ?? 0);
  }
  buckets.forEach((bucket, i) => {
    const values = bucketDurations[i];
    bucket.avgLatencyMs = values.length
      ? Math.round(values.reduce((a, b) => a + b, 0) / values.length)
      : 0;
    bucket.costUsd = Number(bucket.costUsd.toFixed(6));
  });

  // --- per-node hotspots --------------------------------------------------
  const nodeStats = new Map<
    string,
    { label: string; durations: number[]; failures: number; cost: number }
  >();
  let totalNodeTime = 0;

  for (const run of runs) {
    for (const node of Object.values(run.trace.nodes)) {
      const entry = nodeStats.get(node.nodeId) ?? {
        label: node.nodeId,
        durations: [],
        failures: 0,
        cost: 0,
      };
      if (node.durationMs) {
        entry.durations.push(node.durationMs);
        totalNodeTime += node.durationMs;
      }
      if (node.status === 'failed') entry.failures++;
      entry.cost += node.usage?.costUsd ?? 0;
      nodeStats.set(node.nodeId, entry);
    }
  }

  const hotspots: NodeHotspot[] = [...nodeStats.entries()]
    .map(([nodeId, stats]) => {
      const sorted = [...stats.durations].sort((a, b) => a - b);
      const total = sorted.reduce((a, b) => a + b, 0);
      const executions = stats.durations.length + stats.failures;
      return {
        nodeId,
        label: stats.label,
        executions,
        failures: stats.failures,
        errorRate: executions ? Number((stats.failures / executions).toFixed(4)) : 0,
        avgLatencyMs: sorted.length ? Math.round(total / sorted.length) : 0,
        p95LatencyMs: percentile(sorted, 0.95),
        totalCostUsd: Number(stats.cost.toFixed(6)),
        timeShare: totalNodeTime ? Number((total / totalNodeTime).toFixed(4)) : 0,
      };
    })
    .sort((a, b) => b.timeShare - a.timeShare);

  // --- provider / model usage --------------------------------------------
  const providerStats = new Map<string, ProviderUsage>();
  for (const run of runs) {
    for (const node of Object.values(run.trace.nodes)) {
      const usage = node.usage;
      if (!usage?.model) continue;
      const key = `${usage.provider ?? 'unknown'}::${usage.model}`;
      const entry = providerStats.get(key) ?? {
        provider: usage.provider ?? 'unknown',
        model: usage.model,
        calls: 0,
        totalTokens: 0,
        costUsd: 0,
      };
      entry.calls++;
      entry.totalTokens += usage.totalTokens ?? 0;
      entry.costUsd += usage.costUsd ?? 0;
      providerStats.set(key, entry);
    }
  }

  // --- grouped errors -----------------------------------------------------
  const errorStats = new Map<string, ErrorGroup>();
  for (const run of runs) {
    for (const node of Object.values(run.trace.nodes)) {
      if (!node.error) continue;
      const message = normalizeErrorMessage(node.error.message);
      const entry = errorStats.get(message) ?? {
        message,
        count: 0,
        lastSeen: run.createdAt,
        nodeIds: [],
      };
      entry.count++;
      if (run.createdAt > entry.lastSeen) entry.lastSeen = run.createdAt;
      if (!entry.nodeIds.includes(node.nodeId)) entry.nodeIds.push(node.nodeId);
      errorStats.set(message, entry);
    }
  }

  return {
    totalRuns: runs.length,
    succeeded,
    failed,
    cancelled,
    successRate: runs.length ? Number((succeeded / runs.length).toFixed(4)) : 0,
    avgLatencyMs: durations.length
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
      : 0,
    p50LatencyMs: percentile(durations, 0.5),
    p95LatencyMs: percentile(durations, 0.95),
    totalTokens,
    totalCostUsd: Number(totalCostUsd.toFixed(6)),
    avgCostPerRun: runs.length ? Number((totalCostUsd / runs.length).toFixed(8)) : 0,
    buckets,
    hotspots,
    providers: [...providerStats.values()].sort((a, b) => b.costUsd - a.costUsd),
    errors: [...errorStats.values()].sort((a, b) => b.count - a.count).slice(0, 20),
  };
}

/** Collapses ids, uuids, and numbers so the same failure groups together. */
export function normalizeErrorMessage(message: string): string {
  return (
    message
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
      .replace(/\b[a-z]{2,4}_[a-z0-9]{6,}\b/gi, '<id>')
      // No trailing \b: numbers are routinely glued to a unit ("5000ms", "404s").
      .replace(/\d{3,}/g, '<n>')
      .slice(0, 200)
  );
}
