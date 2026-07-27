import { getRuntime, newId } from '@/server/runtime';
import { json, notFound, route } from '@/server/api';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/** Clones a marketplace template into a new, independently editable workflow. */
export const POST = route(async (_request: Request, { params }: Params) => {
  const { id } = await params;
  const { store } = await getRuntime();

  const template = await store.getTemplate(id);
  if (!template) throw notFound('Template');

  const workflowId = newId('wf');
  const now = new Date().toISOString();
  const graph = { ...structuredClone(template.graph), id: workflowId };

  const record = await store.createWorkflow(
    {
      id: workflowId,
      name: template.name,
      description: template.description,
      ownerId: 'local',
      tags: template.tags,
      createdAt: now,
      updatedAt: now,
      draftVersion: 1,
    },
    graph,
  );

  await store.saveTemplate({ ...template, downloads: template.downloads + 1 });
  await store.flush();

  return json({ workflow: record }, { status: 201 });
});
