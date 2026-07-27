import { getRuntime } from '@/server/runtime';
import { json, route } from '@/server/api';

export const dynamic = 'force-dynamic';

export const GET = route(async (request: Request) => {
  const url = new URL(request.url);
  const { store } = await getRuntime();

  const runs = await store.listRuns({
    workflowId: url.searchParams.get('workflowId') ?? undefined,
    status: (url.searchParams.get('status') as never) ?? undefined,
    limit: Number(url.searchParams.get('limit') ?? 50),
  });

  // The list view only needs headline numbers; full traces can be megabytes.
  return json({
    runs: runs.map((run) => ({
      id: run.id,
      workflowId: run.workflowId,
      version: run.version,
      createdAt: run.createdAt,
      status: run.trace.status,
      durationMs: run.trace.durationMs,
      usage: run.trace.usage,
      nodeCount: Object.keys(run.trace.nodes).length,
      error: run.trace.error?.message,
      trigger: run.trace.trigger,
    })),
  });
});
