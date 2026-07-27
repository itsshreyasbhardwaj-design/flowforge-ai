'use client';

import { useCallback, useEffect, useState } from 'react';
import * as Icons from 'lucide-react';
import type { Workflow } from '@/core/graph/types';
import type { Suggestion } from '@/core/assistant/analyzer';
import { Badge, Button, Textarea } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';
import { useEditor } from './store';

type Mode = 'review' | 'generate';

/**
 * The workflow assistant.
 *
 * Review runs entirely offline: it is deterministic static analysis over the
 * graph plus recent traces, so it costs nothing and returns instantly. Generate
 * is the only path that calls a model, and its output is repaired against the
 * live node registry before it ever reaches the canvas.
 */
export function AssistantDialog({
  open,
  onOpenChange,
  workflowId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workflowId: string;
}) {
  const [mode, setMode] = useState<Mode>('review');
  const [prompt, setPrompt] = useState('');
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Bumped after a fix is applied to re-run the review below.
  const [reviewToken, setReviewToken] = useState(0);
  const reloadReview = useCallback(() => setReviewToken((n) => n + 1), []);

  // Review is a plain subscription to an external resource: state is set from the
  // promise callback, never synchronously in the effect body, and the request is
  // aborted if the dialog closes before it lands.
  useEffect(() => {
    if (!open || mode !== 'review') return;
    const controller = new AbortController();

    fetch(`/api/workflows/${workflowId}/analyze`, { signal: controller.signal })
      .then((response) => response.json() as Promise<{ suggestions: Suggestion[] }>)
      .then((data) => setSuggestions(data.suggestions))
      .catch(() => {
        /* aborted, or the analyzer is unreachable; the panel stays as-is */
      });

    return () => controller.abort();
  }, [open, mode, workflowId, reviewToken]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onOpenChange(false);
    };
    if (open) window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);

  const applyFix = async (suggestionId: string) => {
    setBusy(true);
    try {
      const response = await fetch(`/api/workflows/${workflowId}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ suggestionId }),
      });
      const data = (await response.json()) as { graph?: Workflow; applied?: string[] };
      if (data.graph) {
        useEditor.getState().setGraph(data.graph, { dirty: false });
        setNotice(`Applied: ${data.applied?.[0] ?? 'fix'}`);
        reloadReview();
      }
    } finally {
      setBusy(false);
    }
  };

  const applyAll = async () => {
    setBusy(true);
    try {
      const response = await fetch(`/api/workflows/${workflowId}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true }),
      });
      const data = (await response.json()) as { graph?: Workflow; applied?: string[] };
      if (data.graph) {
        useEditor.getState().setGraph(data.graph, { dirty: false });
        setNotice(`Applied ${data.applied?.length ?? 0} fix(es)`);
        reloadReview();
      }
    } finally {
      setBusy(false);
    }
  };

  const generate = async () => {
    if (prompt.trim().length < 8) return;
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch('/api/assistant/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });
      const data = (await response.json()) as {
        workflow: Workflow;
        issues: string[];
        repairs: string[];
      };

      if (data.workflow.nodes.length === 0) {
        setNotice(
          data.issues[0] ??
            'The model returned nothing usable. Offline mode uses a deterministic mock — set OPENROUTER_API_KEY for real generation.',
        );
        return;
      }

      const current = useEditor.getState().graph;
      useEditor.getState().setGraph({ ...data.workflow, id: current.id, name: current.name });
      setNotice(
        [
          `Generated ${data.workflow.nodes.length} nodes.`,
          data.repairs.length ? `${data.repairs.length} auto-repair(s).` : '',
          data.issues.length ? `${data.issues.length} issue(s) left to fix.` : '',
        ]
          .filter(Boolean)
          .join(' '),
      );
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  const autoFixable = (suggestions ?? []).filter((s) => s.fix).length;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-24 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Workflow assistant"
      onClick={(event) => {
        if (event.target === event.currentTarget) onOpenChange(false);
      }}
    >
      <div className="panel flex max-h-[70vh] w-full max-w-2xl flex-col overflow-hidden shadow-2xl">
        <header className="border-border flex items-center gap-2 border-b px-4 py-3">
          <Icons.Sparkles className="text-accent size-4" />
          <h2 className="text-ink text-sm font-semibold">Assistant</h2>

          <div className="border-border bg-surface-2 ml-3 flex rounded-lg border p-0.5">
            {(['review', 'generate'] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setMode(value)}
                className={cn(
                  'rounded-md px-2.5 py-1 text-[11px] font-medium capitalize transition-colors',
                  mode === value
                    ? 'bg-surface-3 text-ink'
                    : 'text-ink-subtle hover:text-ink-muted',
                )}
              >
                {value}
              </button>
            ))}
          </div>

          <Button
            size="icon-sm"
            variant="ghost"
            className="ml-auto"
            onClick={() => onOpenChange(false)}
            aria-label="Close"
          >
            <Icons.X />
          </Button>
        </header>

        {notice ? (
          <p className="border-border bg-accent/8 text-accent-soft border-b px-4 py-2 text-[11px]">
            {notice}
          </p>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {mode === 'generate' ? (
            <div className="space-y-3 p-4">
              <p className="text-ink-muted text-xs leading-relaxed">
                Describe the workflow. The assistant only uses nodes that are actually
                installed, and repairs invalid ports before loading the result onto your canvas.
              </p>
              <Textarea
                rows={5}
                autoFocus
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Read a support ticket from a webhook, classify its urgency, escalate urgent ones to Slack after human approval, and auto-reply to the rest."
              />
              <div className="flex items-center gap-2">
                <Button
                  variant="primary"
                  onClick={generate}
                  disabled={busy || prompt.length < 8}
                >
                  {busy ? <Icons.Loader2 className="animate-spin" /> : <Icons.Wand2 />}
                  Generate
                </Button>
                <p className="text-ink-subtle text-[10px]">
                  Replaces the current canvas contents.
                </p>
              </div>
            </div>
          ) : (
            <div className="p-2">
              {busy && !suggestions ? (
                <p className="text-ink-subtle px-3 py-8 text-center text-xs">Analysing…</p>
              ) : null}

              {suggestions?.length === 0 ? (
                <div className="px-3 py-10 text-center">
                  <Icons.ShieldCheck className="text-positive mx-auto size-6" />
                  <p className="text-ink mt-2 text-sm font-medium">Nothing to flag</p>
                  <p className="text-ink-subtle mt-1 text-xs">
                    No structural, cost, reliability, or security issues found.
                  </p>
                </div>
              ) : null}

              {suggestions?.map((suggestion) => (
                <article
                  key={suggestion.id}
                  className="hover:bg-surface-2 rounded-lg px-3 py-2.5 transition-colors"
                >
                  <div className="flex items-start gap-2">
                    <SeverityBadge severity={suggestion.severity} />
                    <div className="min-w-0 flex-1">
                      <p className="text-ink text-xs font-medium">{suggestion.title}</p>
                      <p className="text-ink-muted mt-0.5 text-[11px] leading-relaxed">
                        {suggestion.detail}
                      </p>
                    </div>
                    {suggestion.fix ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy}
                        onClick={() => applyFix(suggestion.id)}
                      >
                        Fix
                      </Button>
                    ) : null}
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>

        {mode === 'review' && autoFixable > 0 ? (
          <footer className="border-border flex items-center gap-2 border-t px-4 py-2.5">
            <p className="text-ink-subtle text-[11px]">
              {autoFixable} suggestion{autoFixable === 1 ? '' : 's'} can be applied
              automatically.
            </p>
            <Button
              size="sm"
              variant="primary"
              className="ml-auto"
              onClick={applyAll}
              disabled={busy}
            >
              <Icons.Wand2 /> Fix all
            </Button>
          </footer>
        ) : null}
      </div>
    </div>
  );
}

function SeverityBadge({ severity }: { severity: Suggestion['severity'] }) {
  const map = {
    critical: { tone: 'danger', icon: Icons.AlertCircle },
    warning: { tone: 'warning', icon: Icons.AlertTriangle },
    info: { tone: 'info', icon: Icons.Info },
  } as const;
  const { tone, icon: Icon } = map[severity];
  return (
    <Badge tone={tone} className="mt-0.5 shrink-0">
      <Icon className="size-3" />
    </Badge>
  );
}
