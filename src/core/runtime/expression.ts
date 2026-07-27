/**
 * Template resolution for node configuration.
 *
 * Deliberately *not* a JavaScript evaluator. Config templates use `{{ path }}`
 * where `path` is a dotted accessor over the run scope, with optional array
 * indexing and an `??` fallback:
 *
 *   {{ $.input.question }}
 *   {{ $.nodes.retrieve.output.docs[0].text }}
 *   {{ $.vars.tone ?? "neutral" }}
 *
 * Semantics match what users expect from Zapier/n8n-style templating:
 * a template consisting of exactly one expression yields the *raw value*
 * (preserving objects, arrays, numbers); anything else is string interpolation.
 */

export interface ExpressionScope {
  /** The run's input payload. */
  input: unknown;
  /** Per-node outputs so far: `$.nodes.<nodeId>.output.<portId>`. */
  nodes: Record<string, { output: Record<string, unknown> }>;
  /** Workflow-level variables. */
  vars: Record<string, unknown>;
  /** Run metadata: `runId`, `workflowId`, `now`. */
  run: Record<string, unknown>;
}

const EXPRESSION = /\{\{([\s\S]*?)\}\}/g;

export class ExpressionError extends Error {
  constructor(
    message: string,
    public readonly expression: string,
  ) {
    super(message);
    this.name = 'ExpressionError';
  }
}

/** Split `a.b[0].c` into `['a','b','0','c']`. */
function tokenizePath(path: string): string[] {
  const tokens: string[] = [];
  let current = '';
  for (let i = 0; i < path.length; i++) {
    const ch = path[i];
    if (ch === '.') {
      if (current) tokens.push(current);
      current = '';
    } else if (ch === '[') {
      if (current) tokens.push(current);
      current = '';
      const close = path.indexOf(']', i);
      if (close === -1) throw new ExpressionError('Unclosed "[" in path', path);
      tokens.push(path.slice(i + 1, close).replace(/^['"]|['"]$/g, ''));
      i = close;
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

function readPath(scope: ExpressionScope, path: string): unknown {
  const tokens = tokenizePath(path.trim());
  if (tokens[0] !== '$') throw new ExpressionError('Expressions must start with "$"', path);

  let value: unknown = scope;
  for (const token of tokens.slice(1)) {
    if (value == null) return undefined;
    if (Array.isArray(value)) {
      const index = Number(token);
      value = Number.isInteger(index) ? value[index] : undefined;
    } else if (typeof value === 'object') {
      value = (value as Record<string, unknown>)[token];
    } else {
      return undefined;
    }
  }
  return value;
}

/** Parse a literal on the right-hand side of `??`. */
function parseLiteral(raw: string): unknown {
  const text = raw.trim();
  if (text === 'null') return null;
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  const quoted = /^(['"])([\s\S]*)\1$/.exec(text);
  if (quoted) return quoted[2];
  return text;
}

function evaluateOne(expression: string, scope: ExpressionScope): unknown {
  const [pathPart, ...fallbackParts] = expression.split('??');
  const value = readPath(scope, pathPart);
  if (value === undefined && fallbackParts.length > 0) {
    return parseLiteral(fallbackParts.join('??'));
  }
  return value;
}

function stringify(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Resolve a single template string. Returns a raw value for lone expressions. */
export function resolveTemplate(template: string, scope: ExpressionScope): unknown {
  EXPRESSION.lastIndex = 0;
  const matches = [...template.matchAll(EXPRESSION)];
  if (matches.length === 0) return template;

  const soleMatch = matches[0];
  if (matches.length === 1 && soleMatch[0] === template.trim()) {
    return evaluateOne(soleMatch[1], scope);
  }

  return template.replace(EXPRESSION, (_full, expr: string) =>
    stringify(evaluateOne(expr, scope)),
  );
}

/** Recursively resolve every string in a config object. */
export function resolveConfig<T>(config: T, scope: ExpressionScope): T {
  if (typeof config === 'string') return resolveTemplate(config, scope) as T;
  if (Array.isArray(config)) return config.map((item) => resolveConfig(item, scope)) as T;
  if (config && typeof config === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(config as Record<string, unknown>)) {
      out[key] = resolveConfig(value, scope);
    }
    return out as T;
  }
  return config;
}

/** Every `{{ }}` expression referenced anywhere in a config tree. */
export function collectReferences(config: unknown, acc = new Set<string>()): Set<string> {
  if (typeof config === 'string') {
    for (const match of config.matchAll(EXPRESSION)) acc.add(match[1].trim());
  } else if (Array.isArray(config)) {
    config.forEach((item) => collectReferences(item, acc));
  } else if (config && typeof config === 'object') {
    Object.values(config as Record<string, unknown>).forEach((v) => collectReferences(v, acc));
  }
  return acc;
}

/** Node ids referenced by `$.nodes.<id>` expressions inside a config tree. */
export function referencedNodeIds(config: unknown): string[] {
  const ids = new Set<string>();
  for (const expr of collectReferences(config)) {
    const tokens = tokenizePath(expr.split('??')[0].trim());
    if (tokens[0] === '$' && tokens[1] === 'nodes' && tokens[2]) ids.add(tokens[2]);
  }
  return [...ids];
}
