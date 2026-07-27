import type {
  EmbeddingProvider,
  LLMProvider,
  NodeDefinition,
  Plugin,
  VectorStore,
} from './definition';

export class DuplicateRegistrationError extends Error {
  constructor(kind: string, key: string) {
    super(`${kind} "${key}" is already registered`);
    this.name = 'DuplicateRegistrationError';
  }
}

export class UnknownNodeTypeError extends Error {
  constructor(public readonly type: string) {
    super(`No node definition registered for type "${type}"`);
    this.name = 'UnknownNodeTypeError';
  }
}

/**
 * Holds every node definition and provider available to the runtime.
 *
 * The registry is intentionally an instance rather than module-level state so that
 * tests, sub-workflow sandboxes, and multi-tenant deployments can each hold an
 * isolated set of plugins.
 */
export class NodeRegistry {
  // Definitions are stored type-erased; `get` re-narrows via the caller's expectation.
  private readonly nodes = new Map<string, NodeDefinition<never>>();
  private readonly llmProviders = new Map<string, LLMProvider>();
  private readonly embeddingProviders = new Map<string, EmbeddingProvider>();
  private readonly vectorStores = new Map<string, VectorStore>();
  private readonly plugins: Plugin[] = [];

  private defaultLlm?: string;
  private defaultEmbedding?: string;
  private defaultVector?: string;

  registerNode<T>(def: NodeDefinition<T>): this {
    if (this.nodes.has(def.type)) throw new DuplicateRegistrationError('Node', def.type);
    this.assertPortsUnique(def);
    this.nodes.set(def.type, def as unknown as NodeDefinition<never>);
    return this;
  }

  registerNodes(defs: readonly NodeDefinition<never>[]): this {
    for (const def of defs) this.registerNode(def);
    return this;
  }

  registerLLM(provider: LLMProvider, opts: { default?: boolean } = {}): this {
    if (this.llmProviders.has(provider.name))
      throw new DuplicateRegistrationError('LLM provider', provider.name);
    this.llmProviders.set(provider.name, provider);
    if (opts.default || !this.defaultLlm) this.defaultLlm = provider.name;
    return this;
  }

  registerEmbedding(provider: EmbeddingProvider, opts: { default?: boolean } = {}): this {
    if (this.embeddingProviders.has(provider.name))
      throw new DuplicateRegistrationError('Embedding provider', provider.name);
    this.embeddingProviders.set(provider.name, provider);
    if (opts.default || !this.defaultEmbedding) this.defaultEmbedding = provider.name;
    return this;
  }

  registerVectorStore(store: VectorStore, opts: { default?: boolean } = {}): this {
    if (this.vectorStores.has(store.name))
      throw new DuplicateRegistrationError('Vector store', store.name);
    this.vectorStores.set(store.name, store);
    if (opts.default || !this.defaultVector) this.defaultVector = store.name;
    return this;
  }

  use(plugin: Plugin): this {
    this.plugins.push(plugin);
    plugin.nodes?.forEach((n) => this.registerNode(n));
    plugin.llmProviders?.forEach((p) => this.registerLLM(p));
    plugin.embeddingProviders?.forEach((p) => this.registerEmbedding(p));
    plugin.vectorStores?.forEach((s) => this.registerVectorStore(s));
    return this;
  }

  get(type: string): NodeDefinition<never> {
    const def = this.nodes.get(type);
    if (!def) throw new UnknownNodeTypeError(type);
    return def;
  }

  tryGet(type: string): NodeDefinition<never> | undefined {
    return this.nodes.get(type);
  }

  has(type: string): boolean {
    return this.nodes.has(type);
  }

  list(): NodeDefinition<never>[] {
    return [...this.nodes.values()].sort((a, b) => a.label.localeCompare(b.label));
  }

  listByCategory(): Map<string, NodeDefinition<never>[]> {
    const grouped = new Map<string, NodeDefinition<never>[]>();
    for (const def of this.list()) {
      const bucket = grouped.get(def.category) ?? [];
      bucket.push(def);
      grouped.set(def.category, bucket);
    }
    return grouped;
  }

  listPlugins(): readonly Plugin[] {
    return this.plugins;
  }

  llm(name?: string): LLMProvider {
    const key = name ?? this.defaultLlm;
    const provider = key ? this.llmProviders.get(key) : undefined;
    if (!provider) throw new Error(`No LLM provider registered under "${key ?? '<default>'}"`);
    return provider;
  }

  embedding(name?: string): EmbeddingProvider {
    const key = name ?? this.defaultEmbedding;
    const provider = key ? this.embeddingProviders.get(key) : undefined;
    if (!provider)
      throw new Error(`No embedding provider registered under "${key ?? '<default>'}"`);
    return provider;
  }

  vector(name?: string): VectorStore {
    const key = name ?? this.defaultVector;
    const store = key ? this.vectorStores.get(key) : undefined;
    if (!store) throw new Error(`No vector store registered under "${key ?? '<default>'}"`);
    return store;
  }

  listLLMProviders(): LLMProvider[] {
    return [...this.llmProviders.values()];
  }

  private assertPortsUnique<T>(def: NodeDefinition<T>): void {
    for (const [side, ports] of [
      ['input', def.inputs],
      ['output', def.outputs],
    ] as const) {
      const seen = new Set<string>();
      for (const port of ports) {
        if (seen.has(port.id))
          throw new Error(`Node "${def.type}" declares duplicate ${side} port "${port.id}"`);
        seen.add(port.id);
      }
    }
  }
}
