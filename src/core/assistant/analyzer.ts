import { findRoots, topologicalOrder, validateWorkflow } from '../graph/validate';
import type { Workflow, WorkflowNode } from '../graph/types';
import type { NodeRegistry } from '../registry/registry';
import type { RunTrace } from '../runtime/events';

export type SuggestionSeverity = 'critical' | 'warning' | 'info';

export interface Suggestion {
  id: string;
  severity: SuggestionSeverity;
  title: string;
  detail: string;
  nodeId?: string;
  /** Present when the assistant can apply the change itself. */
  fix?: WorkflowFix;
}

export type WorkflowFix =
  | { kind: 'setConfig'; nodeId: string; patch: Record<string, unknown> }
  | { kind: 'setPolicy'; nodeId: string; patch: Record<string, unknown> }
  | { kind: 'removeNode'; nodeId: string }
  | { kind: 'removeEdge'; edgeId: string }
  | { kind: 'setConcurrency'; value: number };

/**
 * Deterministic workflow review.
 *
 * Every rule here is static analysis over the graph plus, optionally, recent
 * traces — no model call, so it is free, instant, and gives the same answer twice.
 * The LLM-backed assistant calls this first and explains the findings rather than
 * re-deriving them, which is what keeps its advice grounded.
 */
export function analyzeWorkflow(
  workflow: Workflow,
  registry: NodeRegistry,
  traces: RunTrace[] = [],
): Suggestion[] {
  const suggestions: Suggestion[] = [];
  const push = (s: Suggestion): void => void suggestions.push(s);

  for (const issue of validateWorkflow(workflow, registry).issues) {
    push({
      id: `validation:${issue.code}:${issue.nodeId ?? issue.edgeId ?? 'graph'}`,
      severity: issue.severity === 'error' ? 'critical' : 'warning',
      title: issue.message,
      detail:
        issue.code === 'CYCLE_DETECTED'
          ? 'Replace the back-edge with a Loop node pointing at a sub-workflow. That keeps the graph acyclic and gives you per-iteration traces.'
          : 'Fix this before the workflow can run.',
      nodeId: issue.nodeId,
      fix:
        issue.code === 'DUPLICATE_EDGE' && issue.edgeId
          ? { kind: 'removeEdge', edgeId: issue.edgeId }
          : undefined,
    });
  }

  const nodeById = new Map(workflow.nodes.map((n) => [n.id, n]));

  // --- structural review --------------------------------------------------
  const roots = findRoots(workflow);
  const triggerRoots = roots.filter(
    (id) => registry.tryGet(nodeById.get(id)?.type ?? '')?.category === 'trigger',
  );
  if (workflow.nodes.length > 0 && triggerRoots.length === 0) {
    push({
      id: 'structure:no-trigger',
      severity: 'warning',
      title: 'No trigger node',
      detail:
        'Add a Manual, Webhook, or Schedule trigger so the workflow has an explicit entry point and its input shape is documented.',
    });
  }

  const hasOutput = workflow.nodes.some((n) => registry.tryGet(n.type)?.category === 'output');
  if (workflow.nodes.length > 2 && !hasOutput) {
    push({
      id: 'structure:no-output',
      severity: 'info',
      title: 'No Output node',
      detail:
        'Without an Output node the run returns every leaf node keyed by id. An Output node pins a stable response contract for API consumers.',
    });
  }

  // --- parallelism --------------------------------------------------------
  const order = topologicalOrder(workflow);
  if (order) {
    const depth = longestPath(workflow);
    const width = workflow.nodes.length ? workflow.nodes.length / Math.max(1, depth) : 0;
    const concurrency = workflow.concurrency ?? 8;
    if (width > concurrency) {
      push({
        id: 'perf:concurrency',
        severity: 'info',
        title: `Raise concurrency above ${concurrency}`,
        detail: `About ${Math.round(width)} nodes can run at the same level, but the workflow caps parallelism at ${concurrency}. Raising it shortens wall-clock time without changing results.`,
        fix: { kind: 'setConcurrency', value: Math.min(32, Math.ceil(width)) },
      });
    }
  }

  for (const node of workflow.nodes) {
    const def = registry.tryGet(node.type);
    if (!def) continue;

    // --- cost -------------------------------------------------------------
    if (def.category === 'model' || def.category === 'agent') {
      const temperature = node.config.temperature;
      if (typeof temperature === 'number' && temperature > 1.2) {
        push({
          id: `quality:temperature:${node.id}`,
          severity: 'info',
          title: `"${node.label ?? def.label}" runs very hot`,
          detail: `Temperature ${temperature} makes output hard to evaluate and reproduce. Below 0.7 is usual for extraction and routing.`,
          nodeId: node.id,
          fix: { kind: 'setConfig', nodeId: node.id, patch: { temperature: 0.7 } },
        });
      }

      const maxTokens = node.config.maxTokens;
      if (typeof maxTokens === 'number' && maxTokens > 8000) {
        push({
          id: `cost:maxTokens:${node.id}`,
          severity: 'info',
          title: `"${node.label ?? def.label}" allows ${maxTokens} output tokens`,
          detail:
            'Output tokens are the expensive half of most price sheets. Cap this at the length you actually need.',
          nodeId: node.id,
        });
      }
    }

    // --- reliability ------------------------------------------------------
    if (def.capabilities?.sideEffects && (node.policy?.retries ?? 0) === 0) {
      push({
        id: `reliability:retries:${node.id}`,
        severity: 'warning',
        title: `"${node.label ?? def.label}" has no retries`,
        detail:
          'Network calls fail transiently. Two retries with backoff removes most spurious failures, at the cost of possible duplicate side effects — only enable it if this call is idempotent.',
        nodeId: node.id,
        fix: { kind: 'setPolicy', nodeId: node.id, patch: { retries: 2, retryBackoffMs: 500 } },
      });
    }

    if (node.type === 'flowforge.http' && typeof node.config.url === 'string') {
      if (node.config.url.startsWith('http://')) {
        push({
          id: `security:http:${node.id}`,
          severity: 'warning',
          title: 'Unencrypted HTTP request',
          detail:
            'Traffic to this endpoint is sent in the clear. Use https:// if the host supports it.',
          nodeId: node.id,
        });
      }
      const headers = node.config.headers as Record<string, unknown> | undefined;
      const inlineSecret = Object.entries(headers ?? {}).find(
        ([key, value]) =>
          /auth|key|token/i.test(key) &&
          typeof value === 'string' &&
          value.length > 12 &&
          !value.includes('{{'),
      );
      if (inlineSecret) {
        push({
          id: `security:inline-secret:${node.id}`,
          severity: 'critical',
          title: 'Credential hard-coded in a header',
          detail: `The "${inlineSecret[0]}" header holds a literal value. Replace it with { "$secret": "MY_KEY" } so it is encrypted at rest and redacted from traces.`,
          nodeId: node.id,
        });
      }
    }

    // --- retrieval quality ------------------------------------------------
    if (node.type === 'flowforge.vector_search') {
      const emptyHandled = workflow.edges.some(
        (e) => e.source === node.id && e.sourcePort === 'empty',
      );
      if (!emptyHandled) {
        push({
          id: `quality:no-empty-branch:${node.id}`,
          severity: 'warning',
          title: 'Retrieval has no empty-result branch',
          detail:
            'When nothing is retrieved, this branch simply stops and the model downstream never runs — or worse, answers from nothing. Connect the "No matches" port to a fallback.',
          nodeId: node.id,
        });
      }
      if ((node.config.minScore ?? 0) === 0) {
        push({
          id: `quality:minScore:${node.id}`,
          severity: 'info',
          title: 'No relevance floor on retrieval',
          detail:
            'With minScore at 0 the worst match in the collection is still returned, so an irrelevant chunk always reaches the prompt. Add a floor. The right value depends on the embedding provider — around 0.1 for the built-in lexical embedder, higher for a real semantic model.',
          nodeId: node.id,
          fix: { kind: 'setConfig', nodeId: node.id, patch: { minScore: 0.1 } },
        });
      }
    }

    if (node.type === 'flowforge.human_approval' && node.config.mode === 'autoApprove') {
      push({
        id: `safety:auto-approve:${node.id}`,
        severity: 'warning',
        title: 'Human approval is set to auto-approve',
        detail:
          'This gate currently approves everything. Switch it back to manual before publishing, or the review step is decorative.',
        nodeId: node.id,
      });
    }

    if (node.disabled) {
      push({
        id: `hygiene:disabled:${node.id}`,
        severity: 'info',
        title: `"${node.label ?? def.label}" is disabled`,
        detail: 'Disabled nodes are skipped and everything downstream of them is skipped too.',
        nodeId: node.id,
      });
    }
  }

  // --- evidence from real runs -------------------------------------------
  if (traces.length > 0) {
    suggestions.push(...analyzeTraces(workflow, traces));
  }

  const ordering: Record<SuggestionSeverity, number> = { critical: 0, warning: 1, info: 2 };
  return suggestions.sort((a, b) => ordering[a.severity] - ordering[b.severity]);
}

