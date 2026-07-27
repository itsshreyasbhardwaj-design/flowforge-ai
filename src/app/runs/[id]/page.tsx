import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { getRuntime } from '@/server/runtime';
import { PageHeader, StatTile } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/primitives';
import { formatCost, formatDuration, formatTokens, prettyJson } from '@/lib/format';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

const TONE = {
  succeeded: 'positive',
  failed: 'danger',
  cancelled: 'warning',
  running: 'accent',
  queued: 'neutral',
  suspended: 'warning',
} as const;

export default async function RunDetailPage({ params }: Params) {
  const { id } = await params;
  const { store } = await getRuntime();

  const run = await store.getRun(id);
  if (!run) notFound();

  const workflow = await store.getWorkflow(run.workflowId);
  const graph = await store.resolveGraph(run.workflowId, run.version);
  const labelOf = (nodeId: string) =>
    graph?.nodes.find((n) => n.id === nodeId)?.label ?? nodeId;

  const nodes = run.trace.order.map((nodeId) => run.trace.nodes[nodeId]).filter(Boolean);

  return (
    <>
      <PageHeader
        title={workflow?.name ?? run.workflowId}
        description={`Run ${run.id} · version ${run.version ?? '—'} · ${run.trace.trigger ?? 'manual'} trigger`}
        actions={
          <Link
            href="/runs"
            className="text-ink-subtle hover:text-ink flex items-center gap-1 text-xs transition-colors"
          >
            <ChevronLeft className="size-3.5" /> All runs
          </Link>
        }
      />

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-6">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Status"
            value={run.trace.status}
            tone={
              run.trace.status === 'succeeded'
                ? 'positive'
                : run.trace.status === 'failed'
                  ? 'danger'
                  : 'neutral'
            }
          />
          <StatTile label="Duration" value={formatDuration(run.trace.durationMs)} />
          <StatTile label="Tokens" value={formatTokens(run.trace.usage.totalTokens)} />
          <StatTile label="Cost" value={formatCost(run.trace.usage.costUsd)} />
        </div>

        {run.trace.error ? (
          <div className="panel border-danger/25 bg-danger/8 p-4">
            <p className="text-danger text-xs font-semibold">
              {run.trace.error.name}: {run.trace.error.message}
            </p>
            {run.trace.error.stack ? (
              <pre className="text-danger/80 mt-2 max-h-48 overflow-auto font-mono text-[10px] leading-relaxed">
                {run.trace.error.stack}
              </pre>
            ) : null}
          </div>
        ) : null}

        <section className="panel overflow-hidden">
          <h2 className="border-border text-ink border-b px-4 py-2.5 text-xs font-semibold">
            Execution steps
          </h2>
          <div className="divide-border/60 divide-y">
            {nodes.map((node) => (
              <details key={node.nodeId} className="group">
                <summary className="hover:bg-surface-2 flex cursor-pointer items-center gap-3 px-4 py-2.5 text-xs transition-colors">
                  <Badge tone={TONE[node.status as keyof typeof TONE] ?? 'neutral'}>
                    {node.status}
                  </Badge>
                  <span className="text-ink min-w-0 flex-1 truncate">
                    {labelOf(node.nodeId)}
                  </span>
                  {node.attempts > 1 ? <Badge tone="warning">×{node.attempts}</Badge> : null}
                  <span className="numeric text-ink-subtle">
                    {formatDuration(node.durationMs)}
                  </span>
                  <span className="numeric text-ink-subtle w-16 text-right">
                    {node.usage?.totalTokens ? formatTokens(node.usage.totalTokens) : ''}
                  </span>
                </summary>

                <div className="border-border bg-canvas/40 space-y-3 border-t p-4">
                  {node.error ? (
                    <pre className="border-danger/25 bg-danger/8 text-danger overflow-auto rounded-lg border p-2 font-mono text-[10px]">
                      {node.error.message}
                    </pre>
                  ) : null}
                  <div className="grid gap-3 lg:grid-cols-2">
                    <Payload title="Inputs" value={node.inputs} />
                    <Payload title="Outputs" value={node.outputs} />
                  </div>
                  {node.logs.length > 0 ? (
                    <div>
                      <p className="text-ink-subtle mb-1 text-[10px] tracking-widest uppercase">
                        Logs
                      </p>
                      <div className="text-ink-muted space-y-0.5 font-mono text-[10px]">
                        {node.logs.map((log, index) => (
                          <p key={index}>
                            <span className="text-ink-subtle uppercase">{log.level}</span>{' '}
                            {log.message}
                          </p>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              </details>
            ))}
          </div>
        </section>

        <div className="grid gap-3 lg:grid-cols-2">
          <Payload title="Run input" value={run.trace.input} panel />
          <Payload title="Run output" value={run.trace.output} panel />
        </div>
      </div>
    </>
  );
}

function Payload({ title, value, panel }: { title: string; value: unknown; panel?: boolean }) {
  return (
    <div className={panel ? 'panel overflow-hidden' : ''}>
      <p
        className={
          panel
            ? 'border-border text-ink border-b px-4 py-2.5 text-xs font-semibold'
            : 'text-ink-subtle mb-1 text-[10px] tracking-widest uppercase'
        }
      >
        {title}
      </p>
      <pre
        className={`text-ink-muted max-h-64 overflow-auto font-mono text-[10px] leading-relaxed ${panel ? 'p-4' : 'border-border bg-surface-2 rounded-lg border p-2'}`}
      >
        {prettyJson(value, 8000)}
      </pre>
    </div>
  );
}
