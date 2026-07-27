import { createContext, runInContext } from 'node:vm';
import { z } from 'zod';
import { defineNode, type NodeDefinition } from '../registry/definition';

export const httpRequestNode = defineNode({
  type: 'flowforge.http',
  version: '1.0.0',
  label: 'REST API',
  description: 'Call an HTTP endpoint and parse the response.',
  category: 'integration',
  icon: 'Globe',
  accent: 'cyan',
  configSchema: z.object({
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']).default('GET'),
    url: z.string().url(),
    headers: z.record(z.string(), z.string()).default({}),
    body: z.unknown().optional(),
    /** Parsed as JSON when the response declares it, otherwise returned as text. */
    parseJson: z.boolean().default(true),
    timeoutMs: z.number().int().min(100).max(120_000).default(30_000),
    /** Non-2xx responses throw unless this is set, letting the error port handle them. */
    throwOnError: z.boolean().default(true),
  }),
  configUi: {
    method: { widget: 'select', order: 1 },
    url: { widget: 'text', order: 2, placeholder: 'https://api.example.com/{{ $.input.id }}' },
    headers: { widget: 'json', order: 3, help: 'Use { "$secret": "MY_KEY" } for credentials.' },
    body: { widget: 'json', order: 4 },
    throwOnError: { widget: 'switch', order: 5 },
  },
  inputs: [
    { id: 'body', label: 'Body', type: 'any' },
    { id: 'url', label: 'URL', type: 'string' },
  ],
  outputs: [
    { id: 'data', label: 'Data', type: 'json' },
    { id: 'status', label: 'Status', type: 'number' },
    { id: 'headers', label: 'Headers', type: 'json' },
    { id: 'error', label: 'Error', type: 'json', conditional: true },
  ],
  capabilities: { sideEffects: true },
  async execute({ config, inputs, ctx }) {
    const url = (inputs.url as string | undefined) ?? config.url;
    const payload = inputs.body ?? config.body;
    const hasBody = payload !== undefined && !['GET', 'HEAD'].includes(config.method);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    ctx.signal.addEventListener('abort', () => controller.abort(), { once: true });

    try {
      const response = await fetch(url, {
        method: config.method,
        headers: {
          ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
          ...config.headers,
        },
        body: hasBody
          ? typeof payload === 'string'
            ? payload
            : JSON.stringify(payload)
          : undefined,
        signal: controller.signal,
      });

      const contentType = response.headers.get('content-type') ?? '';
      const raw = await response.text();
      const data = config.parseJson && contentType.includes('json') ? safeJsonParse(raw) : raw;

      ctx.log(response.ok ? 'info' : 'warn', `${config.method} ${url} → ${response.status}`);

      if (!response.ok && config.throwOnError) {
        throw new Error(`HTTP ${response.status} ${response.statusText}: ${raw.slice(0, 300)}`);
      }
      if (!response.ok) {
        return {
          outputs: {
            error: { status: response.status, body: data },
            status: response.status,
            headers: Object.fromEntries(response.headers),
          },
        };
      }

      return {
        outputs: {
          data,
          status: response.status,
          headers: Object.fromEntries(response.headers),
        },
      };
    } finally {
      clearTimeout(timer);
    }
  },
});

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export const jsonNode = defineNode({
  type: 'flowforge.json',
  version: '1.0.0',
  label: 'JSON',
  description: 'Parse, stringify, pick, or reshape JSON.',
  category: 'data',
  icon: 'Braces',
  accent: 'slate',
  configSchema: z.object({
    operation: z.enum(['parse', 'stringify', 'pick', 'omit', 'set']).default('parse'),
    keys: z.array(z.string()).default([]),
    path: z.string().optional(),
    value: z.unknown().optional(),
    pretty: z.boolean().default(true),
  }),
  configUi: {
    operation: { widget: 'select', order: 1 },
    keys: { widget: 'json', order: 2, help: 'Used by pick and omit.' },
    path: { widget: 'text', order: 3, help: 'Dotted path used by set.' },
    value: { widget: 'json', order: 4 },
  },
  inputs: [{ id: 'value', label: 'Value', type: 'any', required: true }],
  outputs: [{ id: 'value', label: 'Value', type: 'json' }],
  capabilities: { deterministic: true },
  async execute({ config, inputs }) {
    const input = inputs.value;

    switch (config.operation) {
      case 'parse':
        return {
          outputs: {
            value: typeof input === 'string' ? safeJsonParse(input) : input,
          },
        };
      case 'stringify':
        return { outputs: { value: JSON.stringify(input, null, config.pretty ? 2 : 0) } };
      case 'pick': {
        const record = (input ?? {}) as Record<string, unknown>;
        return {
          outputs: {
            value: Object.fromEntries(
              config.keys.filter((k) => k in record).map((k) => [k, record[k]]),
            ),
          },
        };
      }
      case 'omit': {
        const record = { ...((input ?? {}) as Record<string, unknown>) };
        for (const key of config.keys) delete record[key];
        return { outputs: { value: record } };
      }
      case 'set': {
        const record = structuredClone((input ?? {}) as Record<string, unknown>);
        if (config.path) setPath(record, config.path.split('.'), config.value);
        return { outputs: { value: record } };
      }
      default:
        return { outputs: { value: input } };
    }
  },
});

