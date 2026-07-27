'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Copy, Loader2, Rocket } from 'lucide-react';
import { Button, Label, Select, Switch } from '@/components/ui/primitives';

const KINDS = ['rest', 'webhook', 'schedule', 'worker', 'chat', 'cli', 'widget'] as const;

export function DeploymentCreator({
  workflows,
}: {
  workflows: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [workflowId, setWorkflowId] = useState(workflows[0]?.id ?? '');
  const [kind, setKind] = useState<(typeof KINDS)[number]>('rest');
  const [requireToken, setRequireToken] = useState(true);
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    try {
      const response = await fetch('/api/deployments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflowId, kind, requireToken }),
      });
      const data = (await response.json()) as { token?: string; error?: string };
      if (data.token) setToken(data.token);
      else setOpen(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)} disabled={workflows.length === 0}>
        <Rocket /> New deployment
      </Button>

      {open ? (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label="Create deployment"
          onClick={(e) => e.target === e.currentTarget && setOpen(false)}
        >
          <div className="panel w-full max-w-md p-5 shadow-2xl">
            {token ? (
              <>
                <h2 className="text-ink text-sm font-semibold">Deployment created</h2>
                <p className="text-warning mt-2 text-xs leading-relaxed">
                  Copy this token now. It is hashed on the server and cannot be shown again.
                </p>
                <div className="mt-3 flex gap-2">
                  <code className="border-border bg-surface-2 text-ink min-w-0 flex-1 truncate rounded-lg border px-3 py-2 font-mono text-[11px]">
                    {token}
                  </code>
                  <Button
                    size="icon"
                    variant="secondary"
                    aria-label="Copy token"
                    onClick={() => void navigator.clipboard.writeText(token)}
                  >
                    <Copy />
                  </Button>
                </div>
                <div className="mt-5 flex justify-end">
                  <Button
                    variant="primary"
                    onClick={() => {
                      setToken(null);
                      setOpen(false);
                    }}
                  >
                    Done
                  </Button>
                </div>
              </>
            ) : (
              <>
                <h2 className="text-ink text-sm font-semibold">New deployment</h2>
                <div className="mt-4 space-y-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="dep-workflow">Workflow</Label>
                    <Select
                      id="dep-workflow"
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
                    <Label htmlFor="dep-kind">Kind</Label>
                    <Select
                      id="dep-kind"
                      value={kind}
                      onChange={(e) => setKind(e.target.value as typeof kind)}
                    >
                      {KINDS.map((k) => (
                        <option key={k} value={k}>
                          {k}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div className="flex items-center justify-between">
                    <div>
                      <Label>Require bearer token</Label>
                      <p className="text-ink-subtle mt-0.5 text-[10px]">
                        Strongly recommended for anything public.
                      </p>
                    </div>
                    <Switch
                      label="Require bearer token"
                      checked={requireToken}
                      onCheckedChange={setRequireToken}
                    />
                  </div>
                </div>
                <div className="mt-5 flex justify-end gap-2">
                  <Button variant="ghost" onClick={() => setOpen(false)}>
                    Cancel
                  </Button>
                  <Button variant="primary" onClick={create} disabled={busy || !workflowId}>
                    {busy ? <Loader2 className="animate-spin" /> : null} Deploy
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}
