import { z } from 'zod';
import { EvalRunner, compareEvalRuns } from '@/core/eval/runner';
import { BUILTIN_METRICS } from '@/core/eval/metrics';
import { getRuntime, newId } from '@/server/runtime';
import { badRequest, json, notFound, parseBody, route } from '@/server/api';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export const GET = route(async (request: Request) => {
  const url = new URL(request.url);
  const { store } = await getRuntime();
  const workflowId = url.searchParams.get('workflowId') ?? undefined;

  const suites = await store.listSuites(workflowId);
  const runs = await store.listEvalRuns();

  return json({
    suites,
    runs: runs.filter((r) => !workflowId || r.workflowId === workflowId),
    metrics: BUILTIN_METRICS.map(({ id, label, description, direction, unit }) => ({
      id,
      label,
      description,
      direction,
      unit,
    })),
  });
});

const bodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('createSuite'),
    workflowId: z.string().min(1),
    name: z.string().min(1).max(120),
    description: z.string().max(2000).optional(),
    metrics: z.array(z.string()).min(1),
    cases: z
      .array(
        z.object({
          id: z.string().optional(),
          input: z.unknown(),
          expected: z.unknown().optional(),
          tags: z.record(z.string(), z.string()).optional(),
        }),
      )
      .min(1)
      .max(500),
  }),
  z.object({
    action: z.literal('run'),
    suiteId: z.string().min(1),
    version: z.number().int().positive().optional(),
    label: z.string().max(120).optional(),
  }),
  z.object({
    action: z.literal('compare'),
    baselineRunId: z.string().min(1),
    candidateRunId: z.string().min(1),
  }),
]);

export const POST = route(async (request: Request) => {
  const body = await parseBody(request, bodySchema);
  const { store, executor } = await getRuntime();

  if (body.action === 'createSuite') {
    const suite = {
      id: newId('suite'),
      workflowId: body.workflowId,
      name: body.name,
      description: body.description,
      metrics: body.metrics,
      cases: body.cases.map((c, i) => ({ ...c, id: c.id ?? `case_${i + 1}` })),
      createdAt: new Date().toISOString(),
    };
    await store.saveSuite(suite);
    await store.flush();
    return json({ suite }, { status: 201 });
  }

  if (body.action === 'compare') {
    const runs = await store.listEvalRuns();
    const baseline = runs.find((r) => r.id === body.baselineRunId);
    const candidate = runs.find((r) => r.id === body.candidateRunId);
    if (!baseline || !candidate) throw notFound('Evaluation run');
    if (baseline.suiteId !== candidate.suiteId) {
      throw badRequest('Both runs must come from the same suite to be comparable');
    }
    return json({ comparison: compareEvalRuns(baseline, candidate) });
  }

  const suite = await store.getSuite(body.suiteId);
  if (!suite) throw notFound('Suite');

  const record = await store.getWorkflow(suite.workflowId);
  if (!record) throw notFound('Workflow');

  const version = body.version ?? record.publishedVersion ?? record.draftVersion;
  const graph = await store.resolveGraph(suite.workflowId, version);
  if (!graph) throw notFound('Workflow version');

  const runner = new EvalRunner({ executor, concurrency: 4, idFactory: () => newId('ev') });
  const evalRun = await runner.run({ suite, graph, version, label: body.label });

  await store.saveEvalRun(evalRun);
  await store.flush();

  return json({ run: evalRun }, { status: 201 });
});
