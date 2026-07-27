import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/**
 * Secret storage.
 *
 * Secrets never enter a workflow document. Node config holds `{ $secret: "KEY" }`
 * references, which the executor resolves at run time and the trace serializer
 * redacts on the way out.
 */
export interface SecretVault {
  get(key: string): Promise<string | undefined>;
  set?(key: string, value: string): Promise<void>;
  list?(): Promise<string[]>;
}

/** Default vault: reads from `process.env`. Nothing to configure, nothing to leak. */
export class EnvSecretVault implements SecretVault {
  constructor(private readonly prefix = '') {}

  async get(key: string): Promise<string | undefined> {
    return process.env[`${this.prefix}${key}`];
  }

  async list(): Promise<string[]> {
    const prefix = this.prefix;
    return Object.keys(process.env)
      .filter((k) => (prefix ? k.startsWith(prefix) : true))
      .map((k) => k.slice(prefix.length));
  }
}

/**
 * AES-256-GCM vault for credentials stored at rest.
 *
 * The master key is derived with scrypt from `FLOWFORGE_SECRET_KEY`. Each value
 * gets a fresh IV; the stored payload is `iv.authTag.ciphertext`, all base64.
 */
export class EncryptedVault implements SecretVault {
  private readonly key: Buffer;

  constructor(
    masterKey: string,
    private readonly storage: Map<string, string> = new Map(),
    salt = 'flowforge.vault.v1',
  ) {
    if (masterKey.length < 16) {
      throw new Error('Master key must be at least 16 characters');
    }
    this.key = scryptSync(masterKey, salt, 32);
  }

  async get(key: string): Promise<string | undefined> {
    const stored = this.storage.get(key);
    return stored ? this.decrypt(stored) : undefined;
  }

  async set(key: string, value: string): Promise<void> {
    this.storage.set(key, this.encrypt(value));
  }

  async list(): Promise<string[]> {
    return [...this.storage.keys()];
  }

  /** The encrypted-at-rest form, safe to persist. */
  export(): Record<string, string> {
    return Object.fromEntries(this.storage);
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), ciphertext].map((b) => b.toString('base64')).join('.');
  }

  decrypt(payload: string): string {
    const [ivB64, tagB64, dataB64] = payload.split('.');
    if (!ivB64 || !tagB64 || !dataB64) throw new Error('Malformed encrypted payload');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }
}

/** Chains vaults, returning the first hit. */
export class ChainedVault implements SecretVault {
  constructor(private readonly vaults: SecretVault[]) {}

  async get(key: string): Promise<string | undefined> {
    for (const vault of this.vaults) {
      const value = await vault.get(key);
      if (value !== undefined) return value;
    }
    return undefined;
  }

  async list(): Promise<string[]> {
    const keys = new Set<string>();
    for (const vault of this.vaults) {
      for (const key of (await vault.list?.()) ?? []) keys.add(key);
    }
    return [...keys];
  }
}

const SENSITIVE_KEY = /(secret|token|password|api[-_]?key|authorization|credential|bearer)/i;
const REDACTED = '••••••redacted••••••';

/**
 * Deep-redacts secret material before a value is written to a trace or sent to
 * the browser. Redacts by key name *and* by exact match against known values.
 */
export function redact(value: unknown, knownSecrets: readonly string[] = []): unknown {
  const secrets = knownSecrets.filter((s) => s && s.length >= 6);

  const walk = (input: unknown, depth: number): unknown => {
    if (depth > 12) return '[max depth]';
    if (typeof input === 'string') {
      return secrets.reduce<string>((acc, secret) => acc.split(secret).join(REDACTED), input);
    }
    if (Array.isArray(input)) return input.map((item) => walk(item, depth + 1));
    if (input && typeof input === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(input as Record<string, unknown>)) {
        out[key] = SENSITIVE_KEY.test(key) ? REDACTED : walk(val, depth + 1);
      }
      return out;
    }
    return input;
  };

  return walk(value, 0);
}

/** Caps the serialized size of a value so one huge payload can't blow up a trace. */
export function truncateForTrace(value: unknown, maxBytes = 32_000): unknown {
  let json: string;
  try {
    json = JSON.stringify(value) ?? 'undefined';
  } catch {
    return '[unserializable]';
  }
  if (json.length <= maxBytes) return value;
  return {
    __truncated: true,
    bytes: json.length,
    preview: `${json.slice(0, maxBytes)}…`,
  };
}
