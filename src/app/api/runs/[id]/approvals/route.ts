import { z } from 'zod';
import { getRuntime } from '@/server/runtime';
import { json, notFound, parseBody, route } from '@/server/api';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

const approvalSchema = z.object({
  nodeId: z.string().min(1),
  decision: z.enum(['approved', 'rejected']),
  comment: z.string().max(2000).optional(),
  reviewer: z.string().max(120).optional(),
});

/**
 * Records a human decision on a suspended run.
 *
 * The decision is stored on the run record; re-running the workflow reads it back
 * through run state, which is what lets the Human Approval node proceed. Approvals
 * are therefore auditable — who decided what, and when — rather than a transient
 * in-memory flag.
 */
export const POST = route(async (request: Request, { params }: Params) => {
  const { id } = await params;
  const body = await parseBody(request, approvalSchema);
  const { store } = await getRuntime();

  const run = await store.getRun(id);
  if (!run) throw notFound('Run');

  const approvals = {
    ...((run.trace.nodes[body.nodeId]?.debug?.approvals as Record<string, unknown>) ?? {}),
    [body.nodeId]: {
      decision: body.decision,
      comment: body.comment,
      reviewer: body.reviewer ?? 'local',
      at: new Date().toISOString(),
    },
  };

  await store.saveRun({
    ...run,
    trace: {
      ...run.trace,
      nodes: {
        ...run.trace.nodes,
        [body.nodeId]: {
          ...(run.trace.nodes[body.nodeId] ?? {
            nodeId: body.nodeId,
            status: 'suspended',
            attempts: 0,
            logs: [],
          }),
          debug: { approvals },
        },
      },
    },
  });
  await store.flush();

  return json({ ok: true, approvals });
});
