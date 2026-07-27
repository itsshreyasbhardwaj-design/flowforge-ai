import { z } from 'zod';
import { defineNode, type NodeDefinition } from '../registry/definition';

const OPERATORS = [
  'equals',
  'notEquals',
  'contains',
  'notContains',
  'startsWith',
  'endsWith',
  'greaterThan',
  'lessThan',
  'isEmpty',
  'isNotEmpty',
  'isTruthy',
  'matches',
] as const;

export type ComparisonOperator = (typeof OPERATORS)[number];

/** Pure, total comparison. Exported so tests and the AI assistant can reuse it. */
export function compare(left: unknown, operator: ComparisonOperator, right: unknown): boolean {
  const asString = (v: unknown): string =>
    typeof v === 'string' ? v : (JSON.stringify(v) ?? '');
  const asNumber = (v: unknown): number => (typeof v === 'number' ? v : Number(v));

  switch (operator) {
    case 'equals':
      return asString(left) === asString(right);
    case 'notEquals':
      return asString(left) !== asString(right);
    case 'contains':
      return Array.isArray(left)
        ? left.some((item) => asString(item) === asString(right))
        : asString(left).includes(asString(right));
    case 'notContains':
      return !compare(left, 'contains', right);
    case 'startsWith':
      return asString(left).startsWith(asString(right));
    case 'endsWith':
      return asString(left).endsWith(asString(right));
    case 'greaterThan':
      return asNumber(left) > asNumber(right);
    case 'lessThan':
      return asNumber(left) < asNumber(right);
    case 'isEmpty':
      return (
        left == null ||
        left === '' ||
        (Array.isArray(left) && left.length === 0) ||
        (typeof left === 'object' && Object.keys(left as object).length === 0)
      );
    case 'isNotEmpty':
      return !compare(left, 'isEmpty', right);
    case 'isTruthy':
      return Boolean(left);
    case 'matches':
      try {
        return new RegExp(asString(right)).test(asString(left));
      } catch {
        return false;
      }
    default:
      return false;
  }
}

export const conditionNode = defineNode({
  type: 'flowforge.condition',
  version: '1.0.0',
  label: 'Condition',
  description: 'Branch on a comparison. Only the matching output fires.',
  category: 'logic',
  icon: 'GitBranch',
  accent: 'orange',
  configSchema: z.object({
    operator: z.enum(OPERATORS).default('isTruthy'),
    right: z.unknown().optional(),
  }),
  configUi: {
    operator: { widget: 'select', order: 1 },
    right: {
      widget: 'text',
      order: 2,
      label: 'Compare to',
      help: 'Ignored by unary operators.',
    },
  },
  inputs: [{ id: 'value', label: 'Value', type: 'any', required: true }],
  outputs: [
    { id: 'true', label: 'True', type: 'any', conditional: true },
    { id: 'false', label: 'False', type: 'any', conditional: true },
  ],
  capabilities: { deterministic: true },
  async execute({ config, inputs, ctx }) {
    const matched = compare(inputs.value, config.operator, config.right);
    ctx.log('debug', `Condition evaluated to ${matched}`);
    // Emitting exactly one port is what causes the other branch to be skipped.
    return { outputs: matched ? { true: inputs.value } : { false: inputs.value } };
  },
});

export const routerNode = defineNode({
  type: 'flowforge.router',
  version: '1.0.0',
  label: 'Router',
  description: 'Route a value to the first matching case, or to the fallback.',
  category: 'logic',
  icon: 'Split',
  accent: 'orange',
  configSchema: z.object({
    cases: z
      .array(
        z.object({
          port: z.string().min(1),
          operator: z.enum(OPERATORS).default('equals'),
          value: z.unknown().optional(),
        }),
      )
      .default([]),
    /** Evaluate every case instead of stopping at the first match. */
    matchAll: z.boolean().default(false),
  }),
  configUi: {
    cases: { widget: 'json', order: 1, help: 'Each case adds an output port of that name.' },
    matchAll: { widget: 'switch', order: 2 },
  },
  inputs: [{ id: 'value', label: 'Value', type: 'any', required: true }],
  outputs: [
    { id: 'a', label: 'A', type: 'any', conditional: true },
    { id: 'b', label: 'B', type: 'any', conditional: true },
    { id: 'c', label: 'C', type: 'any', conditional: true },
    { id: 'd', label: 'D', type: 'any', conditional: true },
    { id: 'fallback', label: 'Fallback', type: 'any', conditional: true },
  ],
  capabilities: { deterministic: true },
  async execute({ config, inputs, ctx }) {
    const outputs: Record<string, unknown> = {};
    for (const routeCase of config.cases) {
      if (compare(inputs.value, routeCase.operator, routeCase.value)) {
        outputs[routeCase.port] = inputs.value;
        if (!config.matchAll) break;
      }
    }
    if (Object.keys(outputs).length === 0) outputs.fallback = inputs.value;
    ctx.log('debug', `Routed to: ${Object.keys(outputs).join(', ')}`);
    return { outputs };
  },
});

