import { z } from 'zod';
import { emptyWorkflow, type Workflow } from '../graph/types';
import { validateWorkflow } from '../graph/validate';
import type { LLMProvider } from '../registry/definition';
import type { NodeRegistry } from '../registry/registry';

const generatedGraphSchema = z.object({
  name: z.string().default('Generated workflow'),
  description: z.string().optional(),
  nodes: z
    .array(
      z.object({
        id: z.string().min(1),
        type: z.string().min(1),
        label: z.string().optional(),
        config: z.record(z.string(), z.unknown()).default({}),
      }),
    )
    .default([]),
  edges: z
    .array(
      z.object({
        source: z.string(),
        sourcePort: z.string().default('value'),
        target: z.string(),
        targetPort: z.string().default('value'),
      }),
    )
    .default([]),
});

export interface GenerateResult {
  workflow: Workflow;
  /** Problems the model introduced that could not be repaired automatically. */
  issues: string[];
  /** Repairs the generator made to the model's output. */
  repairs: string[];
  raw?: string;
}

/**
 * Builds the tool catalogue the model sees.
 *
 * Deriving it from the live registry means a third-party plugin becomes available
 * to the assistant the moment it is installed, with no prompt to update.
 */
export function describeRegistry(registry: NodeRegistry): string {
  return registry
    .list()
    .map((def) => {
      const inputs = def.inputs.map((p) => `${p.id}:${p.type}`).join(', ') || 'none';
      const outputs = def.outputs.map((p) => `${p.id}:${p.type}`).join(', ') || 'none';
      const keys = Object.keys(
        (def.configSchema as unknown as { shape?: Record<string, unknown> }).shape ?? {},
      );
      return `- ${def.type} — ${def.description}\n    in: ${inputs}\n    out: ${outputs}\n    config: ${keys.join(', ') || 'none'}`;
    })
    .join('\n');
}

const SYSTEM_PROMPT = `You design FlowForge workflows: directed acyclic graphs of typed nodes.

Rules:
- Reply with a single JSON object and nothing else. No prose, no code fences.
- Shape: { "name", "description", "nodes": [{ "id", "type", "label", "config" }], "edges": [{ "source", "sourcePort", "target", "targetPort" }] }
- Use only node types from the catalogue. Use only the port ids listed for each type.
- Start with a trigger node and finish with flowforge.output.
- The graph must be acyclic. To iterate, use flowforge.loop pointing at another workflow.
- Reference upstream values in config with {{ $.nodes.<id>.output.<port> }}.
- Node ids are short, lowercase, and descriptive.`;

/**
 * Generates a workflow from a natural-language description.
 *
 * The model's output is never trusted: it is schema-parsed, then repaired against
 * the live registry (unknown types dropped, invalid ports remapped, dangling
 * edges removed), then validated. What the user gets is always a loadable graph,
 * with an explicit list of what had to be corrected.
 */
export async function generateWorkflow(options: {
  prompt: string;
  registry: NodeRegistry;
  provider: LLMProvider;
  model?: string;
  workflowId?: string;
  signal?: AbortSignal;
}): Promise<GenerateResult> {
  const { prompt, registry, provider } = options;

  const response = await provider.complete({
    model: options.model ?? provider.models[0] ?? 'flowforge/mock',
    jsonMode: true,
    temperature: 0.2,
    signal: options.signal,
    messages: [
      {
        role: 'system',
        content: `${SYSTEM_PROMPT}\n\nNODE CATALOGUE:\n${describeRegistry(registry)}`,
      },
      { role: 'user', content: prompt },
    ],
  });

  const parsed = extractJson(response.text);
  if (!parsed) {
    return {
      workflow: emptyWorkflow(options.workflowId ?? 'wf_generated', 'Generated workflow'),
      issues: [
        'The model did not return valid JSON. Try a more specific description, or a stronger model.',
      ],
      repairs: [],
      raw: response.text,
    };
  }

  const result = generatedGraphSchema.safeParse(parsed);
  if (!result.success) {
    return {
      workflow: emptyWorkflow(options.workflowId ?? 'wf_generated', 'Generated workflow'),
      issues: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      repairs: [],
      raw: response.text,
    };
  }

  return repairGraph(
    result.data,
    registry,
    options.workflowId ?? 'wf_generated',
    response.text,
  );
}

function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(text);
  const candidate = (fenced ? fenced[1] : text).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

function repairGraph(
  draft: z.infer<typeof generatedGraphSchema>,
  registry: NodeRegistry,
  workflowId: string,
  raw: string,
): GenerateResult {
  const repairs: string[] = [];
  const seen = new Set<string>();

  const nodes = draft.nodes
    .filter((node) => {
      if (!registry.has(node.type)) {
        repairs.push(`Dropped node "${node.id}": unknown type "${node.type}"`);
        return false;
      }
      if (seen.has(node.id)) {
        repairs.push(`Dropped duplicate node id "${node.id}"`);
        return false;
      }
      seen.add(node.id);
      return true;
    })
    .map((node, index) => ({
      id: node.id,
      type: node.type,
      label: node.label ?? registry.get(node.type).label,
      // Laid out on a diagonal so nothing overlaps before auto-layout runs.
      position: { x: 120 + (index % 4) * 320, y: 120 + Math.floor(index / 4) * 220 },
      config: node.config,
    }));

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = draft.edges
    .map((edge, index) => {
      const source = byId.get(edge.source);
      const target = byId.get(edge.target);
      if (!source || !target) {
        repairs.push(`Dropped edge ${edge.source} → ${edge.target}: missing endpoint`);
        return null;
      }

      const sourceDef = registry.get(source.type);
      const targetDef = registry.get(target.type);
      let sourcePort = edge.sourcePort;
      let targetPort = edge.targetPort;

      // Models routinely invent port names. Falling back to the node's first port
      // is right far more often than dropping the connection outright.
      if (!sourceDef.outputs.some((p) => p.id === sourcePort)) {
        const fallback = sourceDef.outputs[0]?.id;
        if (!fallback) return null;
        repairs.push(`Remapped ${source.id}.${sourcePort} → ${source.id}.${fallback}`);
        sourcePort = fallback;
      }
      if (!targetDef.inputs.some((p) => p.id === targetPort)) {
        const fallback = targetDef.inputs[0]?.id;
        if (!fallback) return null;
        repairs.push(`Remapped ${target.id}.${targetPort} → ${target.id}.${fallback}`);
        targetPort = fallback;
      }

      return {
        id: `e_${index}_${source.id}_${target.id}`,
        source: source.id,
        sourcePort,
        target: target.id,
        targetPort,
      };
    })
    .filter((e): e is NonNullable<typeof e> => e !== null);

  const workflow: Workflow = {
    ...emptyWorkflow(workflowId, draft.name),
    description: draft.description,
    nodes,
    edges,
  };

  const validation = validateWorkflow(workflow, registry);
  return {
    workflow,
    repairs,
    issues: validation.errors.map((e) => e.message),
    raw,
  };
}
