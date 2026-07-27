import { createHash } from 'node:crypto';
import type {
  EmbeddingProvider,
  VectorMatch,
  VectorRecord,
  VectorStore,
} from '../registry/definition';

/** Words carrying no retrieval signal; dropped so they cannot dominate a short query. */
const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'of',
  'to',
  'in',
  'on',
  'at',
  'for',
  'with',
  'and',
  'or',
  'but',
  'if',
  'then',
  'this',
  'that',
  'these',
  'those',
  'it',
  'its',
  'as',
  'by',
  'from',
  'what',
  'which',
  'who',
  'how',
  'do',
  'does',
  'did',
  'can',
  'will',
  'would',
  'should',
  'i',
  'you',
  'we',
  'they',
]);

/**
 * Strips common English inflections so morphological variants collapse to one
 * token: refunds → refund, shipping → ship, accepted → accept.
 *
 * Deliberately not a full Porter stemmer — a dozen suffix rules recover most of
 * the recall a word-exact hash loses, without a dependency or its failure modes.
 */
export function stem(token: string): string {
  if (token.length <= 3) return token;
  for (const suffix of ['ingly', 'edly', 'ing', 'ies', 'ied', 'ed', 'ly', 'es', 's']) {
    if (!token.endsWith(suffix)) continue;
    const root = token.slice(0, -suffix.length);
    if (root.length < 3) continue;
    if (suffix === 'ies' || suffix === 'ied') return `${root}y`;
    // Undo the doubled consonant in "shipping" / "stopped".
    if ((suffix === 'ing' || suffix === 'ed') && /(.)\1$/.test(root)) return root.slice(0, -1);
    return root;
  }
  return token;
}

/**
 * Deterministic local embeddings.
 *
 * A hashed bag of n-grams projected onto a fixed-dimension unit sphere: stemmed
 * word unigrams and bigrams carry most of the signal, and character 4-grams add a
 * lighter fuzzy layer that catches variants stemming misses.
 *
 * This is lexical similarity, not semantic: it will not connect "car" to
 * "automobile". It exists so retrieval workflows are demonstrable and the test
 * suite is reproducible at zero cost. Set `OPENAI_API_KEY` for real embeddings.
 */
export class HashEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'local-hash';

  constructor(readonly dimensions = 256) {}

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.embedOne(text));
  }

  private embedOne(text: string): number[] {
    const vector = new Array<number>(this.dimensions).fill(0);
    const tokens = text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length > 0 && !STOP_WORDS.has(token))
      .map(stem);

    const add = (gram: string, weight: number): void => {
      const digest = createHash('sha1').update(gram).digest();
      const index = digest.readUInt32BE(0) % this.dimensions;
      vector[index] += digest[4] % 2 === 0 ? weight : -weight;
    };

    for (const token of tokens) add(`w:${token}`, 1);
    for (let i = 0; i < tokens.length - 1; i++) add(`b:${tokens[i]}_${tokens[i + 1]}`, 0.6);

    // Character grams are the fuzzy-matching layer. Weighted below word grams so
    // an exact word match still outranks a merely similar-looking one.
    for (const token of tokens) {
      const padded = `^${token}$`;
      for (let i = 0; i + 4 <= padded.length; i++) add(`c:${padded.slice(i, i + 4)}`, 0.35);
    }

    const magnitude = Math.hypot(...vector);
    return magnitude === 0 ? vector : vector.map((v) => v / magnitude);
  }
}

/** OpenAI-compatible embeddings endpoint. Only constructed when a key exists. */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'openai';

  constructor(
    private readonly apiKey: string,
    readonly model = 'text-embedding-3-small',
    readonly dimensions = 1536,
    private readonly baseUrl = 'https://api.openai.com/v1',
  ) {}

  async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: this.model, input: texts }),
      signal,
    });
    if (!response.ok) {
      throw new Error(`Embedding request failed: ${response.status} ${await response.text()}`);
    }
    const payload = (await response.json()) as { data: { embedding: number[] }[] };
    return payload.data.map((d) => d.embedding);
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}

/**
 * In-process vector store with exact brute-force search.
 *
 * Exact search is O(n·d), which is genuinely the right choice below ~50k vectors —
 * it avoids an index build, has no recall loss, and keeps the default install
 * dependency-free. Point `VECTOR_STORE=pgvector` at Postgres for larger corpora.
 */
export class MemoryVectorStore implements VectorStore {
  readonly name = 'memory';
  private readonly collections = new Map<string, Map<string, VectorRecord>>();

  private collection(name: string): Map<string, VectorRecord> {
    let collection = this.collections.get(name);
    if (!collection) {
      collection = new Map();
      this.collections.set(name, collection);
    }
    return collection;
  }

  async upsert(collection: string, records: VectorRecord[]): Promise<void> {
    const target = this.collection(collection);
    for (const record of records) target.set(record.id, record);
  }

  async query(collection: string, vector: number[], topK: number): Promise<VectorMatch[]> {
    const records = [...this.collection(collection).values()];
    return records
      .map((record) => ({ ...record, score: cosineSimilarity(vector, record.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(0, topK));
  }

  async delete(collection: string, ids: string[]): Promise<void> {
    const target = this.collection(collection);
    for (const id of ids) target.delete(id);
  }

  async count(collection: string): Promise<number> {
    return this.collection(collection).size;
  }

  /** Test/debug helper — not part of the `VectorStore` contract. */
  listCollections(): string[] {
    return [...this.collections.keys()];
  }
}

export function createDefaultEmbeddingProvider(
  env: NodeJS.ProcessEnv = process.env,
): EmbeddingProvider {
  const key = env.OPENAI_API_KEY;
  return key ? new OpenAIEmbeddingProvider(key) : new HashEmbeddingProvider();
}
