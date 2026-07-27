'use client';

import { useMemo, useState } from 'react';
import { ChevronRight, Search, Zap } from 'lucide-react';
import { NodeIcon } from '@/components/ui/node-icon';
import type { NodeCategory } from '@/core/registry/definition';
import {
  CATEGORY_COLOR,
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  type NodeDescriptor,
} from '@/lib/types';
import { Input } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';
import { useEditor } from './store';

/**
 * Node library.
 *
 * Nodes are dragged onto the canvas, or added by click at a viewport-relative
 * default position. Search matches label, type, and description, because people
 * look for "http" as often as they look for "REST API".
 */
export function Palette() {
  const catalogue = useEditor((s) => s.catalogue);
  const addNode = useEditor((s) => s.addNode);
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const grouped = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = needle
      ? catalogue.filter((d) =>
          `${d.label} ${d.type} ${d.description} ${d.category}`.toLowerCase().includes(needle),
        )
      : catalogue;

    const byCategory = new Map<NodeCategory, NodeDescriptor[]>();
    for (const descriptor of matches) {
      byCategory.set(descriptor.category, [
        ...(byCategory.get(descriptor.category) ?? []),
        descriptor,
      ]);
    }
    return CATEGORY_ORDER.filter((c) => byCategory.has(c)).map((category) => ({
      category,
      nodes: byCategory.get(category)!.sort((a, b) => a.label.localeCompare(b.label)),
    }));
  }, [catalogue, query]);

  return (
    <aside className="border-border bg-surface flex w-64 shrink-0 flex-col border-r">
      <div className="border-border border-b p-3">
        <div className="relative">
          <Search className="text-ink-subtle pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search nodes"
            aria-label="Search nodes"
            className="h-8 pl-8 text-xs"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pt-2 pb-6">
        {grouped.length === 0 ? (
          <p className="text-ink-subtle px-2 py-6 text-center text-xs">
            No nodes match “{query}”.
          </p>
        ) : null}

        {grouped.map(({ category, nodes }) => {
          const isCollapsed = collapsed.has(category) && !query;
          return (
            <section key={category} className="mb-1">
              <button
                type="button"
                onClick={() =>
                  setCollapsed((prev) => {
                    const next = new Set(prev);
                    if (next.has(category)) next.delete(category);
                    else next.add(category);
                    return next;
                  })
                }
                aria-expanded={!isCollapsed}
                className="text-ink-subtle hover:text-ink-muted flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-[10px] font-semibold tracking-widest uppercase transition-colors"
              >
                <ChevronRight
                  className={cn('size-3 transition-transform', !isCollapsed && 'rotate-90')}
                />
                {CATEGORY_LABELS[category]}
                <span className="ml-auto font-normal tracking-normal normal-case opacity-60">
                  {nodes.length}
                </span>
              </button>

              {!isCollapsed
                ? nodes.map((descriptor) => (
                    <PaletteItem
                      key={descriptor.type}
                      descriptor={descriptor}
                      onAdd={() =>
                        addNode(descriptor, {
                          x: 200 + Math.round(Math.random() * 6) * 16,
                          y: 160 + Math.round(Math.random() * 6) * 16,
                        })
                      }
                    />
                  ))
                : null}
            </section>
          );
        })}
      </div>
    </aside>
  );
}

function PaletteItem({ descriptor, onAdd }: { descriptor: NodeDescriptor; onAdd: () => void }) {
  const color = CATEGORY_COLOR[descriptor.category];

  return (
    <button
      type="button"
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData('application/flowforge-node', descriptor.type);
        event.dataTransfer.effectAllowed = 'copy';
      }}
      onClick={onAdd}
      title={descriptor.description}
      className="group hover:bg-surface-2 focus-visible:focus-ring flex w-full cursor-grab items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors active:cursor-grabbing"
    >
      <span
        className="grid size-6 shrink-0 place-items-center rounded-md"
        style={{ background: `color-mix(in oklab, ${color} 16%, transparent)`, color }}
      >
        <NodeIcon name={descriptor.icon} className="size-3.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="text-ink block truncate text-xs font-medium">{descriptor.label}</span>
        <span className="text-ink-subtle block truncate text-[10px]">
          {descriptor.description}
        </span>
      </span>
      {descriptor.capabilities.sideEffects ? (
        <Zap
          className="text-warning size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
          aria-label="Has side effects"
        />
      ) : null}
    </button>
  );
}
