import { z } from 'zod';
import { validateWorkflow } from '@/core/graph/validate';
import { getRuntime } from '@/server/runtime';
import { json, notFound, parseBody, route } from '@/server/api';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export const GET = route(async (_request: Request, { params }: Params) => {
  const { id } = await params;
  const { store, registry } = await getRuntime();

  const record = await store.getWorkflow(id);
  if (!record) throw notFound('Workflow');

  const graph = await store.resolveGraph(id, record.draftVersion);
  if (!graph) throw notFound('Workflow draft');

  return json({
    workflow: record,
    graph,
    validation: validateWorkflow(graph, registry),
    versions: await store.listVersions(id),
    deployments: await store.listDeployments(id),
  });
});

const patchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).optional(),
  tags: z.array(z.string()).optional(),
  graph: z
    .object({
      id: z.string(),
      name: z.string(),
      description: z.string().optional(),
      nodes: z.array(z.unknown()),
      edges: z.array(z.unknown()),
      groups: z.array(z.unknown()).optional(),
      variables: z.record(z.string(), z.unknown()).optional(),
      concurrency: z.number().int().min(1).max(64).optional(),
    })
    .passthrough()
    .optional(),
});

export const PATCH = route(async (request: Request, { params }: Params) => {
  const { id } = await params;
  const body = await parseBody(request, patchSchema);
  const { store, registry } = await getRuntime();

  if (!(await store.getWorkflow(id))) throw notFound('Workflow');

  if (body.graph) {
    await store.saveDraft(id, { ...body.graph, id } as never);
  }
  const record = await store.updateWorkflow(id, {
    name: body.name,
    description: body.description,
    tags: body.tags,
  });

  const graph = await store.resolveGraph(id, record.draftVersion);
  return json({
    workflow: record,
    validation: graph ? validateWorkflow(graph, registry) : undefined,
  });
});

export const DELETE = route(async (_request: Request, { params }: Params) => {
  const { id } = await params;
  const { store } = await getRuntime();
  await store.deleteWorkflow(id);
  await store.flush();
  return json({ ok: true });
});