function setPath(target: Record<string, unknown>, path: string[], value: unknown): void {
  const [head, ...rest] = path;
  if (rest.length === 0) {
    target[head] = value;
    return;
  }
  if (typeof target[head] !== 'object' || target[head] === null) target[head] = {};
  setPath(target[head] as Record<string, unknown>, rest, value);
}

export const csvNode = defineNode({
  type: 'flowforge.csv',
  version: '1.0.0',
  label: 'CSV Reader',
  description: 'Parse delimited text into rows of objects.',
  category: 'data',
  icon: 'Table',
  accent: 'slate',
  configSchema: z.object({
    delimiter: z.string().min(1).max(4).default(','),
    hasHeader: z.boolean().default(true),
    maxRows: z.number().int().min(1).max(200_000).default(10_000),
  }),
  configUi: {
    delimiter: { widget: 'text', order: 1 },
    hasHeader: { widget: 'switch', order: 2 },
    maxRows: { widget: 'number', order: 3 },
  },
  inputs: [{ id: 'text', label: 'CSV text', type: 'string', required: true }],
  outputs: [
    { id: 'rows', label: 'Rows', type: 'array' },
    { id: 'columns', label: 'Columns', type: 'array' },
    { id: 'count', label: 'Count', type: 'number' },
  ],
  capabilities: { deterministic: true },
  async execute({ config, inputs }) {
    const { rows, columns } = parseCsv(
      String(inputs.text ?? ''),
      config.delimiter,
      config.hasHeader,
    );
    const limited = rows.slice(0, config.maxRows);
    return { outputs: { rows: limited, columns, count: limited.length } };
  },
});

/** RFC-4180-ish parser: handles quoted fields, escaped quotes, and CRLF. */
export function parseCsv(
  text: string,
  delimiter = ',',
  hasHeader = true,
): { rows: Record<string, unknown>[]; columns: string[] } {
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      record.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      record.push(field);
      records.push(record);
      record = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field || record.length) {
    record.push(field);
    records.push(record);
  }

  const nonEmpty = records.filter((r) => r.some((cell) => cell.trim() !== ''));
  if (nonEmpty.length === 0) return { rows: [], columns: [] };

  const columns = hasHeader
    ? nonEmpty[0].map((c) => c.trim())
    : nonEmpty[0].map((_, i) => `column_${i + 1}`);
  const body = hasHeader ? nonEmpty.slice(1) : nonEmpty;

  return {
    columns,
    rows: body.map((cells) =>
      Object.fromEntries(columns.map((column, i) => [column, cells[i] ?? ''])),
    ),
  };
}

export const textSplitterNode = defineNode({
  type: 'flowforge.text_splitter',
  version: '1.0.0',
  label: 'Text Splitter',
  description: 'Split long text into overlapping chunks.',
  category: 'data',
  icon: 'Scissors',
  accent: 'slate',
  configSchema: z.object({
    chunkSize: z.number().int().min(32).max(20_000).default(1000),
    overlap: z.number().int().min(0).max(5000).default(100),
  }),
  configUi: {
    chunkSize: { widget: 'number', order: 1 },
    overlap: { widget: 'number', order: 2 },
  },
  inputs: [{ id: 'text', label: 'Text', type: 'string', required: true }],
  outputs: [
    { id: 'chunks', label: 'Chunks', type: 'array' },
    { id: 'count', label: 'Count', type: 'number' },
  ],
  capabilities: { deterministic: true },
  async execute({ config, inputs }) {
    const text = String(inputs.text ?? '');
    const chunks: string[] = [];
    const step = Math.max(1, config.chunkSize - config.overlap);
    for (let start = 0; start < text.length; start += step) {
      const chunk = text.slice(start, start + config.chunkSize).trim();
      if (chunk) chunks.push(chunk);
      if (start + config.chunkSize >= text.length) break;
    }
    return { outputs: { chunks, count: chunks.length } };
  },
});

