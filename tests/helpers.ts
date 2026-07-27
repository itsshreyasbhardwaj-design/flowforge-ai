import { z } from 'zod';
import { defineNode, type NodeDefinition } from '@/core/registry/definition';
import { NodeRegistry } from '@/core/registry/registry';
import { emptyWorkflow, type Workflow, type WorkflowNode } from '@/core/graph/types';
import { MockLLMProvider } from '@/core/providers/llm';
import { HashEmbeddingProvider, MemoryVectorStore } from '@/core/providers/vector';
import { builtinNodes } from '@/core';

export function testRegistry(extra: NodeDefinition<never>[] = []): NodeRegistry {
  const registry = new NodeRegistry();
  registry.registerNodes(builtinNodes);
  registry.registerNodes(extra);
  registry.registerLLM(new MockLLMProvider(), { default: true });
  registry.registerEmbedding(new HashEmbeddingProvider(), { default: true });
  registry.registerVectorStore(new MemoryVectorStore(), { default: true });
  return registry;
}

let counter = 0;

export function node(
  id: string,
  type: string,
  config: Record<string, unknown> = {},
  extra: Partial<WorkflowNode> = {},
): WorkflowNode {
  return { id, type, position: { x: counter++ * 100, y: 0 }, config, ...extra };
}

export function edge(source: string, sourcePort: string, target: string, targetPort: string) {
  return { id: `e${counter++}`, source, sourcePort, target, targetPort };
}

export function graph(
  nodes: WorkflowNode[],
  edges: ReturnType<typeof edge>[] = [],
  extra: Partial<Workflow> = {},
): Workflow {
  return { ...emptyWorkflow('wf_test', 'Test workflow'), nodes, edges, ...extra };
}

/** Echoes its input on `value`. The workhorse of the scheduler tests. */
export const echoNode = defineNode({
  type: 'test.echo',
  version: '1.0.0',
  label: 'Echo',
  description: 'Returns its input unchanged.',
  category: 'data',
  icon: 'Circle',
  configSchema: z.object({ constant: z.unknown().optional() }),
  inputs: [{ id: 'value', label: 'Value', type: 'any' }],
  outputs: [{ id: 'value', label: 'Value', type: 'any' }],
  async execute({ config, inputs }) {
    return { outputs: { value: inputs.value ?? config.constant ?? null } };
  },
});

/** Fails a configurable number of times before succeeding — used for retry tests. */
export function flakyNode(): {
  definition: NodeDefinition<{ failTimes: number }>;
  attempts: () => number;
} {
  let attempts = 0;
  const definition = defineNode({
    type: 'test.flaky',
    version: '1.0.0',
    label: 'Flaky',
    description: 'Fails a set number of times, then succeeds.',
    category: 'data',
    icon: 'Circle',
    configSchema: z.object({ failTimes: z.number().default(1) }),
    inputs: [{ id: 'value', label: 'Value', type: 'any' }],
    outputs: [
      { id: 'value', label: 'Value', type: 'any' },
      { id: 'error', label: 'Error', type: 'json', conditional: true },
    ],
    async execute({ config, inputs }) {
      attempts++;
      if (attempts <= config.failTimes) throw new Error(`boom ${attempts}`);
      return { outputs: { value: inputs.value ?? 'ok' } };
    },
  });
  return { definition, attempts: () => attempts };
}

/** Records the order in which nodes start, to assert on parallelism. */
export function trackerNode(log: string[], delayMs = 0): NodeDefinition<{ tag: string }> {
  return defineNode({
    type: 'test.tracker',
    version: '1.0.0',
    label: 'Tracker',
    description: 'Appends its tag to a shared log.',
    category: 'data',
    icon: 'Circle',
    configSchema: z.object({ tag: z.string() }),
    inputs: [{ id: 'value', label: 'Value', type: 'any' }],
    outputs: [{ id: 'value', label: 'Value', type: 'any' }],
    async execute({ config, inputs }) {
      log.push(`start:${config.tag}`);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      log.push(`end:${config.tag}`);
      return { outputs: { value: inputs.value ?? config.tag } };
    },
  });
}
