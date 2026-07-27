import { aggregateRuns } from '@/core/telemetry/aggregate';
import { getRuntime } from '@/server/runtime';
import { PageHeader, StatTile } from '@/components/shell/page-header';
import { EmptyState } from '@/components/ui/primitives';
import { BarChart3 } from 'lucide-react';
import {
  formatCost,
  formatDuration,
  formatPercent,
  formatRelativeTime,
  formatTokens,
} from '@/lib/format';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Observability' };

export default async function ObservabilityPage() {
  const { store } = await getRuntime();
  const runs = await store.listRuns({ limit: 1000 });
  const workflows = await store.listWorkflows();
  const nameById = new Map(workflows.map((w) => [w.id, w.name]));
  const summary = aggregateRuns(runs, { bucketMs: 3_600_000, buckets: 24 });

  const peak = Math.max(1, ...summary.buckets.map((b) => b.runs));

  return (
    <>
      <PageHeader
        title="Observability"
        description="Throughput, reliability, latency, and spend across every workflow in this instance."
      />

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-6">
        {runs.length === 0 ? (
          <EmptyState
            icon={<BarChart3 className="size-5" />}
            title="Nothing to measure yet"
            description="Metrics are derived from run traces. Execute a workflow and this fills in."
          />
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatTile
                label="Runs"
                value={String(summary.totalRuns)}
                hint={`${summary.failed} failed`}
              />
              <StatTile
                label="Success rate"
                value={formatPercent(summary.successRate, 1)}
                tone={
                  summary.successRate > 0.95
                    ? 'positive'
                    : summary.successRate > 0.8
                      ? 'warning'
                      : 'danger'
                }
              />
              <StatTile
                label="p95 latency"
                value={formatDuration(summary.p95LatencyMs)}
                hint={`p50 ${formatDuration(summary.p50LatencyMs)}`}
              />
              <StatTile
                label="Total spend"
                value={formatCost(summary.totalCostUsd)}
                hint={`${formatTokens(summary.totalTokens)} tokens`}
              />
            </div>

            <section className="panel p-4">
              <h2 className="text-ink text-xs font-semibold">Runs over the last 24 hours</h2>
              <div
                className="mt-4 flex h-32 items-end gap-1"
                role="img"
                aria-label="Hourly run volume"
              >
                {summary.buckets.map((bucket) => (
                  <div key={bucket.at} className="group relative flex-1">
                    <div
                      className="bg-accent/45 group-hover:bg-accent w-full rounded-t transition-colors"
                      style={{ height: `${Math.max(2, (bucket.runs / peak) * 128)}px` }}
                    />
                    {bucket.failures > 0 ? (
                      <div
                        className="bg-danger/70 absolute bottom-0 w-full rounded-t"
                        style={{ height: `${Math.max(2, (bucket.failures / peak) * 128)}px` }}
                      />
                    ) : null}
                    <div className="border-border bg-surface-3 text-ink pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 rounded-md border px-2 py-1 text-[10px] whitespace-nowrap shadow-xl group-hover:block">
                      {bucket.runs} runs · {bucket.failures} failed
                      <br />
                      {new Date(bucket.at).toLocaleTimeString(undefined, { hour: '2-digit' })}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <div className="grid gap-3 lg:grid-cols-2">
              <section className="panel overflow-hidden">
                <h2 className="border-border text-ink border-b px-4 py-2.5 text-xs font-semibold">
                  Slowest nodes
                </h2>
                <div className="divide-border/60 divide-y">
                  {summary.hotspots.slice(0, 8).map((hotspot) => (
                    <div
                      key={hotspot.nodeId}
                      className="flex items-center gap-3 px-4 py-2 text-xs"
                    >
                      <span className="text-ink-muted min-w-0 flex-1 truncate font-mono text-[11px]">
                        {hotspot.nodeId}
                      </span>
                      <span className="numeric text-ink-subtle w-16 text-right">
                        {formatDuration(hotspot.avgLatencyMs)}
                      </span>
                      <span className="w-16 shrink-0">
                        <span className="bg-surface-3 block h-1.5 overflow-hidden rounded-full">
                          <span
                            className="bg-accent block h-full rounded-full"
                            style={{ width: `${Math.min(100, hotspot.timeShare * 100)}%` }}
                          />
                        </span>
                      </span>
                      <span className="numeric text-ink-subtle w-10 text-right text-[10px]">
                        {formatPercent(hotspot.timeShare)}
                      </span>
                    </div>
                  ))}
                  {summary.hotspots.length === 0 ? (
                    <p className="text-ink-subtle px-4 py-6 text-center text-xs">
                      No node timings.
                    </p>
                  ) : null}
                </div>
              </section>

              <section className="panel overflow-hidden">
                <h2 className="border-border text-ink border-b px-4 py-2.5 text-xs font-semibold">
                  Provider usage
                </h2>
                <div className="divide-border/60 divide-y">
                  {summary.providers.map((provider) => (
                    <div
                      key={`${provider.provider}-${provider.model}`}
                      className="flex items-center gap-3 px-4 py-2 text-xs"
                    >
                      <span className="text-ink-muted min-w-0 flex-1 truncate">
                        {provider.model}
                      </span>
                      <span className="numeric text-ink-subtle">{provider.calls} calls</span>
                      <span className="numeric text-ink-subtle w-16 text-right">
                        {formatTokens(provider.totalTokens)}
                      </span>
                      <span className="numeric text-ink-muted w-16 text-right">
                        {formatCost(provider.costUsd)}
                      </span>
                    </div>
                  ))}
                  {summary.providers.length === 0 ? (
                    <p className="text-ink-subtle px-4 py-6 text-center text-xs">
                      No model calls recorded.
                    </p>
                  ) : null}
                </div>
              </section>
            </div>

            <div className="grid gap-3 lg:grid-cols-2">
              <section className="panel overflow-hidden">
                <h2 className="border-border text-ink border-b px-4 py-2.5 text-xs font-semibold">
                  Top errors
                </h2>
                <div className="divide-border/60 divide-y">
                  {summary.errors.map((group) => (
                    <div key={group.message} className="px-4 py-2 text-xs">
                      <div className="flex items-center gap-2">
                        <span className="numeric bg-danger/15 text-danger shrink-0 rounded px-1.5 py-0.5 text-[10px]">
                          ×{group.count}
                        </span>
                        <span className="text-ink-muted min-w-0 flex-1 truncate">
                          {group.message}
                        </span>
                        <span className="text-ink-subtle shrink-0 text-[10px]">
                          {formatRelativeTime(group.lastSeen)}
                        </span>
                      </div>
                    </div>
                  ))}
                  {summary.errors.length === 0 ? (
                    <p className="text-positive px-4 py-6 text-center text-xs">
                      No errors recorded.
                    </p>
                  ) : null}
                </div>
              </section>

              <section className="panel overflow-hidden">
                <h2 className="border-border text-ink border-b px-4 py-2.5 text-xs font-semibold">
                  By workflow
                </h2>
                <div className="divide-border/60 divide-y">
                  {[...new Set(runs.map((r) => r.workflowId))].map((workflowId) => {
                    const scoped = runs.filter((r) => r.workflowId === workflowId);
                    const ok = scoped.filter((r) => r.trace.status === 'succeeded').length;
                    return (
                      <div
                        key={workflowId}
                        className="flex items-center gap-3 px-4 py-2 text-xs"
                      >
                        <span className="text-ink-muted min-w-0 flex-1 truncate">
                          {nameById.get(workflowId) ?? workflowId}
                        </span>
                        <span className="numeric text-ink-subtle">{scoped.length} runs</span>
                        <span className="numeric text-ink-muted w-12 text-right">
                          {formatPercent(ok / scoped.length)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </section>
            </div>
          </>
        )}
      </div>
    </>
  );
}
