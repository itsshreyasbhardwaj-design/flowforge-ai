import Link from 'next/link';
import { Activity, GitBranch, Plus, Workflow as WorkflowIcon } from 'lucide-react';
import { getRuntime } from '@/server/runtime';
import { PageHeader } from '@/components/shell/page-header';
import { Badge, Button, EmptyState } from '@/components/ui/primitives';
import { CreateWorkflowButton } from '@/components/workflows/create-workflow-button';
import { formatPercent, formatRelativeTime } from '@/lib/format';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Workflows' };

export default async function WorkflowsPage() {
  const { store } = await getRuntime();
  const records = await store.listWorkflows();

  const rows = await Promise.all(
    records.map(async (record) => {
      const graph = await store.resolveGraph(record.id, record.draftVersion);
      const runs = await store.listRuns({ workflowId: record.id, limit: 25 });
      const succeeded = runs.filter((r) => r.trace.status === 'succeeded').length;
      return {
        ...record,
        nodeCount: graph?.nodes.length ?? 0,
        runCount: runs.length,
        successRate: runs.length ? succeeded / runs.length : null,
        lastRunAt: runs[0]?.createdAt,
      };
    }),
  );

  return (
    <>
      <PageHeader
        title="Workflows"
        description="Every agent you have designed. Drafts are editable; published versions are what deployments serve."
        actions={
          <>
            <Button variant="ghost" asChild>
              <Link href="/marketplace">Browse templates</Link>
            </Button>
            <CreateWorkflowButton />
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        {rows.length === 0 ? (
          <EmptyState
            icon={<WorkflowIcon className="size-5" />}
            title="No workflows yet"
            description="Start from a template, describe one to the assistant, or drag nodes onto an empty canvas."
            action={
              <div className="flex gap-2">
                <Button variant="secondary" asChild>
                  <Link href="/marketplace">
                    <Plus /> From a template
                  </Link>
                </Button>
                <CreateWorkflowButton />
              </div>
            }
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {rows.map((row) => (
              <Link
                key={row.id}
                href={`/workflows/${row.id}`}
                className="panel group hover:border-border-strong hover:bg-surface-2 flex flex-col gap-3 p-4 transition-all"
              >
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <h2 className="text-ink group-hover:text-accent-soft truncate text-sm font-semibold">
                      {row.name}
                    </h2>
                    <p className="text-ink-subtle mt-1 line-clamp-2 min-h-8 text-[11px] leading-relaxed">
                      {row.description ?? 'No description'}
                    </p>
                  </div>
                  {row.publishedVersion ? (
                    <Badge tone="positive">live v{row.publishedVersion}</Badge>
                  ) : (
                    <Badge>draft</Badge>
                  )}
                </div>

                <div className="text-ink-subtle mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
                  <span className="flex items-center gap-1">
                    <WorkflowIcon className="size-3" /> {row.nodeCount} nodes
                  </span>
                  <span className="flex items-center gap-1">
                    <GitBranch className="size-3" /> v{row.draftVersion}
                  </span>
                  {row.runCount > 0 ? (
                    <span className="flex items-center gap-1">
                      <Activity className="size-3" />
                      <span className="numeric">
                        {formatPercent(row.successRate)}
                      </span> over {row.runCount}
                    </span>
                  ) : null}
                  <span className="ml-auto">{formatRelativeTime(row.updatedAt)}</span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
