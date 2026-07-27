'use client';

import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { AlertCircle } from 'lucide-react';
import type { NodeStatus } from '@/core/runtime/events';
import { NodeIcon } from '@/components/ui/node-icon';
import { CATEGORY_COLOR, type NodeDescriptor } from '@/lib/types';
import { formatDuration } from '@/lib/format';
import { cn } from '@/lib/cn';

export interface FlowNodeData extends Record<string, unknown> {
  label: string;
  descriptor: NodeDescriptor | undefined;
  type: string;
  disabled?: boolean;
  hasError?: boolean;
  status?: NodeStatus;
  durationMs?: number;
  summary?: string;
}

const STATUS_RING: Record<NodeStatus, string> = {
  pending: 'border-border',
  running: 'border-accent running-ring',
  succeeded: 'border-positive/60',
  failed: 'border-danger/70',
  skipped: 'border-border opacity-45',
  cancelled: 'border-warning/60',
  suspended: 'border-warning/70',
};

/**
 * A node on the canvas.
 *
 * Ports are laid out vertically and evenly spaced, with the handle id equal to
 * the domain port id — so a connection made in the UI is already a valid
 * `WorkflowEdge` with no translation step. Colour comes from the node's category,
 * which is the only colour dimension on the canvas; run status is expressed
 * through the border instead, so the two never compete.
 */
export const FlowNodeCard = memo(function FlowNodeCard({
  data,
  selected,
}: NodeProps & { data: FlowNodeData }) {
  const { descriptor } = data;
  const accent = descriptor ? CATEGORY_COLOR[descriptor.category] : 'var(--color-danger)';
  const status = data.status ?? 'pending';

  const inputs = descriptor?.inputs ?? [];
  const outputs = descriptor?.outputs ?? [];
  const rows = Math.max(inputs.length, outputs.length, 1);

  return (
    <div
      className={cn(
        'group bg-surface-2 relative w-[248px] rounded-xl border-2 transition-all duration-150',
        'shadow-[0_2px_10px_-4px_rgba(0,0,0,0.8)] hover:shadow-[0_8px_28px_-10px_rgba(0,0,0,0.9)]',
        selected ? 'border-accent ring-accent/25 ring-2' : STATUS_RING[status],
        data.disabled && 'opacity-45 saturate-0',
      )}
      style={{ minHeight: 56 + rows * 8 }}
    >
      {!descriptor ? (
        <div className="bg-danger absolute -top-2 left-3 rounded px-1.5 py-0.5 text-[9px] font-bold tracking-wider text-white uppercase">
          Unknown type
        </div>
      ) : null}

      <div className="flex items-start gap-2.5 px-3 py-2.5">
        <div
          className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg"
          style={{
            background: `color-mix(in oklab, ${accent} 18%, transparent)`,
            color: accent,
          }}
        >
          <NodeIcon name={descriptor?.icon} className="size-4" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p className="text-ink truncate text-[13px] leading-tight font-semibold">
              {data.label}
            </p>
            {data.hasError ? (
              <AlertCircle className="text-danger size-3.5 shrink-0" aria-label="Has errors" />
            ) : null}
          </div>
          <p className="text-ink-subtle mt-0.5 truncate font-mono text-[10px]">
            {data.type.replace(/^flowforge\./, '')}
          </p>
          {data.summary ? (
            <p className="text-ink-muted mt-1.5 line-clamp-2 text-[11px] leading-snug">
              {data.summary}
            </p>
          ) : null}
        </div>
      </div>

      {status !== 'pending' ? (
        <div className="border-border/70 flex items-center gap-2 border-t px-3 py-1.5 text-[10px]">
          <StatusDot status={status} />
          <span className="text-ink-muted capitalize">{status}</span>
          {data.durationMs !== undefined ? (
            <span className="numeric text-ink-subtle ml-auto">
              {formatDuration(data.durationMs)}
            </span>
          ) : null}
        </div>
      ) : null}

      {inputs.map((port, index) => (
        <Handle
          key={`in-${port.id}`}
          id={port.id}
          type="target"
          position={Position.Left}
          style={{ top: portOffset(index, inputs.length) }}
          title={`${port.label} · ${port.type}${port.required ? ' (required)' : ''}`}
          className={cn(port.required && '!bg-accent/70')}
        />
      ))}

      {outputs.map((port, index) => (
        <Handle
          key={`out-${port.id}`}
          id={port.id}
          type="source"
          position={Position.Right}
          style={{ top: portOffset(index, outputs.length) }}
          title={`${port.label} · ${port.type}${port.conditional ? ' (conditional)' : ''}`}
          className={cn(port.conditional && '!bg-warning/70')}
        />
      ))}
    </div>
  );
});

/** Distributes handles evenly down the card's right or left edge. */
function portOffset(index: number, total: number): number {
  const top = 46;
  const spacing = 18;
  const height = (total - 1) * spacing;
  return top + index * spacing - height / 2 + height / 2;
}

function StatusDot({ status }: { status: NodeStatus }) {
  const color: Record<NodeStatus, string> = {
    pending: 'bg-ink-subtle',
    running: 'bg-accent animate-pulse',
    succeeded: 'bg-positive',
    failed: 'bg-danger',
    skipped: 'bg-ink-subtle',
    cancelled: 'bg-warning',
    suspended: 'bg-warning',
  };
  return <span className={cn('size-1.5 shrink-0 rounded-full', color[status])} />;
}
