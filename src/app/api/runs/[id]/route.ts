import { getRuntime } from '@/server/runtime';
import { json, notFound, route } from '@/server/api';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export const GET = route(async (_request: Request, { params }: Params) => {
  const { id } = await params;
  const { store } = await getRuntime();

  const run = await store.getRun(id);
  if (!run) throw notFound('Run');

  const graph = await store.resolveGraph(run.workflowId, run.version);
  return json({ run, graph });
});
