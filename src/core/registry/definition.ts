/**
 * The plugin SDK surface.
 *
 * A node is a pure, self-describing unit: a Zod config schema, typed ports, and an
 * `execute` function. Everything the platform shows in the UI — the inspector form,
 * the port handles, validation, docs — is derived from this object, so a third-party
 * node is indistinguishable from a built-in one.
 *
 * Third parties import only from `@/core/registry` and `@/core/graph`; nothing here
 * depends on React, Next.js, or the database layer.
 */
import type { ZodType } from 'zod';
import type { PortSpec, SecretRef } from '../graph/types';

export type NodeCategory =
  | 'trigger'
  | 'model'
  | 'prompt'
  | 'memory'
  | 'knowledge'
  | 'data'
  | 'logic'
  | 'code'
  | 'integration'
  | 'agent'
  | 'human'
  | 'output';

export interface UsageReport {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** Cost in USD. Providers report this; nodes without a cost model omit it. */
  costUsd?: number;
  model?: string;
  provider?: string;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  level: LogLevel;
  message: string;
  /** Structured payload. Redacted before persistence. */
  data?: unknown;
  at: number;
}

export interface NodeResult {
  /**
   * Values keyed by output port id. A port omitted here is *not activated*:
   * downstream nodes reachable only through it are skipped. This is how
   * `condition`, `router`, and guard nodes express branching without the
   * scheduler needing to special-case them.
   */
  outputs: Record<string, unknown>;
  usage?: UsageReport;
  logs?: LogEntry[];
  /** Arbitrary structured detail surfaced in the debugger's inspector panel. */
  debug?: Record<string, unknown>;
}

export interface SecretSpec {
  key: string;
  label: string;
  description?: string;
  required?: boolean;
}

export interface NodeCapabilities {
  /** Node performs I/O with observable side effects (sends email, writes a row). */
  sideEffects?: boolean;
  /** Node halts the run pending an external decision. */
  suspends?: boolean;
  /** Same inputs always produce the same outputs — enables result caching. */
  deterministic?: boolean;
  /** Node may invoke sub-workflows via `ctx.invoke`. */
  invokesSubflows?: boolean;
}

/** Everything a node is handed at execution time. */
export interface NodeExecuteArgs<TConfig> {
  /** Config with `{{ }}` expressions resolved and secrets injected. */
  config: TConfig;
  /** Values delivered on each input port. Optional ports may be `undefined`. */
  inputs: Record<string, unknown>;
  ctx: NodeContext;
}

/** Services the platform exposes to a node. Keep this surface small and stable. */
export interface NodeContext {
  readonly runId: string;
  readonly nodeId: string;
  readonly workflowId: string;
  /** Aborts when the run is cancelled or the node times out. */
  readonly signal: AbortSignal;
  /** Current sub-workflow nesting depth; 0 for the top-level run. */
  readonly depth: number;

  log(level: LogLevel, message: string, data?: unknown): void;
  /** Report incremental usage. Called more than once for streaming models. */
  reportUsage(usage: UsageReport): void;
  /** Emit a partial output for live streaming in the debugger. */
  emitPartial(portId: string, chunk: unknown): void;

  /** Resolve a secret by key. Throws if the vault has no entry and it is required. */
  getSecret(key: string): Promise<string | undefined>;

  /** Run-scoped key/value state, shared across all nodes in the run. */
  state: {
    get<T = unknown>(key: string): T | undefined;
    set(key: string, value: unknown): void;
    keys(): string[];
  };

  /** Provider registry — LLM, embedding, and vector-store backends. */
  providers: ProviderAccess;

  /** Execute another workflow and return its outputs. Depth-limited. */
  invoke(workflowId: string, input: unknown): Promise<Record<string, unknown>>;
}

export interface ProviderAccess {
  llm(name?: string): LLMProvider;
  embedding(name?: string): EmbeddingProvider;
  vector(name?: string): VectorStore;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  toolCallId?: string;
}

export interface LLMRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stop?: string[];
  jsonMode?: boolean;
  signal?: AbortSignal;
}

export interface LLMResponse {
  text: string;
  finishReason: 'stop' | 'length' | 'content_filter' | 'error';
  usage: UsageReport;
}

export interface LLMProvider {
  readonly name: string;
  readonly models: readonly string[];
  complete(req: LLMRequest): Promise<LLMResponse>;
  stream?(req: LLMRequest): AsyncIterable<string>;
}

export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}

export interface VectorRecord {
  id: string;
  vector: number[];
  text: string;
  metadata?: Record<string, unknown>;
}

export interface VectorMatch extends VectorRecord {
  score: number;
}

export interface VectorStore {
  readonly name: string;
  upsert(collection: string, records: VectorRecord[]): Promise<void>;
  query(collection: string, vector: number[], topK: number): Promise<VectorMatch[]>;
  delete(collection: string, ids: string[]): Promise<void>;
  count(collection: string): Promise<number>;
}

/**
 * The node contract. `TConfig` is inferred from `configSchema`, so `execute`
 * receives fully-typed configuration with no casts at the call site.
 */
export interface NodeDefinition<TConfig = Record<string, unknown>> {
  /** Namespaced, stable, unique. Built-ins use the `flowforge.` prefix. */
  type: string;
  version: string;
  label: string;
  description: string;
  category: NodeCategory;
  /** A lucide-react icon name, e.g. `Sparkles`. */
  icon: string;
  /** Tailwind-friendly accent token used by the canvas renderer. */
  accent?: string;
  docsUrl?: string;

  configSchema: ZodType<TConfig>;
  /** Field ordering / widget hints for the auto-generated inspector form. */
  configUi?: Record<string, ConfigFieldUi>;

  inputs: PortSpec[];
  outputs: PortSpec[];
  secrets?: SecretSpec[];
  capabilities?: NodeCapabilities;

  execute(args: NodeExecuteArgs<TConfig>): Promise<NodeResult>;
}

export interface ConfigFieldUi {
  widget?: 'text' | 'textarea' | 'code' | 'select' | 'number' | 'switch' | 'secret' | 'json';
  label?: string;
  help?: string;
  placeholder?: string;
  order?: number;
  language?: 'javascript' | 'python' | 'json' | 'sql' | 'text';
  options?: { value: string; label: string }[];
}

/**
 * Identity helper that preserves the inferred config type.
 *
 * ```ts
 * export const myNode = defineNode({
 *   type: 'acme.greet',
 *   configSchema: z.object({ name: z.string() }),
 *   execute: async ({ config }) => ({ outputs: { text: `hi ${config.name}` } }),
 *   // ...
 * });
 * ```
 */
export function defineNode<TConfig>(def: NodeDefinition<TConfig>): NodeDefinition<TConfig> {
  return def;
}

/** A distributable bundle of nodes and providers. */
export interface Plugin {
  name: string;
  version: string;
  description?: string;
  author?: string;
  nodes?: NodeDefinition<never>[];
  llmProviders?: LLMProvider[];
  embeddingProviders?: EmbeddingProvider[];
  vectorStores?: VectorStore[];
}

export type { SecretRef };
