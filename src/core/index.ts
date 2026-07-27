/**
 * Public entry point for the FlowForge kernel.
 *
 * Everything here is framework-agnostic: no React, no Next.js, no database. A
 * plugin author, a CLI, and the web app all consume the same surface.
 */
export * from './graph/types';
export * from './graph/validate';
export * from './registry/definition';
export * from './registry/registry';
export * from './runtime/events';
export * from './runtime/executor';
export * from './runtime/expression';
export * from './runtime/secrets';
export * from './providers/llm';
export * from './providers/vector';

import { NodeRegistry } from './registry/registry';
import { aiNodes } from './nodes/ai';
import { dataNodes } from './nodes/data';
import { ioNodes } from './nodes/io';
import { logicNodes } from './nodes/logic';
import { createDefaultLLMProvider, MockLLMProvider } from './providers/llm';
import { createDefaultEmbeddingProvider, MemoryVectorStore } from './providers/vector';

export { aiNodes, dataNodes, ioNodes, logicNodes };

/** Every node shipped in the box. */
export const builtinNodes = [...ioNodes, ...aiNodes, ...logicNodes, ...dataNodes];

/**
 * A registry with the built-in node pack and the default providers.
 *
 * With no environment configured this wires the deterministic offline model,
 * local hash embeddings, and the in-memory vector store, so the platform is fully
 * exercisable at zero cost. Setting `OPENROUTER_API_KEY` / `OPENAI_API_KEY`
 * swaps in live inference without touching a workflow.
 */
export function createRegistry(env: NodeJS.ProcessEnv = process.env): NodeRegistry {
  const registry = new NodeRegistry();
  registry.registerNodes(builtinNodes);

  const llm = createDefaultLLMProvider(env);
  registry.registerLLM(llm, { default: true });
  // The mock stays available under its own name so a workflow can pin a
  // deterministic model for evaluation baselines even when a live key exists.
  if (llm.name !== 'mock') registry.registerLLM(new MockLLMProvider());

  registry.registerEmbedding(createDefaultEmbeddingProvider(env), { default: true });
  registry.registerVectorStore(new MemoryVectorStore(), { default: true });

  return registry;
}
