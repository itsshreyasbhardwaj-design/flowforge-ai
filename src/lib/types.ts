import type { PortSpec } from '@/core/graph/types';
import type { ConfigFieldUi, NodeCategory } from '@/core/registry/definition';

/**
 * Serialisable projection of a `NodeDefinition`, as served by `/api/nodes`.
 *
 * Zod schemas cannot cross the network, so the editor works from this descriptor:
 * port specs for the handles, `configUi` for the form widgets, and `defaults` for
 * initial values. A third-party node therefore renders correctly with no
 * client-side code at all.
 */
export interface NodeDescriptor {
  type: string;
  version: string;
  label: string;
  description: string;
  category: NodeCategory;
  icon: string;
  accent: string;
  docsUrl?: string;
  inputs: PortSpec[];
  outputs: PortSpec[];
  secrets: { key: string; label: string; description?: string; required?: boolean }[];
  capabilities: {
    sideEffects?: boolean;
    suspends?: boolean;
    deterministic?: boolean;
    invokesSubflows?: boolean;
  };
  configKeys: string[];
  configUi: Record<string, ConfigFieldUi>;
  defaults: Record<string, unknown>;
}

export interface NodeCatalogue {
  nodes: NodeDescriptor[];
  providers: { name: string; models: readonly string[] }[];
  plugins: { name: string; version: string }[];
}

export interface WorkflowSummary {
  id: string;
  name: string;
  description?: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  draftVersion: number;
  publishedVersion?: number;
  nodeCount: number;
  runCount: number;
  successRate: number | null;
  lastRunAt?: string;
}

export const CATEGORY_LABELS: Record<NodeCategory, string> = {
  trigger: 'Triggers',
  model: 'Models',
  prompt: 'Prompts',
  memory: 'Memory',
  knowledge: 'Knowledge',
  data: 'Data',
  logic: 'Logic',
  code: 'Code',
  integration: 'Integrations',
  agent: 'Agents',
  human: 'Human',
  output: 'Output',
};

/** Category → CSS custom property, so palette and canvas never drift apart. */
export const CATEGORY_COLOR: Record<NodeCategory, string> = {
  trigger: 'var(--color-cat-trigger)',
  model: 'var(--color-cat-model)',
  prompt: 'var(--color-cat-prompt)',
  memory: 'var(--color-cat-memory)',
  knowledge: 'var(--color-cat-knowledge)',
  data: 'var(--color-cat-data)',
  logic: 'var(--color-cat-logic)',
  code: 'var(--color-cat-code)',
  integration: 'var(--color-cat-integration)',
  agent: 'var(--color-cat-agent)',
  human: 'var(--color-cat-human)',
  output: 'var(--color-cat-output)',
};

export const CATEGORY_ORDER: NodeCategory[] = [
  'trigger',
  'model',
  'prompt',
  'agent',
  'knowledge',
  'memory',
  'logic',
  'data',
  'code',
  'integration',
  'human',
  'output',
];
