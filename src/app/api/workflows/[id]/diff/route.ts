import { diffWorkflows, summarizeDiff } from '@/core/versioning/diff';
import { getRuntime } from '@/server/runtime';
import { badRequest, json, notFound, route } from '@/server/api';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export const GET = route(async (request: Request, { params }: Params) => {
  const { id } = await params;
  const url = new URL(request.url);
  const from = Number(url.searchParams.get('from'));
  const to = Number(url.searchParams.get('to'));

  if (!Number.isInteger(from) || !Number.isInteger(to)) {
    throw badRequest('Both "from" and "to" must be version numbers');
  }

  const { store } = await getRuntime();
  const [before, after] = await Promise.all([
    store.getVersion(id, from),
    store.getVersion(id, to),
  ]);
  if (!before || !after) throw notFound('Version');

  const diff = diffWorkflows(before.graph, after.graph);
  return json({ diff, summary: summarizeDiff(diff), from, to });
});
