'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Loader2, Plus, Trash2 } from 'lucide-react';
import { Badge, Button, Input, Label } from '@/components/ui/primitives';
import { formatRelativeTime } from '@/lib/format';

interface Credential {
  key: string;
  label: string;
  createdAt: string;
}

interface DeclaredSecret {
  key: string;
  label: string;
  description?: string;
  required?: boolean;
  node: string;
}

export function CredentialManager({
  initial,
  declared,
}: {
  initial: Credential[];
  declared: DeclaredSecret[];
}) {
  const router = useRouter();
  const [key, setKey] = useState('');
  const [label, setLabel] = useState('');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);

  const stored = new Set(initial.map((c) => c.key));
  const missing = declared.filter((s) => !stored.has(s.key));

  const save = async () => {
    if (!key || !value) return;
    setBusy(true);
    try {
      await fetch('/api/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, label: label || key, value }),
      });
      setKey('');
      setLabel('');
      setValue('');
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  const remove = async (target: string) => {
    await fetch(`/api/credentials?key=${encodeURIComponent(target)}`, { method: 'DELETE' });
    router.refresh();
  };

  return (
    <>
      <section className="panel overflow-hidden">
        <h2 className="border-border text-ink border-b px-4 py-2.5 text-xs font-semibold">
          Stored credentials
        </h2>
        {initial.length === 0 ? (
          <p className="text-ink-subtle px-4 py-6 text-center text-xs">
            No credentials stored. FlowForge runs fully offline without any.
          </p>
        ) : (
          <div className="divide-border/60 divide-y">
            {initial.map((credential) => (
              <div key={credential.key} className="flex items-center gap-3 px-4 py-2.5">
                <Check className="text-positive size-3.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-ink truncate font-mono text-[11px]">{credential.key}</p>
                  <p className="text-ink-subtle truncate text-[10px]">{credential.label}</p>
                </div>
                <span className="text-ink-subtle shrink-0 text-[10px]">
                  {formatRelativeTime(credential.createdAt)}
                </span>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Delete ${credential.key}`}
                  className="hover:text-danger"
                  onClick={() => remove(credential.key)}
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
          </div>
        )}
      </section>

      {missing.length > 0 ? (
        <section className="panel overflow-hidden">
          <h2 className="border-border text-ink border-b px-4 py-2.5 text-xs font-semibold">
            Wanted by installed nodes
          </h2>
          <div className="divide-border/60 divide-y">
            {missing.map((secret) => (
              <div key={secret.key} className="flex items-center gap-3 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="text-ink-muted truncate font-mono text-[11px]">{secret.key}</p>
                  <p className="text-ink-subtle truncate text-[10px]">
                    {secret.label} · used by {secret.node}
                  </p>
                </div>
                {secret.required ? (
                  <Badge tone="warning">required</Badge>
                ) : (
                  <Badge>optional</Badge>
                )}
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setKey(secret.key);
                    setLabel(secret.label);
                  }}
                >
                  Add
                </Button>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="panel p-4">
        <h2 className="text-ink text-xs font-semibold">Add a credential</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="cred-key">Key</Label>
            <Input
              id="cred-key"
              value={key}
              onChange={(e) => setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))}
              placeholder="OPENROUTER_API_KEY"
              className="font-mono"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cred-label">Label</Label>
            <Input
              id="cred-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="OpenRouter production key"
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="cred-value">Value</Label>
            <Input
              id="cred-value"
              type="password"
              autoComplete="off"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="sk-…"
            />
          </div>
        </div>
        <div className="mt-4 flex justify-end">
          <Button variant="primary" onClick={save} disabled={busy || !key || !value}>
            {busy ? <Loader2 className="animate-spin" /> : <Plus />} Save encrypted
          </Button>
        </div>
      </section>
    </>
  );
}
