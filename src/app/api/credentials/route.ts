import { z } from 'zod';
import { getRuntime } from '@/server/runtime';
import { badRequest, json, parseBody, route } from '@/server/api';

export const dynamic = 'force-dynamic';

export const GET = route(async () => {
  const { store } = await getRuntime();
  const credentials = await store.listCredentials();
  // Only metadata. Ciphertext stays server-side and plaintext is never readable.
  return json({
    credentials: credentials.map(({ key, label, createdAt, lastUsedAt }) => ({
      key,
      label,
      createdAt,
      lastUsedAt,
    })),
  });
});

const createSchema = z.object({
  key: z
    .string()
    .min(2)
    .max(64)
    .regex(/^[A-Z0-9_]+$/, 'Use SCREAMING_SNAKE_CASE'),
  label: z.string().min(1).max(120),
  value: z.string().min(1).max(8000),
});

export const POST = route(async (request: Request) => {
  const body = await parseBody(request, createSchema);
  const { store, credentialVault } = await getRuntime();

  await credentialVault.set(body.key, body.value);
  const ciphertext = credentialVault.export()[body.key];
  if (!ciphertext) throw badRequest('Failed to encrypt the credential');

  await store.saveCredential({
    key: body.key,
    label: body.label,
    ciphertext,
    createdAt: new Date().toISOString(),
  });
  await store.flush();

  return json({ ok: true, key: body.key }, { status: 201 });
});

export const DELETE = route(async (request: Request) => {
  const key = new URL(request.url).searchParams.get('key');
  if (!key) throw badRequest('A "key" query parameter is required');

  const { store } = await getRuntime();
  await store.deleteCredential(key);
  await store.flush();
  return json({ ok: true });
});