export const loopNode = defineNode({
  type: 'flowforge.loop',
  version: '1.0.0',
  label: 'Loop',
  description: 'Run a sub-workflow once per item, sequentially or in parallel.',
  category: 'logic',
  icon: 'Repeat',
  accent: 'orange',
  configSchema: z.object({
    workflowId: z.string().min(1),
    mode: z.enum(['sequential', 'parallel']).default('sequential'),
    concurrency: z.number().int().min(1).max(32).default(4),
    maxItems: z.number().int().min(1).max(10_000).default(1000),
    continueOnError: z.boolean().default(false),
  }),
  configUi: {
    workflowId: { widget: 'select', order: 1, label: 'Body workflow' },
    mode: { widget: 'select', order: 2 },
    concurrency: { widget: 'number', order: 3, help: 'Parallel mode only.' },
    maxItems: { widget: 'number', order: 4, help: 'Safety ceiling on iterations.' },
    continueOnError: { widget: 'switch', order: 5 },
  },
  inputs: [{ id: 'items', label: 'Items', type: 'array', required: true }],
  outputs: [
    { id: 'results', label: 'Results', type: 'array' },
    { id: 'errors', label: 'Errors', type: 'array', conditional: true },
    { id: 'count', label: 'Count', type: 'number' },
  ],
  capabilities: { invokesSubflows: true },
  async execute({ config, inputs, ctx }) {
    const items = (Array.isArray(inputs.items) ? inputs.items : [inputs.items]).slice(
      0,
      config.maxItems,
    );
    const results: unknown[] = new Array(items.length);
    const errors: { index: number; message: string }[] = [];

    const runOne = async (item: unknown, index: number): Promise<void> => {
      try {
        results[index] = await ctx.invoke(config.workflowId, {
          item,
          index,
          total: items.length,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push({ index, message });
        if (!config.continueOnError) throw error;
        results[index] = null;
      }
    };

    if (config.mode === 'sequential') {
      for (const [index, item] of items.entries()) {
        if (ctx.signal.aborted) break;
        await runOne(item, index);
      }
    } else {
      // Hand-rolled bounded pool: keeps `concurrency` iterations in flight without
      // materialising every promise up front, which matters for large item sets.
      let cursor = 0;
      const workers = Array.from(
        { length: Math.min(config.concurrency, items.length) },
        async () => {
          while (cursor < items.length && !ctx.signal.aborted) {
            const index = cursor++;
            await runOne(items[index], index);
          }
        },
      );
      await Promise.all(workers);
    }

    ctx.log('info', `Loop completed ${items.length} iteration(s), ${errors.length} error(s)`);
    const outputs: Record<string, unknown> = { results, count: items.length };
    if (errors.length > 0) outputs.errors = errors;
    return { outputs };
  },
});

export const parallelNode = defineNode({
  type: 'flowforge.parallel',
  version: '1.0.0',
  label: 'Parallel',
  description: 'Fan a single input out to several branches at once.',
  category: 'logic',
  icon: 'Rows3',
  accent: 'orange',
  configSchema: z.object({
    branches: z.number().int().min(2).max(4).default(2),
  }),
  configUi: { branches: { widget: 'number', order: 1 } },
  inputs: [{ id: 'value', label: 'Value', type: 'any', required: true }],
  outputs: [
    { id: 'a', label: 'Branch A', type: 'any' },
    { id: 'b', label: 'Branch B', type: 'any' },
    { id: 'c', label: 'Branch C', type: 'any', conditional: true },
    { id: 'd', label: 'Branch D', type: 'any', conditional: true },
  ],
  capabilities: { deterministic: true },
  async execute({ config, inputs }) {
    const ports = ['a', 'b', 'c', 'd'].slice(0, config.branches);
    return { outputs: Object.fromEntries(ports.map((port) => [port, inputs.value])) };
  },
});

export const mergeNode = defineNode({
  type: 'flowforge.merge',
  version: '1.0.0',
  label: 'Merge',
  description: 'Combine several branches back into one value.',
  category: 'logic',
  icon: 'Merge',
  accent: 'orange',
  configSchema: z.object({
    strategy: z.enum(['object', 'array', 'concatText', 'firstPresent']).default('object'),
    separator: z.string().default('\n\n'),
  }),
  configUi: {
    strategy: { widget: 'select', order: 1 },
    separator: { widget: 'text', order: 2, help: 'Used by concatText.' },
  },
  inputs: [
    { id: 'a', label: 'A', type: 'any' },
    { id: 'b', label: 'B', type: 'any' },
    { id: 'c', label: 'C', type: 'any' },
    { id: 'd', label: 'D', type: 'any' },
  ],
  outputs: [{ id: 'value', label: 'Value', type: 'any' }],
  capabilities: { deterministic: true },
  async execute({ config, inputs }) {
    const entries = (['a', 'b', 'c', 'd'] as const)
      .map((key) => [key, inputs[key]] as const)
      .filter(([, value]) => value !== undefined);

    switch (config.strategy) {
      case 'array':
        return { outputs: { value: entries.map(([, value]) => value) } };
      case 'concatText':
        return {
          outputs: {
            value: entries
              .map(([, value]) => (typeof value === 'string' ? value : JSON.stringify(value)))
              .join(config.separator),
          },
        };
      case 'firstPresent':
        return { outputs: { value: entries[0]?.[1] ?? null } };
      default:
        return { outputs: { value: Object.fromEntries(entries) } };
    }
  },
});

export const subflowNode = defineNode({
  type: 'flowforge.subflow',
  version: '1.0.0',
  label: 'Sub-workflow',
  description: 'Invoke another workflow as a single reusable step.',
  category: 'logic',
  icon: 'Workflow',
  accent: 'orange',
  configSchema: z.object({ workflowId: z.string().min(1) }),
  configUi: { workflowId: { widget: 'select', order: 1 } },
  inputs: [{ id: 'input', label: 'Input', type: 'any' }],
  outputs: [{ id: 'output', label: 'Output', type: 'json' }],
  capabilities: { invokesSubflows: true },
  async execute({ config, inputs, ctx }) {
    const output = await ctx.invoke(config.workflowId, inputs.input);
    return { outputs: { output } };
  },
});

export const timerNode = defineNode({
  type: 'flowforge.timer',
  version: '1.0.0',
  label: 'Timer',
  description: 'Pause the branch for a fixed delay.',
  category: 'logic',
  icon: 'Timer',
  accent: 'orange',
  configSchema: z.object({
    delayMs: z.number().int().min(0).max(300_000).default(1000),
  }),
  configUi: { delayMs: { widget: 'number', order: 1, label: 'Delay (ms)' } },
  inputs: [{ id: 'value', label: 'Value', type: 'any' }],
  outputs: [{ id: 'value', label: 'Value', type: 'any' }],
  async execute({ config, inputs, ctx }) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, config.delayMs);
      ctx.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new Error('Cancelled while waiting'));
        },
        { once: true },
      );
    });
    return { outputs: { value: inputs.value } };
  },
});

