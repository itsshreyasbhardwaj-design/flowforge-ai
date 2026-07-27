import { FlaskConical } from 'lucide-react';
import { getRuntime } from '@/server/runtime';
import { BUILTIN_METRICS } from '@/core/eval/metrics';
import { compareEvalRuns } from '@/core/eval/runner';
import { PageHeader, StatTile } from '@/components/shell/page-header';
import { Badge, EmptyState } from '@/components/ui/primitives';
import { EvalSuiteCreator } from '@/components/evaluations/suite-creator';
import { RunSuiteButton } from '@/components/evaluations/run-suite-button';
import { formatCost, formatDuration, formatPercent, formatRelativeTime } from '@/lib/format';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Evaluations' };

export default async function EvaluationsPage() {
  const { store } = await getRuntime();
  const [suites, evalRuns, workflows] = await Promise.all([
    store.listSuites(),
    store.listEvalRuns(),
    store.listWorkflows(),
  ]);
  const nameById = new Map(workflows.map((w) => [w.id, w.name]));

  return (
    <>
      <PageHeader
        title="Evaluations"
        description="Score a workflow against a fixed set of cases, then compare versions. Quality metrics gate a pass; cost and latency are reported but never mask a correctness regression."
        actions={
          <EvalSuiteCreator workflows={workflows.map((w) => ({ id: w.id, name: w.name }))} />
        }
      />

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-6">
        {suites.length === 0 ? (
          <EmptyState
            icon={<FlaskConical className="size-5" />}
            title="No evaluation suites"
            description="Create a suite of input/expected pairs to measure a workflow before and after a change."
          />
        ) : null}

        {suites.map((suite) => {
          const runs = evalRuns.filter((r) => r.suiteId === suite.id);
          const latest = runs[0];
          const previous = runs[1];
          const comparison = latest && previous ? compareEvalRuns(previous, latest) : null;

          return (
            <section key={suite.id} className="panel overflow-hidden">
              <header className="border-border flex flex-wrap items-center gap-3 border-b px-4 py-3">
                <div className="min-w-0 flex-1">
                  <h2 className="text-ink text-sm font-semibold">{suite.name}</h2>
                  <p className="text-ink-subtle mt-0.5 text-[11px]">
                    {nameById.get(suite.workflowId) ?? suite.workflowId} · {suite.cases.length}{' '}
                    cases · {suite.metrics.join(', ')}
                  </p>
                </div>
                <RunSuiteButton suiteId={suite.id} />
              </header>

              {latest ? (
                <div className="space-y-4 p-4">
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <StatTile
                      label="Pass rate"
                      value={formatPercent(latest.passRate, 1)}
                      tone={
                        latest.passRate > 0.9
                          ? 'positive'
                          : latest.passRate > 0.6
                            ? 'warning'
                            : 'danger'
                      }
                      hint={`v${latest.version}`}
                    />
                    <StatTile label="p95 latency" value={formatDuration(latest.p95LatencyMs)} />
                    <StatTile label="Total cost" value={formatCost(latest.totalCostUsd)} />
                    <StatTile
                      label="Cases"
                      value={String(latest.results.length)}
                      hint={formatRelativeTime(latest.startedAt)}
                    />
                  </div>

                  {comparison ? (
                    <div className="border-border bg-surface-2 rounded-lg border p-3">
                      <p className="text-ink text-[11px] font-medium">
                        vs v{previous.version} ({formatRelativeTime(previous.startedAt)})
                      </p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {comparison.metrics.map((metric) => (
                          <Badge
                            key={metric.metric}
                            tone={
                              metric.delta === 0
                                ? 'neutral'
                                : metric.improved
                                  ? 'positive'
                                  : 'danger'
                            }
                          >
                            {metricLabel(metric.metric)} {metric.delta > 0 ? '+' : ''}
                            {metric.delta.toFixed(3)}
                          </Badge>
                        ))}
                      </div>
                      {comparison.regressions.length > 0 ? (
                        <p className="text-danger mt-2 text-[11px]">
                          {comparison.regressions.length} regression
                          {comparison.regressions.length === 1 ? '' : 's'}:{' '}
                          {comparison.regressions.join(', ')}
                        </p>
                      ) : null}
                      {comparison.fixes.length > 0 ? (
                        <p className="text-positive mt-1 text-[11px]">
                          {comparison.fixes.length} newly passing: {comparison.fixes.join(', ')}
                        </p>
                      ) : null}
                    </div>
                  ) : null}

                  <div className="border-border overflow-hidden rounded-lg border">
                    <table className="w-full text-left text-[11px]">
                      <thead className="bg-surface-2 text-ink-subtle text-[10px] tracking-widest uppercase">
                        <tr>
                          <th className="px-3 py-2 font-medium">Case</th>
                          <th className="px-3 py-2 font-medium">Result</th>
                          {suite.metrics.map((metric) => (
                            <th key={metric} className="px-3 py-2 text-right font-medium">
                              {metricLabel(metric)}
                            </th>
                          ))}
                          <th className="px-3 py-2 text-right font-medium">Latency</th>
                        </tr>
                      </thead>
                      <tbody className="divide-border/60 divide-y">
                        {latest.results.map((result) => (
                          <tr key={result.caseId}>
                            <td className="text-ink-muted px-3 py-1.5 font-mono">
                              {result.caseId}
                            </td>
                            <td className="px-3 py-1.5">
                              <Badge
                                tone={
                                  result.status === 'passed'
                                    ? 'positive'
                                    : result.status === 'failed'
                                      ? 'danger'
                                      : 'warning'
                                }
                              >
                                {result.status}
                              </Badge>
                            </td>
                            {suite.metrics.map((metric) => (
                              <td
                                key={metric}
                                className="numeric text-ink-muted px-3 py-1.5 text-right"
                              >
                                {result.scores[metric] !== undefined
                                  ? result.scores[metric].toFixed(2)
                                  : '—'}
                              </td>
                            ))}
                            <td className="numeric text-ink-subtle px-3 py-1.5 text-right">
                              {formatDuration(result.durationMs)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : (
                <p className="text-ink-subtle px-4 py-6 text-center text-xs">
                  No results yet. Run the suite to produce a baseline.
                </p>
              )}
            </section>
          );
        })}
      </div>
    </>
  );
}

function metricLabel(id: string): string {
  return BUILTIN_METRICS.find((m) => m.id === id)?.label ?? id;
}
