import { getRuntime, verifyToken } from '@/server/runtime';
import {
  bearerToken,
  clientKey,
  json,
  notFound,
  rateLimit,
  route,
  unauthorized,
} from '@/server/api';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

type Params = { params: Promise<{ slug: string }> };

/**
 * The public execution endpoint every deployment kind is served through.
 *
 * REST, webhook, chat, CLI, and embeddable-widget deployments all resolve to the
 * same handler; they differ in how the caller is expected to shape the request,
 * not in how the workflow runs. That keeps one auth path, one rate limiter, and
 * one place where a published version is pinned.
 */
export const POST = route(async (request: Request, { params }: Params) => {
  const { slug } = await params;
  const { store, executor } = await getRuntime();

  const deployment = await store.getDeploymentBySlug(slug);
  if (!deployment || !deployment.enabled) throw notFound('Deployment');

  if (deployment.tokenHash) {
    const token = bearerToken(request);
    if (!token || !verifyToken(token, deployment.tokenHash)) {
      throw unauthorized('This deployment requires a valid bearer token');
    }
  }
  rateLimit(`dep:${deployment.id}:${clientKey(request)}`, deployment.rateLimitPerMinute);

  // Deployments always serve the exact version they were created against, so
  // publishing a new draft can never change a live endpoint's behaviour.
  const graph = await store.resolveGraph(deployment.workflowId, deployment.version);
  if (!graph) throw notFound('Workflow version');

  const input = await request.json().catch(() => ({}));
  const trace = await executor.execute(graph, {
    input,
    trigger: deployment.kind === 'webhook' ? 'webhook' : 'api',
  });

  await store.saveDeployment({
    ...deployment,
    invocations: deployment.invocations + 1,
    lastInvokedAt: new Date().toISOString(),
  });
  await store.saveRun({
    id: trace.runId,
    workflowId: deployment.workflowId,
    version: deployment.version,
    trace,
    createdAt: new Date(trace.startedAt).toISOString(),
  });
  await store.flush();

  if (trace.status !== 'succeeded') {
    return json(
      {
        error: trace.error?.message ?? 'Workflow failed',
        runId: trace.runId,
        status: trace.status,
      },
      { status: 502 },
    );
  }

  return json({
    runId: trace.runId,
    output: trace.output,
    usage: trace.usage,
    durationMs: trace.durationMs,
  });
});

export const GET = route(async (_request: Request, { params }: Params) => {
  const { slug } = await params;
  const { store } = await getRuntime();

  const deployment = await store.getDeploymentBySlug(slug);
  if (!deployment) throw notFound('Deployment');

  return json({
    slug: deployment.slug,
    kind: deployment.kind,
    version: deployment.version,
    enabled: deployment.enabled,
    requiresToken: Boolean(deployment.tokenHash),
    invocations: deployment.invocations,
  });
});
