'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeftRight, Loader2, RotateCcw } from 'lucide-react';
import type { WorkflowDiff } from '@/core/versioning/diff';
import { Badge, Button, EmptyState } from '@/components/ui/primitives';
import { formatRelativeTime, prettyJson } from '@/lib/format';
import { cn } from '@/lib/cn';

interface VersionRow {
  version: number;
  status: string;
  createdAt: string;
  changelog?: string;
  nodeCount: number;
  edgeCount: number;
}

/**
 * Version list plus a structural diff.
 *
 * The diff is computed server-side from the two frozen graphs and rendered by
 * change kind rather than as text: a workflow is a graph, and a line-based diff of
 * its JSON tells you almost nothing about what actually changed.
 */
export function VersionHistory({
  workflowId,
  versions,
  publishedVersion,
}: {
  workflowId: string;
  versions: VersionRow[];
  publishedVersion?: number;
}) {
  const router = useRouter();
  const [from, setFrom] = useState<number | null>(versions[1]?.version ?? null);
  const [to, setTo] = useState<number | null>(versions[0]?.version ?? null);
  const [diff, setDiff] = useState<WorkflowDiff | null>(null);
  const [busy, setBusy] = useState(false);

  const compare = async () => {
    if (from === null || to === null) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/workflows/${workflowId}/diff?from=${from}&to=${to}`);
      const data = (await response.json()) as { diff?: WorkflowDiff };
      setDiff(data.diff ?? null);
    } finally {
      setBusy(false);
    }
  };

  const rollback = async (version: number) => {
    setBusy(true);
    try {
      await fetch(`/api/workflows/${workflowId}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'rollback', version }),
      });
      router.push(`/workflows/${workflowId}`);
    } finally {
      setBusy(false);
    }
  };

  if (versions.length === 0) {
    return (
      <EmptyState title="No versions" description="Save the workflow to create a draft." />
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,20rem)_1fr]">
      <section className="panel overflow-hidden">
        <h2 className="border-border text-ink border-b px-4 py-2.5 text-xs font-semibold">
          History
        </h2>
        <div className="divide-border/60 divide-y">
          {versions.map((version) => (
            <div key={version.version} className="px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="numeric text-ink text-sm font-semibold">
                  v{version.version}
                </span>
                {version.version === publishedVersion ? (
                  <Badge tone="positive">live</Badge>
                ) : version.status === 'draft' ? (
                  <Badge tone="accent">draft</Badge>
                ) : (
                  <Badge>{version.status}</Badge>
                )}
                <span className="text-ink-subtle ml-auto text-[10px]">
                  {formatRelativeTime(version.createdAt)}
                </span>
              </div>

              <p className="text-ink-subtle mt-1 text-[11px]">
                {version.nodeCount} nodes · {version.edgeCount} connections
              </p>
              {version.changelog ? (
                <p className="text-ink-muted mt-1 text-[11px] italic">“{version.changelog}”</p>
              ) : null}

              <div className="mt-2 flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setFrom(version.version)}
                  className={cn(
                    'rounded border px-1.5 py-0.5 text-[10px] transition-colors',
                    from === version.version
                      ? 'border-accent/40 bg-accent/15 text-accent-soft'
                      : 'border-border text-ink-subtle hover:text-ink',
                  )}
                >
                  base
                </button>
                <button
                  type="button"
                  onClick={() => setTo(version.version)}
                  className={cn(
                    'rounded border px-1.5 py-0.5 text-[10px] transition-colors',
                    to === version.version
                      ? 'border-accent/40 bg-accent/15 text-accent-soft'
                      : 'border-border text-ink-subtle hover:text-ink',
                  )}
                >
                  compare
                </button>
                {version.status !== 'draft' ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto"
                    disabled={busy}
                    onClick={() => rollback(version.version)}
                  >
                    <RotateCcw /> Restore
                  </Button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="panel overflow-hidden">
        <header className="border-border flex items-center gap-2 border-b px-4 py-2.5">
          <h2 className="text-ink text-xs font-semibold">
            Diff {from !== null ? `v${from}` : '—'} → {to !== null ? `v${to}` : '—'}
          </h2>
          <Button
            size="sm"
            variant="secondary"
            className="ml-auto"
            onClick={compare}
            disabled={busy || from === null || to === null}
          >
            {busy ? <Loader2 className="animate-spin" /> : <ArrowLeftRight />} Compare
          </Button>
        </header>

        {!diff ? (
          <p className="text-ink-subtle px-4 py-10 text-center text-xs">
            Pick a base and a comparison version, then hit Compare.
          </p>
        ) : diff.identical ? (
          <p className="text-positive px-4 py-10 text-center text-xs">
            No functional changes. Node positions may differ.
          </p>
        ) : (
          <div className="space-y-4 p-4">
            <div className="flex flex-wrap gap-2">
              <Badge tone="positive">+{diff.summary.added} added</Badge>
              <Badge tone="danger">−{diff.summary.removed} removed</Badge>
              <Badge tone="warning">{diff.summary.modified} modified</Badge>
              <Badge>{diff.summary.moved} moved</Badge>
            </div>

            {diff.nodes
              .filter((node) => node.kind !== 'moved')
              .map((node) => (
                <article
                  key={node.nodeId}
                  className="border-border bg-surface-2 rounded-lg border p-3"
                >
                  <div className="flex items-center gap-2">
                    <Badge
                      tone={
                        node.kind === 'added'
                          ? 'positive'
                          : node.kind === 'removed'
                            ? 'danger'
                            : 'warning'
                      }
                    >
                      {node.kind}
                    </Badge>
                    <span className="text-ink text-xs font-medium">{node.label}</span>
                    <span className="text-ink-subtle font-mono text-[10px]">{node.type}</span>
                  </div>

                  {node.changes.length > 0 ? (
                    <div className="mt-2 space-y-1.5">
                      {node.changes.map((change) => (
                        <div key={change.path} className="text-[11px]">
                          <p className="text-ink-subtle font-mono">{change.path}</p>
                          <div className="mt-0.5 grid gap-1 sm:grid-cols-2">
                            <pre className="border-danger/20 bg-danger/8 text-danger/90 overflow-x-auto rounded border px-2 py-1 font-mono text-[10px]">
                              {prettyJson(change.before, 400)}
                            </pre>
                            <pre className="border-positive/20 bg-positive/8 text-positive/90 overflow-x-auto rounded border px-2 py-1 font-mono text-[10px]">
                              {prettyJson(change.after, 400)}
                            </pre>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </article>
              ))}

            {diff.edges.length > 0 ? (
              <div className="border-border bg-surface-2 rounded-lg border p-3">
                <p className="text-ink-subtle text-[10px] tracking-widest uppercase">
                  Connections
                </p>
                <ul className="mt-1.5 space-y-1">
                  {diff.edges.map((edge) => (
                    <li key={edge.edgeId} className="flex items-center gap-2 text-[11px]">
                      <span className={edge.kind === 'added' ? 'text-positive' : 'text-danger'}>
                        {edge.kind === 'added' ? '+' : '−'}
                      </span>
                      <span className="text-ink-muted">{edge.description}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {diff.metadata.length > 0 ? (
              <div className="border-border bg-surface-2 rounded-lg border p-3">
                <p className="text-ink-subtle text-[10px] tracking-widest uppercase">
                  Settings
                </p>
                <ul className="mt-1.5 space-y-1">
                  {diff.metadata.map((change) => (
                    <li key={change.path} className="text-ink-muted text-[11px]">
                      <span className="text-ink-subtle font-mono">{change.path}</span>:{' '}
                      {prettyJson(change.before, 80)} → {prettyJson(change.after, 80)}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        )}
      </section>
    </div>
  );
}