/** Findings that need execution history: slow nodes, flaky nodes, dead branches. */
function analyzeTraces(workflow: Workflow, traces: RunTrace[]): Suggestion[] {
  const suggestions: Suggestion[] = [];
  const nodeById = new Map(workflow.nodes.map((n) => [n.id, n]));

  const stats = new Map<string, { durations: number[]; failures: number; runs: number }>();
  for (const trace of traces) {
    for (const node of Object.values(trace.nodes)) {
      const entry = stats.get(node.nodeId) ?? { durations: [], failures: 0, runs: 0 };
      entry.runs++;
      if (node.durationMs) entry.durations.push(node.durationMs);
      if (node.status === 'failed') entry.failures++;
      stats.set(node.nodeId, entry);
    }
  }

  const totalTime = [...stats.values()].reduce(
    (sum, s) => sum + s.durations.reduce((a, b) => a + b, 0),
    0,
  );

  for (const [nodeId, entry] of stats) {
    const node = nodeById.get(nodeId);
    if (!node) continue;
    const nodeTime = entry.durations.reduce((a, b) => a + b, 0);
    const share = totalTime ? nodeTime / totalTime : 0;

    if (share > 0.4 && entry.durations.length >= 3) {
      suggestions.push({
        id: `perf:hotspot:${nodeId}`,
        severity: 'warning',
        title: `"${labelOf(node)}" is the bottleneck`,
        detail: `This node accounts for ${Math.round(share * 100)}% of total execution time across ${traces.length} run(s), averaging ${Math.round(nodeTime / entry.durations.length)}ms. Cache it, shrink its prompt, or move it off the critical path.`,
        nodeId,
      });
    }

    const failureRate = entry.runs ? entry.failures / entry.runs : 0;
    if (failureRate > 0.1 && entry.runs >= 3) {
      suggestions.push({
        id: `reliability:flaky:${nodeId}`,
        severity: 'critical',
        title: `"${labelOf(node)}" fails ${Math.round(failureRate * 100)}% of the time`,
        detail: `${entry.failures} of ${entry.runs} executions failed. Add retries if the failure is transient, or route the error port to a fallback if it is not.`,
        nodeId,
        fix: { kind: 'setPolicy', nodeId, patch: { retries: 2, onError: 'route' } },
      });
    }
  }

  for (const node of workflow.nodes) {
    if (stats.has(node.id) || traces.length < 3) continue;
    suggestions.push({
      id: `hygiene:never-executed:${node.id}`,
      severity: 'info',
      title: `"${labelOf(node)}" never ran`,
      detail: `Across the last ${traces.length} runs this node was never reached. Its branch condition may be unreachable, or it may be dead weight.`,
      nodeId: node.id,
    });
  }

  return suggestions;
}

