import type { NodeRegistry } from '../registry/registry';
import { referencedNodeIds } from '../runtime/expression';
import { isPortCompatible, type Workflow, type WorkflowEdge } from './types';

export type IssueSeverity = 'error' | 'warning';

export interface ValidationIssue {
  severity: IssueSeverity;
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
  path?: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

/**
 * Static analysis of a workflow: structural integrity, port typing, config schemas,
 * expression references, and cycle detection.
 *
 * Runs on every canvas edit (it is cheap and pure) and again before execution.
 */
export function validateWorkflow(workflow: Workflow, registry: NodeRegistry): ValidationResult {
  const issues: ValidationIssue[] = [];
  const nodeById = new Map(workflow.nodes.map((n) => [n.id, n]));

  const seenNodeIds = new Set<string>();
  for (const node of workflow.nodes) {
    if (seenNodeIds.has(node.id)) {
      issues.push({
        severity: 'error',
        code: 'DUPLICATE_NODE_ID',
        message: `Duplicate node id "${node.id}"`,
        nodeId: node.id,
      });
    }
    seenNodeIds.add(node.id);

    const def = registry.tryGet(node.type);
    if (!def) {
      issues.push({
        severity: 'error',
        code: 'UNKNOWN_NODE_TYPE',
        message: `Unknown node type "${node.type}". Is its plugin installed?`,
        nodeId: node.id,
      });
      continue;
    }

    // Config is validated pre-resolution, so templated fields are expected to be
    // strings that will later become other types. Only flag *structural* problems.
    const parsed = def.configSchema.safeParse(node.config);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const path = issue.path.join('.');
        const raw = path
          ? (node.config as Record<string, unknown>)[issue.path[0] as string]
          : undefined;
        const templated = typeof raw === 'string' && raw.includes('{{');
        if (templated) continue;
        issues.push({
          severity: 'error',
          code: 'INVALID_CONFIG',
          message: `${def.label}: ${issue.message}${path ? ` (at "${path}")` : ''}`,
          nodeId: node.id,
          path,
        });
      }
    }

    for (const ref of referencedNodeIds(node.config)) {
      if (!nodeById.has(ref)) {
        issues.push({
          severity: 'error',
          code: 'UNKNOWN_REFERENCE',
          message: `Expression references node "${ref}", which does not exist`,
          nodeId: node.id,
        });
      }
    }
  }

  const seenEdgeKeys = new Set<string>();
  for (const edge of workflow.edges) {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (!source || !target) {
      issues.push({
        severity: 'error',
        code: 'DANGLING_EDGE',
        message: `Edge "${edge.id}" refers to a node that does not exist`,
        edgeId: edge.id,
      });
      continue;
    }

    const key = `${edge.source}:${edge.sourcePort}->${edge.target}:${edge.targetPort}`;
    if (seenEdgeKeys.has(key)) {
      issues.push({
        severity: 'warning',
        code: 'DUPLICATE_EDGE',
        message: 'Duplicate connection between the same two ports',
        edgeId: edge.id,
      });
    }
    seenEdgeKeys.add(key);

    const sourceDef = registry.tryGet(source.type);
    const targetDef = registry.tryGet(target.type);
    if (!sourceDef || !targetDef) continue;

    const outPort = sourceDef.outputs.find((p) => p.id === edge.sourcePort);
    const inPort = targetDef.inputs.find((p) => p.id === edge.targetPort);
    if (!outPort) {
      issues.push({
        severity: 'error',
        code: 'UNKNOWN_PORT',
        message: `"${sourceDef.label}" has no output port "${edge.sourcePort}"`,
        edgeId: edge.id,
      });
      continue;
    }
    if (!inPort) {
      issues.push({
        severity: 'error',
        code: 'UNKNOWN_PORT',
        message: `"${targetDef.label}" has no input port "${edge.targetPort}"`,
        edgeId: edge.id,
      });
      continue;
    }
    if (!isPortCompatible(outPort.type, inPort.type)) {
      issues.push({
        severity: 'error',
        code: 'TYPE_MISMATCH',
        message: `Cannot connect ${outPort.type} → ${inPort.type} ("${outPort.label}" to "${inPort.label}")`,
        edgeId: edge.id,
      });
    }
  }

  // Required inputs must be fed by an edge, unless the config supplies a literal
  // of the same name (nodes conventionally accept either).
  for (const node of workflow.nodes) {
    const def = registry.tryGet(node.type);
    if (!def || node.disabled) continue;
    const fed = new Set(
      workflow.edges.filter((e) => e.target === node.id).map((e) => e.targetPort),
    );
    for (const port of def.inputs) {
      if (!port.required || fed.has(port.id)) continue;
      if (node.config[port.id] !== undefined) continue;
      issues.push({
        severity: 'error',
        code: 'MISSING_REQUIRED_INPUT',
        message: `"${def.label}" needs an input on "${port.label}"`,
        nodeId: node.id,
      });
    }
  }

  const cycle = findCycle(workflow);
  if (cycle) {
    issues.push({
      severity: 'error',
      code: 'CYCLE_DETECTED',
      message: `Workflows must be acyclic. Cycle: ${cycle.join(' → ')}. Use a Loop node with a sub-workflow to iterate.`,
      nodeId: cycle[0],
    });
  }

  for (const node of workflow.nodes) {
    const def = registry.tryGet(node.type);
    if (!def || node.disabled) continue;
    const hasInbound = workflow.edges.some((e) => e.target === node.id);
    const hasOutbound = workflow.edges.some((e) => e.source === node.id);
    if (!hasInbound && !hasOutbound && workflow.nodes.length > 1) {
      issues.push({
        severity: 'warning',
        code: 'ORPHAN_NODE',
        message: `"${node.label ?? def.label}" is not connected to anything`,
        nodeId: node.id,
      });
    }
    if (def.category !== 'trigger' && !hasInbound && def.inputs.some((p) => p.required)) {
      issues.push({
        severity: 'warning',
        code: 'UNREACHABLE_NODE',
        message: `"${node.label ?? def.label}" has no inbound connection and will never run`,
        nodeId: node.id,
      });
    }
  }

  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  return { valid: errors.length === 0, issues, errors, warnings };
}

