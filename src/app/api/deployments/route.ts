import { z } from 'zod';
import { generateToken, getRuntime, hashToken, newId } from '@/server/runtime';
import { badRequest, json, notFound, parseBody, route } from '@/server/api';

export const dynamic = 'force-dynamic';

export const GET = route(async (request: Request) => {
  const url = new URL(request.url);
  const { store } = await getRuntime();
  const deployments = await store.listDeployments(
    url.searchParams.get('workflowId') ?? undefined,
  );
  // tokenHash is a credential-adjacent value; it never leaves the server.
  return json({
    deployments: deployments.map(({ tokenHash, ...rest }) => ({
      ...rest,
      requiresToken: Boolean(tokenHash),
    })),
  });
});

const createSchema = z.object({
  workflowId: z.string().min(1),
  kind: z.enum(['rest', 'webhook', 'schedule', 'worker', 'chat', 'cli', 'widget']),
  slug: z
    .string()
    .min(3)
    .max(64)
    .regex(/^[a-z0-9-]+$/, 'Use lowercase letters, numbers, and hyphens only')
    .optional(),
  cron: z.string().optional(),
  rateLimitPerMinute: z.number().int().min(0).max(6000).default(60),
  requireToken: z.boolean().default(true),
});

export const POST = route(async (request: Request) => {
  const body = await parseBody(request, createSchema);
  const { store } = await getRuntime();

  const workflow = await store.getWorkflow(body.workflowId);
  if (!workflow) throw notFound('Workflow');
  if (!workflow.publishedVersion) {
    throw badRequest('Publish a version before deploying it. Drafts are not servable.');
  }

  const slug = body.slug ?? `${slugify(workflow.name)}-${newId('').slice(1, 7)}`;
  if (await store.getDeploymentBySlug(slug)) {
    throw badRequest(`The slug "${slug}" is already in use`);
  }

  const token = body.requireToken ? generateToken() : undefined;
  const deployment = {
    id: newId('dep'),
    workflowId: body.workflowId,
    version: workflow.publishedVersion,
    kind: body.kind,
    slug,
    enabled: true,
    tokenHash: token ? hashToken(token) : undefined,
    cron: body.cron,
    rateLimitPerMinute: body.rateLimitPerMinute,
    createdAt: new Date().toISOString(),
    invocations: 0,
  };

  await store.saveDeployment(deployment);
  await store.flush();

  const { tokenHash, ...safe } = deployment;
  void tokenHash;
  // The plaintext token is returned exactly once and never stored.
  return json({ deployment: safe, token }, { status: 201 });
});

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'workflow'
  );
}
