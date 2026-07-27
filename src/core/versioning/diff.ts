import type { Workflow, WorkflowEdge, WorkflowNode } from '../graph/types';

export type ChangeKind = 'added' | 'removed' | 'modified' | 'moved';

export interface FieldChange {
  path: string;
  before: unknown;
  after: unknown;
}

export interface NodeDiff {
  nodeId: string;
  label: string;
  type: string;
  kind: ChangeKind;
  changes: FieldChange[];
}

export interface EdgeDiff {
  edgeId: string;
  kind: Extract<ChangeKind, 'added' | 'removed'>;
  description: string;
}

export interface WorkflowDiff {
  nodes: NodeDiff[];
  edges: EdgeDiff[];
  metadata: FieldChange[];
  /** True when nothing that affects execution changed. */
  identical: boolean;
  summary: { added: number; removed: number; modified: number; moved: number };
}

/**
 * Structural diff between two workflow versions.
 *
 * Position-only edits are reported as `moved` and kept out of the `modified`
 * count — dragging a node around a canvas is not a behavioural change, and a
 * diff that says otherwise trains people to ignore it.
 */
export function diffWorkflows(before: Workflow, after: Workflow): WorkflowDiff {
  const beforeNodes = new Map(before.nodes.map((n) => [n.id, n]));
  const afterNodes = new Map(after.nodes.map((n) => [n.id, n]));
  const nodes: NodeDiff[] = [];

  for (const [id, node] of afterNodes) {
    const previous = beforeNodes.get(id);
    if (!previous) {
      nodes.push({
        nodeId: id,
        label: node.label ?? node.type,
        type: node.type,
        kind: 'added',
        changes: [],
      });
      continue;
    }

    const changes = diffNodeFields(previous, node);
    const behavioural = changes.filter((c) => !c.path.startsWith('position'));
    const positional = changes.length > behavioural.length;

    if (behavioural.length > 0) {
      nodes.push({
        nodeId: id,
        label: node.label ?? node.type,
        type: node.type,
        kind: 'modified',
        changes: behavioural,
      });
    } else if (positional) {
      nodes.push({
        nodeId: id,
        label: node.label ?? node.type,
        type: node.type,
        kind: 'moved',
        changes,
      });
    }
  }

  for (const [id, node] of beforeNodes) {
    if (!afterNodes.has(id)) {
      nodes.push({
        nodeId: id,
        label: node.label ?? node.type,
        type: node.type,
        kind: 'removed',
        changes: [],
      });
    }
  }

  const edgeKey = (e: WorkflowEdge): string =>
    `${e.source}:${e.sourcePort}→${e.target}:${e.targetPort}`;
  const beforeEdges = new Map(before.edges.map((e) => [edgeKey(e), e]));
  const afterEdges = new Map(after.edges.map((e) => [edgeKey(e), e]));
  const edges: EdgeDiff[] = [];

  const describe = (edge: WorkflowEdge, graph: Workflow): string => {
    const name = (id: string): string => {
      const node = graph.nodes.find((n) => n.id === id);
      return node?.label ?? node?.type ?? id;
    };
    return `${name(edge.source)} (${edge.sourcePort}) → ${name(edge.target)} (${edge.targetPort})`;
  };

  for (const [key, edge] of afterEdges) {
    if (!beforeEdges.has(key)) {
      edges.push({ edgeId: edge.id, kind: 'added', description: describe(edge, after) });
    }
  }
  for (const [key, edge] of beforeEdges) {
    if (!afterEdges.has(key)) {
      edges.push({ edgeId: edge.id, kind: 'removed', description: describe(edge, before) });
    }
  }

  const metadata: FieldChange[] = [];
  for (const field of ['name', 'description', 'concurrency'] as const) {
    if (JSON.stringify(before[field]) !== JSON.stringify(after[field])) {
      metadata.push({ path: field, before: before[field], after: after[field] });
    }
  }
  if (JSON.stringify(before.variables ?? {}) !== JSON.stringify(after.variables ?? {})) {
    metadata.push({ path: 'variables', before: before.variables, after: after.variables });
  }

  const summary = {
    added: nodes.filter((n) => n.kind === 'added').length,
    removed: nodes.filter((n) => n.kind === 'removed').length,
    modified: nodes.filter((n) => n.kind === 'modified').length,
    moved: nodes.filter((n) => n.kind === 'moved').length,
  };

  const behaviouralChanges =
    summary.added + summary.removed + summary.modified + edges.length + metadata.length;

  return { nodes, edges, metadata, summary, identical: behaviouralChanges === 0 };
}

function diffNodeFields(before: WorkflowNode, after: WorkflowNode): FieldChange[] {
  const changes: FieldChange[] = [];

  for (const field of ['type', 'label', 'disabled', 'notes', 'typeVersion'] as const) {
    if (before[field] !== after[field]) {
      changes.push({ path: field, before: before[field], after: after[field] });
    }
  }

  if (before.position.x !== after.position.x || before.position.y !== after.position.y) {
    changes.push({ path: 'position', before: before.position, after: after.position });
  }

  const keys = new Set([...Object.keys(before.config), ...Object.keys(after.config)]);
  for (const key of keys) {
    const left = before.config[key];
    const right = after.config[key];
    if (JSON.stringify(left) !== JSON.stringify(right)) {
      changes.push({ path: `config.${key}`, before: left, after: right });
    }
  }

  if (JSON.stringify(before.policy ?? {}) !== JSON.stringify(after.policy ?? {})) {
    changes.push({ path: 'policy', before: before.policy, after: after.policy });
  }

  return changes;
}

/** One-line human summary, used in version lists and commit-style changelogs. */
export function summarizeDiff(diff: WorkflowDiff): string {
  if (diff.identical) return 'No functional changes';
  const parts: string[] = [];
  if (diff.summary.added) parts.push(`+${diff.summary.added} node`);
  if (diff.summary.removed) parts.push(`−${diff.summary.removed} node`);
  if (diff.summary.modified) parts.push(`${diff.summary.modified} modified`);
  if (diff.edges.length) parts.push(`${diff.edges.length} connection`);
  if (diff.metadata.length) parts.push(`${diff.metadata.length} setting`);
  return parts.join(', ');
}
