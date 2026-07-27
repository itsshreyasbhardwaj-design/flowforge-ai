/**
 * Core graph model.
 *
 * A `Workflow` is a directed acyclic graph of `WorkflowNode`s joined by `WorkflowEdge`s.
 * Edges connect a *source port* on one node to a *target port* on another. Ports are
 * typed, and the type system is deliberately small — see `PortType`.
 *
 * Cycles are rejected at validation time. Iteration is expressed by invoking a
 * sub-workflow (see the `loop` / `parallel` / `subflow` nodes), which keeps the
 * scheduler total and guarantees termination via an invocation depth limit.
 */

/** The value kinds that can travel along an edge. */
export type PortType =
  | 'any'
  | 'string'
  | 'number'
  | 'boolean'
  | 'json'
  | 'array'
  | 'binary'
  | 'message'
  | 'document'
  | 'embedding'
  | 'trigger';

export interface PortSpec {
  /** Stable identifier, unique within its node's input or output set. */
  id: string;
  label: string;
  type: PortType;
  description?: string;
  /**
   * Required inputs must receive a value before the node becomes runnable.
   * An optional input that is never delivered simply resolves to `undefined`.
   */
  required?: boolean;
  /**
   * Output ports flagged `conditional` may be omitted from a node's result.
   * Downstream nodes reachable only through an omitted port are skipped.
   */
  conditional?: boolean;
}

export interface WorkflowNode {
  id: string;
  /** Registry key of the node definition, e.g. `flowforge.llm`. */
  type: string;
  /** Semver range of the definition this node was authored against. */
  typeVersion?: string;
  label?: string;
  position: { x: number; y: number };
  /** Raw, unresolved configuration. May contain `{{ }}` expressions and secret refs. */
  config: Record<string, unknown>;
  /** Optional visual grouping; purely cosmetic, no execution semantics. */
  groupId?: string;
  disabled?: boolean;
  notes?: string;
  /** Per-node overrides of the workflow-level execution policy. */
  policy?: Partial<NodePolicy>;
}

export interface NodePolicy {
  /** Attempts *after* the first failure. 0 disables retrying. */
  retries: number;
  /** Base delay in ms for exponential backoff between retries. */
  retryBackoffMs: number;
  /** Hard wall-clock limit for a single attempt, in ms. */
  timeoutMs: number;
  /**
   * `fail`     – abort the run (default)
   * `continue` – record the error, emit nothing, and skip downstream nodes
   * `route`    – emit the error object on the node's `error` port if it has one
   */
  onError: 'fail' | 'continue' | 'route';
}

export const DEFAULT_NODE_POLICY: NodePolicy = {
  retries: 0,
  retryBackoffMs: 250,
  timeoutMs: 60_000,
  onError: 'fail',
};

export interface WorkflowEdge {
  id: string;
  source: string;
  sourcePort: string;
  target: string;
  targetPort: string;
  label?: string;
}

export interface WorkflowGroup {
  id: string;
  label: string;
  color?: string;
  position: { x: number; y: number };
  size: { width: number; height: number };
}

export interface Workflow {
  id: string;
  name: string;
  description?: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  groups?: WorkflowGroup[];
  /** Zod-describable shape of the run input, expressed as a JSON-schema-ish record. */
  inputSchema?: Record<string, unknown>;
  policy?: Partial<NodePolicy>;
  /** Max nodes running at once. Defaults to 8. */
  concurrency?: number;
  variables?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

/** A reference the secret vault resolves at execution time. Never persisted resolved. */
export interface SecretRef {
  $secret: string;
}

export function isSecretRef(value: unknown): value is SecretRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as SecretRef).$secret === 'string'
  );
}

export function emptyWorkflow(id: string, name = 'Untitled workflow'): Workflow {
  return { id, name, nodes: [], edges: [], groups: [], concurrency: 8 };
}

/** Assignability: can a value produced by `from` be delivered to a port of type `to`? */
export function isPortCompatible(from: PortType, to: PortType): boolean {
  if (from === to) return true;
  if (from === 'any' || to === 'any') return true;
  // `json` is the structural top type for anything serialisable.
  if (to === 'json') return from !== 'binary' && from !== 'trigger';
  if (from === 'json') return to !== 'binary' && to !== 'trigger';
  // Documents and messages are objects; arrays of them still satisfy `array`.
  if (to === 'array' && (from === 'document' || from === 'message')) return true;
  if (to === 'string' && (from === 'number' || from === 'boolean')) return true;
  return false;
}
