import Link from 'next/link';
import { Activity } from 'lucide-react';
import { getRuntime } from '@/server/runtime';
import { PageHeader } from '@/components/shell/page-header';
import { Badge, EmptyState } from '@/components/ui/primitives';
import { formatCost, formatDuration, formatRelativeTime, formatTokens } from '@/lib/format';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Runs' };

const TONE = {
  succeeded: 'positive',
  failed: 'danger',
  cancelled: 'warning',
  running: 'accent',
  queued: 'neutral',
  suspended: 'warning',
} as const;

export default async function RunsPage() {
  const { store } = await getRuntime();
  const runs = await store.listRuns({ limit: 100 });
  const workflows = await store.listWorkflows();
  const nameById = new Map(workflows.map((w) => [w.id, w.name]));

  return (
    <>
      <PageHeader
        title="Runs"
        description="Every execution, with its full trace. Open one to replay the timeline, logs, and per-node output."
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {runs.length === 0 ? (
          <EmptyState
            icon={<Activity className="size-5" />}
            title="No runs yet"
            description="Execute a workflow from the editor or call a deployment endpoint, and its trace lands here."
          />
        ) : (
          <table className="w-full text-left text-xs">
            <thead className="bg-surface text-ink-subtle sticky top-0 text-[10px] tracking-widest uppercase">
              <tr className="border-border border-b">
                <th className="px-6 py-2.5 font-medium">Status</th>
                <th className="px-3 py-2.5 font-medium">Workflow</th>
                <th className="px-3 py-2.5 font-medium">Trigger</th>
                <th className="px-3 py-2.5 text-right font-medium">Duration</th>
                <th className="px-3 py-2.5 text-right font-medium">Tokens</th>
                <th className="px-3 py-2.5 text-right font-medium">Cost</th>
                <th className="px-6 py-2.5 text-right font-medium">When</th>
              </tr>
            </thead>
            <tbody className="divide-border/60 divide-y">
              {runs.map((run) => (
                <tr key={run.id} className="group hover:bg-surface-2 transition-colors">
                  <td className="px-6 py-2.5">
                    <Link href={`/runs/${run.id}`} className="block">
                      <Badge tone={TONE[run.trace.status] ?? 'neutral'}>
                        {run.trace.status}
                      </Badge>
                    </Link>
                  </td>
                  <td className="max-w-xs px-3 py-2.5">
                    <Link
                      href={`/runs/${run.id}`}
                      className="text-ink group-hover:text-accent-soft block truncate"
                    >
                      {nameById.get(run.workflowId) ?? run.workflowId}
                    </Link>
                    {run.trace.error ? (
                      <span className="text-danger block truncate text-[10px]">
                        {run.trace.error.message}
                      </span>
                    ) : null}
                  </td>
                  <td className="text-ink-subtle px-3 py-2.5">
                    {run.trace.trigger ?? 'manual'}
                  </td>
                  <td className="numeric text-ink-muted px-3 py-2.5 text-right">
                    {formatDuration(run.trace.durationMs)}
                  </td>
                  <td className="numeric text-ink-muted px-3 py-2.5 text-right">
                    {formatTokens(run.trace.usage.totalTokens)}
                  </td>
                  <td className="numeric text-ink-muted px-3 py-2.5 text-right">
                    {formatCost(run.trace.usage.costUsd)}
                  </td>
                  <td className="text-ink-subtle px-6 py-2.5 text-right">
                    {formatRelativeTime(run.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
