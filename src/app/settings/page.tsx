import { KeyRound } from 'lucide-react';
import { getRuntime } from '@/server/runtime';
import { PageHeader } from '@/components/shell/page-header';
import { CredentialManager } from '@/components/settings/credential-manager';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Credentials' };

export default async function SettingsPage() {
  const { store, registry } = await getRuntime();
  const credentials = await store.listCredentials();

  // Every secret any installed node declares, so the UI can prompt for the ones
  // that are still missing instead of failing at run time.
  const declared = registry
    .list()
    .flatMap((def) => (def.secrets ?? []).map((s) => ({ ...s, node: def.label })));
  const unique = [...new Map(declared.map((s) => [s.key, s])).values()];

  return (
    <>
      <PageHeader
        title="Credentials"
        description="Secrets are encrypted at rest with AES-256-GCM, injected only at execution time, and redacted from every trace. Plaintext is never readable through the API."
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-2xl space-y-6">
          <CredentialManager
            initial={credentials.map(({ key, label, createdAt }) => ({
              key,
              label,
              createdAt,
            }))}
            declared={unique}
          />

          <section className="panel p-4">
            <h2 className="text-ink flex items-center gap-2 text-xs font-semibold">
              <KeyRound className="text-ink-subtle size-3.5" /> How secrets resolve
            </h2>
            <ol className="text-ink-muted mt-3 space-y-2 text-[11px] leading-relaxed">
              <li>
                <strong className="text-ink">1.</strong> A node config holds a reference:{' '}
                <code className="bg-surface-3 text-accent-soft rounded px-1 font-mono text-[10px]">
                  {'{ "$secret": "MY_KEY" }'}
                </code>
                . The workflow document never contains the value.
              </li>
              <li>
                <strong className="text-ink">2.</strong> At run time the executor resolves it
                against the encrypted store, then falls back to{' '}
                <code className="font-mono">process.env</code> — so a container can inject
                secrets without touching this page.
              </li>
              <li>
                <strong className="text-ink">3.</strong> Resolved values are tracked and
                stripped from inputs, outputs, and logs before anything is persisted or streamed
                to a browser.
              </li>
            </ol>
            <p className="border-warning/25 bg-warning/8 text-warning mt-3 rounded-lg border p-2.5 text-[11px]">
              Set <code className="font-mono">FLOWFORGE_SECRET_KEY</code> in production. The
              development fallback key is public and offers no real protection.
            </p>
          </section>
        </div>
      </div>
    </>
  );
}
