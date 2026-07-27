import 'server-only';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createRegistry } from '@/core';
import type { NodeRegistry } from '@/core/registry/registry';
import { WorkflowExecutor } from '@/core/runtime/executor';
import {
  ChainedVault,
  EncryptedVault,
  EnvSecretVault,
  type SecretVault,
} from '@/core/runtime/secrets';
import { FileStore, defaultStorePath } from '@/core/store/file';
import type { Store } from '@/core/store/types';
import { BUILTIN_TEMPLATES } from '@/core/templates';

interface Runtime {
  store: FileStore;
  registry: NodeRegistry;
  vault: SecretVault;
  credentialVault: EncryptedVault;
  executor: WorkflowExecutor;
}

// Next.js re-evaluates modules on every hot reload in development. Caching on
// globalThis keeps one store, one registry, and one in-memory vector index alive
// across reloads instead of silently losing state on every edit.
const globalRef = globalThis as typeof globalThis & { __flowforge?: Promise<Runtime> };

async function build(): Promise<Runtime> {
  const store = await new FileStore(defaultStorePath()).load();
  const registry = createRegistry();

  const masterKey =
    process.env.FLOWFORGE_SECRET_KEY ?? 'flowforge-development-key-do-not-use-in-prod';
  const stored = await store.listCredentials();
  const credentialVault = new EncryptedVault(
    masterKey,
    new Map(stored.map((c) => [c.key, c.ciphertext])),
  );

  // Credentials saved through the UI win; process env is the fallback, so a
  // container can inject secrets without anyone touching the database.
  const vault = new ChainedVault([credentialVault, new EnvSecretVault()]);

  const executor = new WorkflowExecutor({
    registry,
    vault,
    loadWorkflow: async (workflowId) => {
      const graph = await store.resolveGraph(workflowId);
      if (!graph) throw new Error(`Workflow "${workflowId}" not found`);
      return graph;
    },
    maxDepth: Number(process.env.FLOWFORGE_MAX_DEPTH ?? 5),
  });

  await seedTemplates(store);
  return { store, registry, vault, credentialVault, executor };
}

/** Ships the built-in templates on first boot without clobbering user edits. */
async function seedTemplates(store: Store): Promise<void> {
  const existing = new Set((await store.listTemplates()).map((t) => t.id));
  for (const template of BUILTIN_TEMPLATES) {
    if (!existing.has(template.id)) await store.saveTemplate(template);
  }
}

export function getRuntime(): Promise<Runtime> {
  globalRef.__flowforge ??= build();
  return globalRef.__flowforge;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function generateToken(): string {
  return `ffk_${randomBytes(24).toString('base64url')}`;
}

/** Constant-time comparison, so token checks do not leak length or prefix. */
export function verifyToken(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashToken(token), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}
