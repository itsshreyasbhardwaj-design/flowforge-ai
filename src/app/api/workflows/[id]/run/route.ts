import { z } from 'zod';
import { reduceTrace, type RunTrace } from '@/core/runtime/events';
import { getRuntime, newId } from '@/server/runtime';
import { clientKey, json, notFound, parseBody, rateLimit, route } from '@/server/api';

export const dynamic = 'force-dynamic';
// Streaming a run can outlive the default serverless budget on a long workflow.
export const maxDuration = 300;

type Params = { params: Promise<{ id: string }> };

const runSchema = z.object({
  input: z.unknown().optional(),
  version: z.number().int().positive().optional(),
  stream: z.boolean().default(true),
});

/**
 * Executes a workflow, streaming trace events as they happen.
 *
 * The response is Server-Sent Events carrying the exact `TraceEvent` union the
 * executor emits, so the debugger folds them with the same reducer the server
 * uses to persist the final trace. There is no second, drifting representation
 * of what happened during a run.
 */
export const POST = route(async (request: Request, { params }: Params) => {
  const { id } = await params;
  const body = await parseBody(request, runSchema);
  rateLimit(clientKey(request, 'run'), 60);

  const { store, executor } = await getRuntime();
  const record = await store.getWorkflow(id);
  if (!record) throw notFound('Workflow');

  const graph = await store.resolveGraph(id, body.version ?? record.draftVersion);
  if (!graph) throw notFound('Workflow version');

  const runId = newId('run');
  const version = body.version ?? record.draftVersion;

  const persist = async (trace: RunTrace): Promise<void> => {
    await store.saveRun({
      id: runId,
      workflowId: id,
      version,
      trace,
      createdAt: new Date(trace.startedAt).toISOString(),
    });
    await store.flush();
  };

  if (!body.stream) {
    const trace = await executor.execute(graph, {
      runId,
      input: body.input,
      trigger: 'manual',
    });
    await persist(trace);
    return json({ runId, trace });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let trace: RunTrace | undefined;
      const send = (event: unknown): void => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      try {
        for await (const event of executor.run(graph, {
          runId,
          input: body.input,
          trigger: 'manual',
          workflowVersion: version,
        })) {
          trace = reduceTrace(trace, event);
          send(event);
        }
        if (trace) await persist(trace);
      } catch (error) {
        send({
          kind: 'run.finished',
          runId,
          at: Date.now(),
          status: 'failed',
          durationMs: 0,
          output: {},
          usage: {},
          error: {
            name: 'Error',
            message: error instanceof Error ? error.message : String(error),
          },
        });
      } finally {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Run-Id': runId,
    },
  });
});