/**
 * Runs user JavaScript in a fresh V8 context with no `require`, no `process`,
 * and a hard timeout.
 *
 * This is *isolation, not a security boundary* — `node:vm` shares a heap with the
 * host and is escapable by a determined attacker. Multi-tenant deployments must run
 * this node in a separate process or a Firecracker/Deno-style sandbox; see
 * `docs/security.md`. Untrusted code is rejected outright unless
 * `FLOWFORGE_ALLOW_CODE_NODES=1` is set.
 */
export const functionNode = defineNode({
  type: 'flowforge.function',
  version: '1.0.0',
  label: 'Function',
  description: 'Transform data with a small JavaScript expression.',
  category: 'code',
  icon: 'Code',
  accent: 'lime',
  configSchema: z.object({
    code: z.string().default('return { value: input };'),
    timeoutMs: z.number().int().min(10).max(10_000).default(1000),
  }),
  configUi: {
    code: {
      widget: 'code',
      language: 'javascript',
      order: 1,
      help: '`input` holds the incoming value. Return an object of output values.',
    },
    timeoutMs: { widget: 'number', order: 2 },
  },
  inputs: [{ id: 'input', label: 'Input', type: 'any' }],
  outputs: [{ id: 'value', label: 'Value', type: 'any' }],
  capabilities: { deterministic: true },
  async execute({ config, inputs, ctx }) {
    const logs: string[] = [];
    const sandbox = {
      input: inputs.input,
      console: {
        log: (...args: unknown[]) => {
          logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
        },
      },
      JSON,
      Math,
      Date,
      Object,
      Array,
      String,
      Number,
      Boolean,
      RegExp,
    };

    const context = createContext(sandbox, { name: `flowforge:${ctx.nodeId}` });
    let result: unknown;
    try {
      result = runInContext(`(function(){${config.code}\n})()`, context, {
        timeout: config.timeoutMs,
        displayErrors: true,
      });
    } catch (error) {
      throw new Error(
        `Function node failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    logs.forEach((line) => ctx.log('info', line));

    // Returning an object of port names is the idiomatic form; anything else is
    // wrapped so simple `return x` still works.
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      return { outputs: result as Record<string, unknown> };
    }
    return { outputs: { value: result } };
  },
});

export const pythonNode = defineNode({
  type: 'flowforge.python',
  version: '0.1.0',
  label: 'Python',
  description: 'Run Python via a configured external runner.',
  category: 'code',
  icon: 'FileCode',
  accent: 'lime',
  configSchema: z.object({
    code: z.string().default('result = {"value": input}'),
    /** URL of a sandboxed execution service. No runner is bundled by design. */
    runnerUrl: z.string().optional(),
    timeoutMs: z.number().int().min(100).max(120_000).default(30_000),
  }),
  configUi: {
    code: { widget: 'code', language: 'python', order: 1 },
    runnerUrl: {
      widget: 'text',
      order: 2,
      help: 'Set PYTHON_RUNNER_URL or fill this in. See docs/plugins.md.',
    },
  },
  inputs: [{ id: 'input', label: 'Input', type: 'any' }],
  outputs: [{ id: 'value', label: 'Value', type: 'any' }],
  capabilities: { sideEffects: true },
  async execute({ config, inputs, ctx }) {
    const runnerUrl = config.runnerUrl ?? process.env.PYTHON_RUNNER_URL;
    if (!runnerUrl) {
      // Executing arbitrary Python in the web server's process would be a remote
      // code execution hole, so this node requires an explicit isolated runner.
      throw new Error(
        'The Python node needs an isolated runner. Set PYTHON_RUNNER_URL to a sandboxed execution service — see docs/plugins.md for a reference container.',
      );
    }

    const response = await fetch(runnerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: config.code, input: inputs.input }),
      signal: ctx.signal,
    });
    if (!response.ok) {
      throw new Error(`Python runner returned ${response.status}: ${await response.text()}`);
    }
    const payload = (await response.json()) as { result?: unknown; stdout?: string };
    if (payload.stdout) ctx.log('info', payload.stdout);
    return { outputs: { value: payload.result } };
  },
});

export const dataNodes = [
  httpRequestNode,
  jsonNode,
  csvNode,
  textSplitterNode,
  functionNode,
  pythonNode,
] as unknown as NodeDefinition<never>[];
