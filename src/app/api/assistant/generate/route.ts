import { z } from 'zod';
import { generateWorkflow } from '@/core/assistant/generate';
import { getRuntime, newId } from '@/server/runtime';
import { clientKey, json, parseBody, rateLimit, route } from '@/server/api';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const generateSchema = z.object({
  prompt: z.string().min(8).max(4000),
  model: z.string().optional(),
  save: z.boolean().default(false),
});

export const POST = route(async (request: Request) => {
  const body = await parseBody(request, generateSchema);
  rateLimit(clientKey(request, 'assistant'), 20);

  const { registry, store } = await getRuntime();
  const workflowId = newId('wf');

  const result = await generateWorkflow({
    prompt: body.prompt,
    registry,
    provider: registry.llm(),
    model: body.model,
    workflowId,
  });

  if (body.save && result.workflow.nodes.length > 0) {
    const now = new Date().toISOString();
    await store.createWorkflow(
      {
        id: workflowId,
        name: result.workflow.name,
        description: result.workflow.description,
        ownerId: 'local',
        tags: ['generated'],
        createdAt: now,
        updatedAt: now,
        draftVersion: 1,
      },
      result.workflow,
    );
    await store.flush();
  }

  return json({
    workflow: result.workflow,
    issues: result.issues,
    repairs: result.repairs,
    saved: body.save && result.workflow.nodes.length > 0,
  });
});