/** Returns the node ids forming a cycle, or `null` if the graph is acyclic. */
export function findCycle(workflow: Workflow): string[] | null {
  const adjacency = new Map<string, string[]>();
  for (const node of workflow.nodes) adjacency.set(node.id, []);
  for (const edge of workflow.edges) {
    if (adjacency.has(edge.source) && adjacency.has(edge.target)) {
      adjacency.get(edge.source)!.push(edge.target);
    }
  }

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const id of adjacency.keys()) color.set(id, WHITE);
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    color.set(id, GRAY);
    stack.push(id);
    for (const next of adjacency.get(id) ?? []) {
      const state = color.get(next);
      if (state === GRAY) {
        return [...stack.slice(stack.indexOf(next)), next];
      }
      if (state === WHITE) {
        const found = visit(next);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(id, BLACK);
    return null;
  };

  for (const id of adjacency.keys()) {
    if (color.get(id) === WHITE) {
      const found = visit(id);
      if (found) return found;
    }
  }
  return null;
}

/** Nodes with no inbound edges — the entry points of a run. */
export function findRoots(workflow: Workflow): string[] {
  const withInbound = new Set(workflow.edges.map((e) => e.target));
  return workflow.nodes.filter((n) => !withInbound.has(n.id)).map((n) => n.id);
}

/**
 * Kahn's algorithm. Returns ids in a valid execution order, or `null` on a cycle.
 * The scheduler does not use this directly (it is event-driven), but the diff
 * viewer and layout engine do.
 */
export function topologicalOrder(workflow: Workflow): string[] | null {
  const indegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const node of workflow.nodes) {
    indegree.set(node.id, 0);
    adjacency.set(node.id, []);
  }
  for (const edge of workflow.edges) {
    if (!indegree.has(edge.target) || !adjacency.has(edge.source)) continue;
    indegree.set(edge.target, indegree.get(edge.target)! + 1);
    adjacency.get(edge.source)!.push(edge.target);
  }

  const queue = [...indegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of adjacency.get(id) ?? []) {
      const remaining = indegree.get(next)! - 1;
      indegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }
  return order.length === workflow.nodes.length ? order : null;
}

export function inboundEdges(workflow: Workflow, nodeId: string): WorkflowEdge[] {
  return workflow.edges.filter((e) => e.target === nodeId);
}

export function outboundEdges(workflow: Workflow, nodeId: string): WorkflowEdge[] {
  return workflow.edges.filter((e) => e.source === nodeId);
}
