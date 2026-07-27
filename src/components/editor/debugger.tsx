'use client';

import { useMemo, useState } from 'react';
import * as Icons from 'lucide-react';
import type { NodeTrace } from '@/core/runtime/events';
import { Badge, Button, EmptyState, Textarea } from '@/components/ui/primitives';
import { formatCost, formatDuration, formatTokens, prettyJson } from '@/lib/format';
import { cn } from '@/lib/cn';
import { useEditor } from './store';

type Tab = 'timeline' | 'output' | 'logs' | 'input';

/**
 * Run debugger.
 *
 * The timeline is a real Gantt: each node's bar is positioned by its actual start
 * offset and width by its duration, so overlapping bars *are* the proof that two
 * branches ran concurrently. Reading a flat list of steps cannot show that, and
 * "why is this slow" is almost always a question about overlap.
 */
export function DebuggerPanel({
  input,
  onInputChange,
  onRun,
  onCancel,
}: {
  input: string;
  onInputChange: (value: string) => void;
  onRun: () => void;
  onCancel: () => void;
}) {
  const trace = useEditor((s) => s.trace);
  const runPhase = useEditor((s) => s.runPhase);
  const select = useEditor((s) => s.select);
  const selectedNodeId = useEditor((s) => s.selectedNodeId);
  const graph = useEditor((s) => s.graph);
  const [tab, setTab] = useState<Tab>('timeline');

  const labelOf = useMemo(() => {
    const map = new Map(graph.nodes.map((n) => [n.id, n.label ?? n.type]));
    return (id: string) => map.get(id) ?? id;
  }, [graph.nodes]);

  const timeline = useMemo(() => {
    if (!trace) return { rows: [], span: 1 };
    const rows = trace.order
      .map((id) => trace.nodes[id])
      .filter((n): n is NodeTrace => Boolean(n));
    const start = trace.startedAt;
    // The timeline's right edge is the latest timestamp the trace itself reports,
    // not wall-clock. Reading the clock during render is impure — it would make
    // in-flight bars creep on every unrelated re-render.
    const end = Math.max(
      trace.finishedAt ?? 0,
      ...rows.map((r) => r.finishedAt ?? r.startedAt ?? 0),
      start + 1,
    );
    return { rows, span: Math.max(1, end - start) };
  }, [trace]);

  const logs = useMemo(
    () =>
      Object.values(trace?.nodes ?? {})
        .flatMap((node) => node.logs.map((entry) => ({ ...entry, nodeId: node.nodeId })))
        .sort((a, b) => a.at - b.at),
    [trace],
  );

  return (
    <div className="bg-surface flex h-full flex-col">
      <header className="border-border flex items-center gap-2 border-b px-3 py-2">
        <div className="border-border bg-surface-2 flex rounded-lg border p-0.5">
          {(['timeline', 'output', 'logs', 'input'] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setTab(value)}
              className={cn(
                'rounded-md px-2.5 py-1 text-[11px] font-medium capitalize transition-colors',
                tab === value
                  ? 'bg-surface-3 text-ink'
                  : 'text-ink-subtle hover:text-ink-muted',
              )}
            >
              {value}
            </button>
          ))}
        </div>

        {trace ? (
          <div className="text-ink-muted ml-2 flex items-center gap-3 text-[11px]">
            <Badge
              tone={
                trace.status === 'succeeded'
                  ? 'positive'
                  : trace.status === 'failed'
                    ? 'danger'
                    : trace.status === 'running'
                      ? 'accent'
                      : 'neutral'
              }
            >
              {trace.status}
            </Badge>
            <Metric
              icon={Icons.Clock}
              value={formatDuration(trace.durationMs)}
              label="duration"
            />
            <Metric
              icon={Icons.Coins}
              value={formatTokens(trace.usage.totalTokens)}
              label="tokens"
            />
            <Metric
              icon={Icons.DollarSign}
              value={formatCost(trace.usage.costUsd)}
              label="cost"
            />
          </div>
        ) : null}

        <div className="ml-auto flex items-center gap-1.5">
          {runPhase === 'running' ? (
            <Button size="sm" variant="danger" onClick={onCancel}>
              <Icons.Square /> Stop
            </Button>
          ) : (
            <Button size="sm" variant="primary" onClick={onRun}>
              <Icons.Play /> Run
            </Button>
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto">
        {tab === 'input' ? (
          <div className="space-y-2 p-3">
            <p className="text-ink-subtle text-[11px]">
              JSON passed to the run. Reach it in any node with{' '}
              <code className="bg-surface-3 text-accent-soft rounded px-1 font-mono text-[10px]">
                {'{{ $.input.field }}'}
              </code>
              .
            </p>
            <Textarea
              rows={10}
              spellCheck={false}
              className="font-mono text-[11px]"
              value={input}
              onChange={(e) => onInputChange(e.target.value)}
            />
          </div>
        ) : null}

        {tab === 'timeline' ? (
          timeline.rows.length === 0 ? (
            <EmptyState
              icon={<Icons.Activity className="size-5" />}
              title="No run yet"
              description="Run the workflow to see a step-by-step timeline with per-node latency, tokens, and cost."
            />
          ) : (
            <div className="p-2">
              {timeline.rows.map((row) => {
                const offset = ((row.startedAt ?? 0) - (trace?.startedAt ?? 0)) / timeline.span;
                const width = Math.max(0.012, (row.durationMs ?? 0) / timeline.span);
                return (
                  <button
                    key={row.nodeId}
                    type="button"
                    onClick={() => select(row.nodeId)}
                    className={cn(
                      'hover:bg-surface-2 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
                      selectedNodeId === row.nodeId && 'bg-surface-2',
                    )}
                  >
                    <StatusIcon status={row.status} />
                    <span className="text-ink w-36 shrink-0 truncate text-[11px]">
                      {labelOf(row.nodeId)}
                    </span>

                    <span className="bg-surface-3/60 relative h-4 min-w-0 flex-1 overflow-hidden rounded">
                      <span
                        className={cn(
                          'absolute inset-y-0 rounded transition-all',
                          row.status === 'failed'
                            ? 'bg-danger/70'
                            : row.status === 'skipped'
                              ? 'bg-ink-subtle/30'
                              : row.status === 'running'
                                ? 'bg-accent/80 animate-pulse'
                                : 'bg-accent/55',
                        )}
                        style={{
                          left: `${Math.min(98, offset * 100)}%`,
                          width: `${Math.min(100 - offset * 100, width * 100)}%`,
                        }}
                      />
                    </span>

                    <span className="numeric text-ink-subtle w-14 shrink-0 text-right text-[10px]">
                      {row.status === 'skipped' ? '—' : formatDuration(row.durationMs)}
                    </span>
                    <span className="numeric text-ink-subtle w-14 shrink-0 text-right text-[10px]">
                      {row.usage?.totalTokens ? formatTokens(row.usage.totalTokens) : ''}
                    </span>
                    {row.attempts > 1 ? (
                      <Badge tone="warning" className="shrink-0">
                        ×{row.attempts}
                      </Badge>
                    ) : null}
                  </button>
                );
              })}
            </div>
          )
        ) : null}

        {tab === 'output' ? (
          !trace ? (
            <EmptyState
              icon={<Icons.Braces className="size-5" />}
              title="No output yet"
              description="The workflow's return value appears here once a run completes."
            />
          ) : (
            <div className="space-y-3 p-3">
              {trace.error ? (
                <div className="border-danger/25 bg-danger/10 rounded-lg border p-3">
                  <p className="text-danger text-[11px] font-semibold">
                    {trace.error.name}: {trace.error.message}
                  </p>
                </div>
              ) : null}
              <pre className="border-border bg-surface-2 text-ink-muted overflow-auto rounded-lg border p-3 font-mono text-[11px] leading-relaxed">
                {prettyJson(trace.output)}
              </pre>
            </div>
          )
        ) : null}

        {tab === 'logs' ? (
          logs.length === 0 ? (
            <EmptyState
              icon={<Icons.ScrollText className="size-5" />}
              title="No logs"
              description="Nodes emit structured logs through ctx.log() during execution."
            />
          ) : (
            <div className="divide-border/60 divide-y font-mono text-[11px]">
              {logs.map((entry, index) => (
                <div key={index} className="flex gap-2 px-3 py-1.5">
                  <span
                    className={cn(
                      'w-10 shrink-0 uppercase',
                      entry.level === 'error'
                        ? 'text-danger'
                        : entry.level === 'warn'
                          ? 'text-warning'
                          : entry.level === 'debug'
                            ? 'text-ink-subtle'
                            : 'text-info',
                    )}
                  >
                    {entry.level}
                  </span>
                  <button
                    type="button"
                    onClick={() => select(entry.nodeId)}
                    className="text-ink-subtle hover:text-ink w-28 shrink-0 truncate text-left"
                  >
                    {labelOf(entry.nodeId)}
                  </button>
                  <span className="text-ink-muted min-w-0 flex-1 break-words whitespace-pre-wrap">
                    {entry.message}
                  </span>
                </div>
              ))}
            </div>
          )
        ) : null}
      </div>
    </div>
  );
}

function Metric({
  icon: Icon,
  value,
  label,
}: {
  icon: typeof Icons.Clock;
  value: string;
  label: string;
}) {
  return (
    <span className="flex items-center gap-1" title={label}>
      <Icon className="text-ink-subtle size-3" />
      <span className="numeric">{value}</span>
    </span>
  );
}

function StatusIcon({ status }: { status: NodeTrace['status'] }) {
  const map = {
    succeeded: <Icons.CheckCircle2 className="text-positive size-3.5" />,
    failed: <Icons.XCircle className="text-danger size-3.5" />,
    running: <Icons.Loader2 className="text-accent size-3.5 animate-spin" />,
    skipped: <Icons.MinusCircle className="text-ink-subtle size-3.5" />,
    pending: <Icons.Circle className="text-ink-subtle size-3.5" />,
    cancelled: <Icons.Ban className="text-warning size-3.5" />,
    suspended: <Icons.PauseCircle className="text-warning size-3.5" />,
  } as const;
  return <span className="shrink-0">{map[status]}</span>;
}
