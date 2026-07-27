import { Rocket } from 'lucide-react';
import { getRuntime } from '@/server/runtime';
import { PageHeader } from '@/components/shell/page-header';
import { Badge, EmptyState } from '@/components/ui/primitives';
import { DeploymentCreator } from '@/components/deployments/creator';
import { formatRelativeTime } from '@/lib/format';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Deployments' };

const KIND_HINT: Record<string, string> = {
  rest: 'POST JSON, get JSON back.',
  webhook: 'Accepts third-party webhook deliveries.',
  schedule: 'Invoked on a cron schedule.',
  worker: 'Drained by a background worker.',
  chat: 'Conversational endpoint for a chat client.',
  cli: 'Called from the FlowForge CLI.',
  widget: 'Embedded in a page via an iframe widget.',
};

export default async function DeploymentsPage() {
  const { store } = await getRuntime();
  const deployments = await store.listDeployments();
  const workflows = await store.listWorkflows();
  const nameById = new Map(workflows.map((w) => [w.id, w.name]));
  const publishable = workflows.filter((w) => w.publishedVersion);

  return (
    <>
      <PageHeader
        title="Deployments"
        description="Published versions exposed as callable endpoints. A deployment is pinned to the version it was created from, so publishing a draft never changes live behaviour."
        actions={
          <DeploymentCreator workflows={publishable.map((w) => ({ id: w.id, name: w.name }))} />
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        {deployments.length === 0 ? (
          <EmptyState
            icon={<Rocket className="size-5" />}
            title="Nothing deployed"
            description={
              publishable.length === 0
                ? 'Publish a workflow version first — drafts are not servable.'
                : 'Create a deployment to expose a published version as an HTTP endpoint.'
            }
          />
        ) : (
          <div className="space-y-3">
            {deployments.map((deployment) => (
              <article key={deployment.id} className="panel p-4">
                <div className="flex flex-wrap items-center gap-3">
                  <Badge tone="accent">{deployment.kind}</Badge>
                  <h2 className="text-ink text-sm font-semibold">
                    {nameById.get(deployment.workflowId) ?? deployment.workflowId}
                  </h2>
                  <Badge tone="positive">v{deployment.version}</Badge>
                  {deployment.tokenHash ? <Badge tone="warning">token required</Badge> : null}
                  <span className="numeric text-ink-subtle ml-auto text-[11px]">
                    {deployment.invocations} invocations
                    {deployment.lastInvokedAt
                      ? ` · last ${formatRelativeTime(deployment.lastInvokedAt)}`
                      : ''}
                  </span>
                </div>

                <p className="text-ink-subtle mt-2 text-[11px]">{KIND_HINT[deployment.kind]}</p>

                <pre className="border-border bg-surface-2 text-ink-muted mt-3 overflow-x-auto rounded-lg border p-3 font-mono text-[11px]">
                  {`curl -X POST $BASE_URL/api/v1/${deployment.slug} \\
${deployment.tokenHash ? '  -H "Authorization: Bearer $FLOWFORGE_TOKEN" \\\n' : ''}  -H "Content-Type: application/json" \\
  -d '{"question": "hello"}'`}
                </pre>

                <p className="text-ink-subtle mt-2 text-[10px]">
                  Rate limit: {deployment.rateLimitPerMinute}/min per client.
                </p>
              </article>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
