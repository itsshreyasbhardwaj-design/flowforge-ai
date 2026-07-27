import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { getRuntime } from '@/server/runtime';
import { PageHeader } from '@/components/shell/page-header';
import { VersionHistory } from '@/components/versions/version-history';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export default async function VersionsPage({ params }: Params) {
  const { id } = await params;
  const { store } = await getRuntime();

  const record = await store.getWorkflow(id);
  if (!record) notFound();

  const versions = await store.listVersions(id);

  return (
    <>
      <PageHeader
        title={`${record.name} — versions`}
        description="Each publish freezes the draft and opens a new one. Deployments serve the frozen version they were created against, so history is a real audit trail rather than a label."
        actions={
          <Link
            href={`/workflows/${id}`}
            className="text-ink-subtle hover:text-ink flex items-center gap-1 text-xs transition-colors"
          >
            <ChevronLeft className="size-3.5" /> Back to editor
          </Link>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <VersionHistory
          workflowId={id}
          versions={versions.map((v) => ({
            version: v.version,
            status: v.status,
            createdAt: v.createdAt,
            changelog: v.changelog,
            nodeCount: v.graph.nodes.length,
            edgeCount: v.graph.edges.length,
          }))}
          publishedVersion={record.publishedVersion}
        />
      </div>
    </>
  );
}
