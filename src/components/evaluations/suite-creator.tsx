'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Plus } from 'lucide-react';
import { Button, Input, Label, Select, Textarea } from '@/components/ui/primitives';

const METRICS = [
  { id: 'exactMatch', label: 'Exact match' },
  { id: 'contains', label: 'Contains expected' },
  { id: 'tokenF1', label: 'Token F1' },
  { id: 'taskCompletion', label: 'Task completion' },
  { id: 'reasoningDepth', label: 'Reasoning depth' },
  { id: 'latencyMs', label: 'Latency' },
  { id: 'costUsd', label: 'Cost' },
];

const SAMPLE = `[
  { "input": { "question": "What is the refund window?" }, "expected": "30 days" },
  { "input": { "question": "Do you ship internationally?" }, "expected": "yes" }
]`;

export function EvalSuiteCreator({ workflows }: { workflows: { id: string; name: string }[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [workflowId, setWorkflowId] = useState(workflows[0]?.id ?? '');
  const [cases, setCases] = useState(SAMPLE);
  const [metrics, setMetrics] = useState<string[]>([
    'taskCompletion',
    'tokenF1',
    'latencyMs',
    'costUsd',
  ]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(cases);
      } catch {
        setError('Cases must be a JSON array of { input, expected } objects.');
        return;
      }

      const response = await fetch('/api/evals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'createSuite',
          workflowId,
          name,
          metrics,
          cases: parsed,
        }),
      });
      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        setError(data.error ?? 'Failed to create the suite.');
        return;
      }
      setOpen(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)} disabled={workflows.length === 0}>
        <Plus /> New suite
      </Button>

      {open ? (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label="Create evaluation suite"
          onClick={(e) => e.target === e.currentTarget && setOpen(false)}
        >
          <div className="panel max-h-[85vh] w-full max-w-lg overflow-y-auto p-5 shadow-2xl">
            <h2 className="text-ink text-sm font-semibold">New evaluation suite</h2>

            {error ? (
              <p className="border-danger/25 bg-danger/10 text-danger mt-3 rounded-lg border p-2 text-[11px]">
                {error}
              </p>
            ) : null}

            <div className="mt-4 space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="suite-name">Name</Label>
                <Input
                  id="suite-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Refund policy accuracy"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="suite-workflow">Workflow</Label>
                <Select
                  id="suite-workflow"
                  value={workflowId}
                  onChange={(e) => setWorkflowId(e.target.value)}
                >
                  {workflows.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label>Metrics</Label>
                <div className="flex flex-wrap gap-1.5">
                  {METRICS.map((metric) => {
                    const active = metrics.includes(metric.id);
                    return (
                      <button
                        key={metric.id}
                        type="button"
                        onClick={() =>
                          setMetrics((prev) =>
                            active ? prev.filter((m) => m !== metric.id) : [...prev, metric.id],
                          )
                        }
                        className={`rounded-md border px-2 py-1 text-[11px] transition-colors ${
                          active
                            ? 'border-accent/40 bg-accent/15 text-accent-soft'
                            : 'border-border bg-surface-2 text-ink-subtle hover:text-ink'
                        }`}
                      >
                        {metric.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="suite-cases">Cases</Label>
                <Textarea
                  id="suite-cases"
                  rows={9}
                  spellCheck={false}
                  className="font-mono text-[11px]"
                  value={cases}
                  onChange={(e) => setCases(e.target.value)}
                />
              </div>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={create}
                disabled={busy || !name || metrics.length === 0}
              >
                {busy ? <Loader2 className="animate-spin" /> : null} Create suite
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