const labelOf = (node: WorkflowNode): string => node.label ?? node.type;

/** Longest path in node count — the workflow's critical-path depth. */
export function longestPath(workflow: Workflow): number {
  const order = topologicalOrder(workflow);
  if (!order) return workflow.nodes.length;

  const depth = new Map<string, number>(order.map((id) => [id, 1]));
  for (const id of order) {
    for (const edge of workflow.edges.filter((e) => e.source === id)) {
      depth.set(edge.target, Math.max(depth.get(edge.target) ?? 1, (depth.get(id) ?? 1) + 1));
    }
  }
  return Math.max(0, ...depth.values());
}

/** Applies a fix, returning a new workflow. Pure — the caller decides to persist. */
export function applyFix(workflow: Workflow, fix: WorkflowFix): Workflow {
  switch (fix.kind) {
    case 'setConcurrency':
      return { ...workflow, concurrency: fix.value };
    case 'removeEdge':
      return { ...workflow, edges: workflow.edges.filter((e) => e.id !== fix.edgeId) };
    case 'removeNode':
      return {
        ...workflow,
        nodes: workflow.nodes.filter((n) => n.id !== fix.nodeId),
        edges: workflow.edges.filter((e) => e.source !== fix.nodeId && e.target !== fix.nodeId),
      };
    case 'setConfig':
      return {
        ...workflow,
        nodes: workflow.nodes.map((n) =>
          n.id === fix.nodeId ? { ...n, config: { ...n.config, ...fix.patch } } : n,
        ),
      };
    case 'setPolicy':
      return {
        ...workflow,
        nodes: workflow.nodes.map((n) =>
          n.id === fix.nodeId ? { ...n, policy: { ...n.policy, ...fix.patch } } : n,
        ),
      };
    default:
      return workflow;
  }
}

/** Applies every suggestion that carries an automatic fix. */
export function applyAllFixes(
  workflow: Workflow,
  suggestions: Suggestion[],
): { workflow: Workflow; applied: string[] } {
  let result = workflow;
  const applied: string[] = [];
  for (const suggestion of suggestions) {
    if (!suggestion.fix) continue;
    result = applyFix(result, suggestion.fix);
    applied.push(suggestion.title);
  }
  return { workflow: result, applied };
}
