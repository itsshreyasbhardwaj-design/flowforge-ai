import { z } from 'zod';
import { getRuntime } from '@/server/runtime';
import { json, notFound, parseBody, route } from '@/server/api';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export const GET = route(async (_request: Request, { params }: Params) => {
  const { id } = await params;
  const { store } = await getRuntime();
  return json({ versions: await store.listVersions(id) });
});

const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('publish'), changelog: z.string().max(1000).optional() }),
  z.object({ action: z.literal('rollback'), version: z.number().int().positive() }),
]);

export const POST = route(async (request: Request, { params }: Params) => {
  const { id } = await params;
  const body = await parseBody(request, actionSchema);
  const { store } = await getRuntime();

  if (!(await store.getWorkflow(id))) throw notFound('Workflow');

  const version =
    body.action === 'publish'
      ? await store.publish(id, body.changelog)
      : await store.rollback(id, body.version);

  await store.flush();
  return json({ version, workflow: await store.getWorkflow(id) });
});
