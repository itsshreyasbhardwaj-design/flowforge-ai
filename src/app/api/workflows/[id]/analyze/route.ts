import { z } from 'zod';
import { analyzeWorkflow, applyAllFixes, applyFix } from '@/core/assistant/analyzer';
import { getRuntime } from '@/server/runtime';
import { json, notFound, parseBody, route } from '@/server/api';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/** Static review of the draft, enriched with evidence from recent runs. */
export const GET = route(async (_request: Request, { params }: Params) => {
  const { id } = await params;
  const { store, registry } = await getRuntime();

  const graph = await store.resolveGraph(id);
  if (!graph) throw notFound('Workflow');

  const runs = await store.listRuns({ workflowId: id, limit: 25 });
  return json({
    suggestions: analyzeWorkflow(
      graph,
      registry,
      runs.map((r) => r.trace),
    ),
  });
});

const fixSchema = z.object({
  suggestionId: z.string().optional(),
  all: z.boolean().default(false),
});

/** Applies one suggestion, or every auto-fixable one, to the draft. */
export const POST = route(async (request: Request, { params }: Params) => {
  const { id } = await params;
  const body = await parseBody(request, fixSchema);
  const { store, registry } = await getRuntime();

  const graph = await store.resolveGraph(id);
  if (!graph) throw notFound('Workflow');

  const runs = await store.listRuns({ workflowId: id, limit: 25 });
  const suggestions = analyzeWorkflow(
    graph,
    registry,
    runs.map((r) => r.trace),
  );

  if (body.all) {
    const { workflow, applied } = applyAllFixes(graph, suggestions);
    await store.saveDraft(id, workflow);
    await store.flush();
    return json({ graph: workflow, applied });
  }

  const suggestion = suggestions.find((s) => s.id === body.suggestionId);
  if (!suggestion?.fix) throw notFound('Auto-fixable suggestion');

  const updated = applyFix(graph, suggestion.fix);
  await store.saveDraft(id, updated);
  await store.flush();
  return json({ graph: updated, applied: [suggestion.title] });
});