export const humanApprovalNode = defineNode({
  type: 'flowforge.human_approval',
  version: '1.0.0',
  label: 'Human Approval',
  description: 'Gate the branch on a human decision.',
  category: 'human',
  icon: 'UserCheck',
  accent: 'rose',
  configSchema: z.object({
    title: z.string().default('Approval required'),
    instructions: z.string().default(''),
    /**
     * Offline default. `manual` suspends the run for a real reviewer;
     * `autoApprove` lets the same workflow run unattended in tests and CI.
     */
    mode: z.enum(['manual', 'autoApprove', 'autoReject']).default('manual'),
    timeoutMs: z.number().int().min(0).default(0),
  }),
  configUi: {
    title: { widget: 'text', order: 1 },
    instructions: { widget: 'textarea', order: 2 },
    mode: { widget: 'select', order: 3, help: 'Use autoApprove for unattended test runs.' },
  },
  inputs: [{ id: 'value', label: 'Value', type: 'any', required: true }],
  outputs: [
    { id: 'approved', label: 'Approved', type: 'any', conditional: true },
    { id: 'rejected', label: 'Rejected', type: 'any', conditional: true },
  ],
  capabilities: { suspends: true },
  async execute({ config, inputs, ctx }) {
    if (config.mode === 'autoApprove') {
      ctx.log('info', 'Auto-approved (unattended mode)');
      return { outputs: { approved: inputs.value } };
    }
    if (config.mode === 'autoReject') {
      return { outputs: { rejected: inputs.value } };
    }

    // A decision recorded on the run (via the approvals API) lands in run state
    // before the node executes; without one, the run cannot proceed.
    const decision = ctx.state.get<'approved' | 'rejected'>(`approval:${ctx.nodeId}`);
    if (decision === 'approved') return { outputs: { approved: inputs.value } };
    if (decision === 'rejected') return { outputs: { rejected: inputs.value } };

    throw new Error(
      `"${config.title}" is waiting on a human decision. Record one with POST /api/runs/${ctx.runId}/approvals, or set the node to autoApprove for unattended runs.`,
    );
  },
});

export const logicNodes = [
  conditionNode,
  routerNode,
  loopNode,
  parallelNode,
  mergeNode,
  subflowNode,
  timerNode,
  humanApprovalNode,
] as unknown as NodeDefinition<never>[];
