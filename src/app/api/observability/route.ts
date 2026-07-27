import { aggregateRuns } from '@/core/telemetry/aggregate';
import { getRuntime } from '@/server/runtime';
import { json, route } from '@/server/api';

export const dynamic = 'force-dynamic';

export const GET = route(async (request: Request) => {
  const url = new URL(request.url);
  const { store } = await getRuntime();

  const hours = Math.min(720, Math.max(1, Number(url.searchParams.get('hours') ?? 24)));
  const runs = await store.listRuns({
    workflowId: url.searchParams.get('workflowId') ?? undefined,
    limit: 1000,
  });

  const workflows = await store.listWorkflows();
  const nameById = new Map(workflows.map((w) => [w.id, w.name]));

  const summary = aggregateRuns(runs, {
    bucketMs: hours <= 48 ? 3_600_000 : 86_400_000,
    buckets: hours <= 48 ? hours : Math.ceil(hours / 24),
  });

  return json({
    summary,
    workflows: workflows.map((w) => ({ id: w.id, name: w.name })),
    byWorkflow: [...new Set(runs.map((r) => r.workflowId))].map((workflowId) => {
      const scoped = runs.filter((r) => r.workflowId === workflowId);
      const succeeded = scoped.filter((r) => r.trace.status === 'succeeded').length;
      return {
        workflowId,
        name: nameById.get(workflowId) ?? workflowId,
        runs: scoped.length,
        successRate: scoped.length ? succeeded / scoped.length : 0,
        costUsd: Number(
          scoped.reduce((sum, r) => sum + (r.trace.usage.costUsd ?? 0), 0).toFixed(6),
        ),
      };
    }),
  });
});
