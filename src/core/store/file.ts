import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { MemoryStore } from './memory';

/**
 * Durable JSON-file store — the zero-configuration default.
 *
 * Writes are debounced and go through a temp file plus `rename`, which is atomic
 * on POSIX, so a crash mid-write cannot leave a half-written database. It is
 * single-process by design; point `DATABASE_URL` at Postgres for multi-instance
 * deployments.
 */
export class FileStore extends MemoryStore {
  private writeTimer: ReturnType<typeof setTimeout> | undefined;
  private pending: Promise<void> = Promise.resolve();
  private loaded = false;

  constructor(
    private readonly filePath: string,
    private readonly debounceMs = 120,
  ) {
    super();
  }

  /** Idempotent; safe to await on every request. */
  async load(): Promise<this> {
    if (this.loaded) return this;
    this.loaded = true;
    try {
      const raw = await readFile(this.filePath, 'utf8');
      this.hydrate(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(dirname(this.filePath), { recursive: true });
    }
    return this;
  }

  protected override async persist(): Promise<void> {
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.pending = new Promise<void>((resolve, reject) => {
      this.writeTimer = setTimeout(() => {
        this.flush().then(resolve, reject);
      }, this.debounceMs);
    });
    // Callers do not await the debounce; `flush()` is available for shutdown.
  }

  /** Forces an immediate write and resolves once it lands. */
  async flush(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = undefined;
    }
    const payload = JSON.stringify(this.snapshot(), null, 2);
    await mkdir(dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temp, payload, 'utf8');
    await rename(temp, this.filePath);
  }

  async close(): Promise<void> {
    await this.pending.catch(() => {});
    await this.flush();
  }
}

export function defaultStorePath(): string {
  return process.env.FLOWFORGE_DATA_FILE ?? join(process.cwd(), '.flowforge', 'store.json');
}
