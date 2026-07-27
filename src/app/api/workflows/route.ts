import { z } from 'zod';
import { emptyWorkflow } from '@/core/graph/types';
import { getRuntime, newId } from '@/server/runtime';
import { json, parseBody, route } from '@/server/api';

export const dynamic = 'force-dynamic';

export const GET = route(async () => {
  const { store } = await getRuntime();
  const workflows = await store.listWorkflows();

  const enriched = await Promise.all(
    workflows.map(async (record) => {
      const graph = await store.resolveGraph(record.id);
      const runs = await store.listRuns({ workflowId: record.id, limit: 20 });
      const succeeded = runs.filter((r) => r.trace.status === 'succeeded').length;
      return {
        ...record,
        nodeCount: graph?.nodes.length ?? 0,
        runCount: runs.length,
        successRate: runs.length ? succeeded / runs.length : null,
        lastRunAt: runs[0]?.createdAt,
      };
    }),
  );

  return json({ workflows: enriched });
});

const createSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  templateId: z.string().optional(),
});

export const POST = route(async (request: Request) => {
  const body = await parseBody(request, createSchema);
  const { store } = await getRuntime();

  const id = newId('wf');
  const now = new Date().toISOString();

  // Cloning a template copies its graph but not its identity, so edits never
  // leak back into the shared template.
  const template = body.templateId ? await store.getTemplate(body.templateId) : undefined;
  const graph = template
    ? { ...structuredClone(template.graph), id, name: body.name }
    : emptyWorkflow(id, body.name);

  const record = await store.createWorkflow(
    {
      id,
      name: body.name,
      description: body.description ?? template?.description,
      ownerId: 'local',
      tags: template?.tags ?? [],
      createdAt: now,
      updatedAt: now,
      draftVersion: 1,
    },
    graph,
  );

  if (template) {
    await store.saveTemplate({ ...template, downloads: template.downloads + 1 });
  }
  await store.flush();

  return json({ workflow: record, graph }, { status: 201 });
});
