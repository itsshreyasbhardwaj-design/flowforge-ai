'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import * as Icons from 'lucide-react';
import type { Workflow } from '@/core/graph/types';
import { validateWorkflow } from '@/core/graph/validate';
import type { TraceEvent } from '@/core/runtime/events';
import type { NodeCatalogue, NodeDescriptor } from '@/lib/types';
import { Badge, Button } from '@/components/ui/primitives';
import { formatRelativeTime } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Canvas } from './canvas';
import { DebuggerPanel } from './debugger';
import { Inspector } from './inspector';
import { Palette } from './palette';
import { AssistantDialog } from './assistant-dialog';
import { useEditor } from './store';

const AUTOSAVE_DELAY_MS = 900;

export function Editor({
  workflowId,
  initialGraph,
  publishedVersion,
  draftVersion,
}: {
  workflowId: string;
  initialGraph: Workflow;
  publishedVersion?: number;
  draftVersion: number;
}) {
  const graph = useEditor((s) => s.graph);
  const dirty = useEditor((s) => s.dirty);
  const saving = useEditor((s) => s.saving);
  const lastSavedAt = useEditor((s) => s.lastSavedAt);
  const validation = useEditor((s) => s.validation);
  const runPhase = useEditor((s) => s.runPhase);
  const catalogue = useEditor((s) => s.catalogue);

  const [input, setInput] = useState('{}');
  const [panelHeight, setPanelHeight] = useState(280);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [publishState, setPublishState] = useState<'idle' | 'busy' | 'done'>('idle');
  const abortRef = useRef<AbortController | null>(null);

  // --- bootstrap ----------------------------------------------------------
  useEffect(() => {
    useEditor.setState({
      graph: initialGraph,
      dirty: false,
      past: [],
      future: [],
      trace: null,
      runPhase: 'idle',
      selectedNodeId: null,
    });
  }, [initialGraph]);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/nodes')
      .then((r) => r.json() as Promise<NodeCatalogue>)
      .then((data) => {
        if (!cancelled) useEditor.getState().setCatalogue(data.nodes);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Validation runs client-side on every edit. It is pure and fast, so there is
  // no reason to wait for a network round trip to tell someone a port is wrong.
  useEffect(() => {
    if (catalogue.length === 0) return;
    useEditor.getState().setValidation(validateWorkflow(graph, buildClientRegistry(catalogue)));
  }, [graph, catalogue]);

  const save = useCallback(async () => {
    const current = useEditor.getState();
    if (!current.dirty) return;
    current.setSaving(true);
    try {
      await fetch(`/api/workflows/${workflowId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ graph: current.graph, name: current.graph.name }),
      });
      useEditor.getState().markSaved();
    } catch {
      useEditor.getState().setSaving(false);
    }
  }, [workflowId]);

  useEffect(() => {
    if (!dirty) return;
    const timer = setTimeout(save, AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [dirty, graph, save]);

  // --- run ----------------------------------------------------------------
  const run = useCallback(async () => {
    const store = useEditor.getState();
    await save();
    store.startRun();

    let payload: unknown = {};
    try {
      payload = JSON.parse(input || '{}');
    } catch {
      payload = {};
    }

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch(`/api/workflows/${workflowId}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: payload, stream: true }),
        signal: controller.signal,
      });
      if (!response.body) throw new Error('No response stream');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          const line = frame.trim();
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') continue;
          try {
            useEditor.getState().applyTraceEvent(JSON.parse(data) as TraceEvent);
          } catch {
            /* ignore malformed frames rather than killing the stream */
          }
        }
      }
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        useEditor.getState().applyTraceEvent({
          kind: 'run.finished',
          runId: 'local',
          at: Date.now(),
          status: 'failed',
          durationMs: 0,
          output: {},
          usage: {},
          error: { name: 'NetworkError', message: (error as Error).message },
        });
      }
    } finally {
      abortRef.current = null;
      useEditor.getState().finishRun();
    }
  }, [workflowId, input, save]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    useEditor.getState().finishRun();
  }, []);

  const publish = useCallback(async () => {
    setPublishState('busy');
    await save();
    await fetch(`/api/workflows/${workflowId}/versions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'publish' }),
    });
    setPublishState('done');
    setTimeout(() => setPublishState('idle'), 2200);
  }, [workflowId, save]);

  // --- keyboard -----------------------------------------------------------
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable;

      if (meta && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setAssistantOpen(true);
        return;
      }
      if (meta && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void save();
        return;
      }
      if (meta && event.key === 'Enter') {
        event.preventDefault();
        void run();
        return;
      }
      if (typing) return;

      if (meta && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) useEditor.getState().redo();
        else useEditor.getState().undo();
        return;
      }
      if (meta && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        const id = useEditor.getState().selectedNodeId;
        if (id) useEditor.getState().duplicateNode(id);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [run, save]);

  // Warn before losing an unsaved edit to a hard navigation.
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (useEditor.getState().dirty) event.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  const errorCount = validation?.errors.length ?? 0;
  const warningCount = validation?.warnings.length ?? 0;

  return (
    <div className="flex h-full flex-col">
      <header className="border-border bg-surface flex h-12 shrink-0 items-center gap-3 border-b px-3">
        <Link
          href="/workflows"
          className="text-ink-subtle hover:bg-surface-2 hover:text-ink grid size-7 place-items-center rounded-md transition-colors"
          aria-label="Back to workflows"
        >
          <Icons.ChevronLeft className="size-4" />
        </Link>

        {/* Controlled only. The store is seeded from `initialGraph`, so a defaultValue here
            would make React treat the field as both controlled and uncontrolled. */}
        <input
          value={graph.name}
          onChange={(e) => useEditor.getState().setMeta({ name: e.target.value })}
          aria-label="Workflow name"
          className="text-ink hover:border-border focus-visible:focus-ring max-w-xs min-w-0 rounded-md border border-transparent bg-transparent px-2 py-1 text-sm font-semibold transition-colors"
        />

        <div className="text-ink-subtle flex items-center gap-1.5 text-[11px]">
          {saving ? (
            <>
              <Icons.Loader2 className="size-3 animate-spin" /> Saving
            </>
          ) : dirty ? (
            <>
              <span className="bg-warning size-1.5 rounded-full" /> Unsaved
            </>
          ) : lastSavedAt ? (
            <>
              <Icons.Check className="text-positive size-3" /> Saved{' '}
              {formatRelativeTime(lastSavedAt)}
            </>
          ) : null}
        </div>

        <div className="ml-2 flex items-center gap-1.5">
          {errorCount > 0 ? (
            <Badge tone="danger">
              <Icons.AlertCircle className="size-3" /> {errorCount} error
              {errorCount === 1 ? '' : 's'}
            </Badge>
          ) : null}
          {warningCount > 0 ? (
            <Badge tone="warning">
              <Icons.AlertTriangle className="size-3" /> {warningCount}
            </Badge>
          ) : null}
          {errorCount === 0 && warningCount === 0 && graph.nodes.length > 0 ? (
            <Badge tone="positive">
              <Icons.ShieldCheck className="size-3" /> Valid
            </Badge>
          ) : null}
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => setAssistantOpen(true)}>
            <Icons.Sparkles /> Assistant
            <kbd className="border-border bg-surface-3 ml-1 rounded border px-1 font-mono text-[9px]">
              ⌘K
            </kbd>
          </Button>
          <Button size="sm" variant="ghost" asChild>
            <Link href={`/workflows/${workflowId}/versions`}>
              <Icons.GitBranch /> v{draftVersion}
              {publishedVersion ? ` · live v${publishedVersion}` : ''}
            </Link>
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={publish}
            disabled={publishState === 'busy' || errorCount > 0}
            title={errorCount > 0 ? 'Fix validation errors before publishing' : undefined}
          >
            {publishState === 'done' ? <Icons.Check /> : <Icons.Rocket />}
            {publishState === 'done' ? 'Published' : 'Publish'}
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={runPhase === 'running' ? cancel : run}
            disabled={errorCount > 0 && runPhase !== 'running'}
          >
            {runPhase === 'running' ? <Icons.Square /> : <Icons.Play />}
            {runPhase === 'running' ? 'Stop' : 'Run'}
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <Palette />

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1">
            <Canvas />
          </div>

          <ResizeHandle height={panelHeight} onResize={setPanelHeight} />

          <div className="border-border shrink-0 border-t" style={{ height: panelHeight }}>
            <DebuggerPanel
              input={input}
              onInputChange={setInput}
              onRun={run}
              onCancel={cancel}
            />
          </div>
        </div>

        <Inspector />
      </div>

      <datalist id="flowforge-models">
        {catalogue
          .filter((d) => d.category === 'model' || d.category === 'agent')
          .flatMap((d) => Object.keys(d.defaults))
          .slice(0, 0)}
        {MODEL_HINTS.map((model) => (
          <option key={model} value={model} />
        ))}
      </datalist>

      <AssistantDialog
        open={assistantOpen}
        onOpenChange={setAssistantOpen}
        workflowId={workflowId}
      />
    </div>
  );
}

const MODEL_HINTS = [
  'flowforge/mock',
  'anthropic/claude-sonnet-4.5',
  'anthropic/claude-haiku-4.5',
  'openai/gpt-4.1',
  'openai/gpt-4.1-mini',
  'google/gemini-2.5-pro',
  'meta-llama/llama-3.3-70b-instruct',
];

function ResizeHandle({
  height,
  onResize,
}: {
  height: number;
  onResize: (height: number) => void;
}) {
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize debugger panel"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'ArrowUp') onResize(Math.min(700, height + 24));
        if (event.key === 'ArrowDown') onResize(Math.max(48, height - 24));
      }}
      onPointerDown={(event) => {
        const startY = event.clientY;
        const startHeight = height;
        const move = (e: PointerEvent) => {
          onResize(Math.min(700, Math.max(48, startHeight - (e.clientY - startY))));
        };
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      }}
      className={cn(
        'group bg-border/40 hover:bg-accent/40 focus-visible:focus-ring flex h-1.5 shrink-0 cursor-row-resize items-center justify-center transition-colors',
      )}
    >
      <span className="bg-border-strong group-hover:bg-accent h-0.5 w-8 rounded-full transition-colors" />
    </div>
  );
}

/**
 * Minimal registry shim so the shared validator can run in the browser.
 *
 * The real registry holds Zod schemas and `execute` functions, neither of which
 * can cross the wire. Structural validation — ports, types, cycles, references —
 * only needs the port specs, so the client rebuilds exactly that much and reuses
 * the identical `validateWorkflow` the server runs before every execution.
 */
function buildClientRegistry(catalogue: NodeDescriptor[]) {
  const byType = new Map(catalogue.map((d) => [d.type, d]));
  const stub = {
    tryGet: (type: string) => {
      const descriptor = byType.get(type);
      if (!descriptor) return undefined;
      return {
        ...descriptor,
        // Config is schema-checked on the server, where the real schema lives.
        configSchema: { safeParse: () => ({ success: true as const, data: {} }) },
      };
    },
  };
  return stub as unknown as Parameters<typeof validateWorkflow>[1];
}
