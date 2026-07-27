import { z } from 'zod';
import { defineNode, type NodeDefinition } from '../registry/definition';

export const manualTriggerNode = defineNode({
  type: 'flowforge.trigger_manual',
  version: '1.0.0',
  label: 'Manual Trigger',
  description: 'Start the workflow with a payload you supply.',
  category: 'trigger',
  icon: 'Play',
  accent: 'indigo',
  configSchema: z.object({
    sample: z.unknown().optional(),
  }),
  configUi: {
    sample: { widget: 'json', order: 1, label: 'Sample input', help: 'Used when testing.' },
  },
  inputs: [],
  outputs: [{ id: 'payload', label: 'Payload', type: 'json' }],
  capabilities: { deterministic: true },
  async execute({ config, ctx }) {
    // The run input wins; the configured sample is the fallback so a workflow is
    // always runnable from the canvas without hand-writing a payload each time.
    const runInput = ctx.state.get<unknown>('__runInput');
    return { outputs: { payload: runInput ?? config.sample ?? {} } };
  },
});

export const webhookTriggerNode = defineNode({
  type: 'flowforge.trigger_webhook',
  version: '1.0.0',
  label: 'Webhook Trigger',
  description: 'Start the workflow from an inbound HTTP request.',
  category: 'trigger',
  icon: 'Webhook',
  accent: 'indigo',
  configSchema: z.object({
    path: z.string().default(''),
    method: z.enum(['POST', 'GET', 'PUT']).default('POST'),
    /** Requests must carry this header when a secret is configured. */
    signatureHeader: z.string().default('x-flowforge-signature'),
  }),
  configUi: {
    path: { widget: 'text', order: 1, help: 'Auto-derived from the deployment slug if blank.' },
    method: { widget: 'select', order: 2 },
    signatureHeader: { widget: 'text', order: 3 },
  },
  inputs: [],
  outputs: [
    { id: 'body', label: 'Body', type: 'json' },
    { id: 'headers', label: 'Headers', type: 'json' },
    { id: 'query', label: 'Query', type: 'json' },
  ],
  async execute({ ctx }) {
    const request = ctx.state.get<Record<string, unknown>>('__request') ?? {};
    return {
      outputs: {
        body: request.body ?? ctx.state.get('__runInput') ?? {},
        headers: request.headers ?? {},
        query: request.query ?? {},
      },
    };
  },
});

export const scheduleTriggerNode = defineNode({
  type: 'flowforge.trigger_schedule',
  version: '1.0.0',
  label: 'Schedule',
  description: 'Start the workflow on a cron schedule.',
  category: 'trigger',
  icon: 'CalendarClock',
  accent: 'indigo',
  configSchema: z.object({
    cron: z.string().default('0 * * * *'),
    timezone: z.string().default('UTC'),
  }),
  configUi: {
    cron: {
      widget: 'text',
      order: 1,
      placeholder: '0 9 * * 1-5',
      help: 'Standard 5-field cron.',
    },
    timezone: { widget: 'text', order: 2 },
  },
  inputs: [],
  outputs: [{ id: 'firedAt', label: 'Fired at', type: 'string' }],
  async execute() {
    return { outputs: { firedAt: new Date().toISOString() } };
  },
});

export const outputNode = defineNode({
  type: 'flowforge.output',
  version: '1.0.0',
  label: 'Output',
  description: 'Define what the workflow returns to its caller.',
  category: 'output',
  icon: 'LogOut',
  accent: 'indigo',
  configSchema: z.object({
    name: z.string().default('result'),
  }),
  configUi: { name: { widget: 'text', order: 1, help: 'Key in the returned object.' } },
  inputs: [{ id: 'value', label: 'Value', type: 'any', required: true }],
  outputs: [{ id: 'value', label: 'Value', type: 'any' }],
  capabilities: { deterministic: true },
  async execute({ inputs }) {
    return { outputs: { value: inputs.value } };
  },
});

/**
 * Outbound webhook, and the transport behind the Slack and Discord nodes.
 *
 * Both of those services accept a plain JSON POST to an incoming-webhook URL, so
 * they need no SDK and no OAuth dance — just a URL held in the vault.
 */
export const webhookOutNode = defineNode({
  type: 'flowforge.webhook_out',
  version: '1.0.0',
  label: 'Webhook',
  description: 'POST a payload to an outbound webhook URL.',
  category: 'integration',
  icon: 'Send',
  accent: 'cyan',
  configSchema: z.object({
    url: z.string().url(),
    headers: z.record(z.string(), z.string()).default({}),
  }),
  configUi: {
    url: {
      widget: 'text',
      order: 1,
      help: 'Use { "$secret": "WEBHOOK_URL" } to keep it private.',
    },
    headers: { widget: 'json', order: 2 },
  },
  inputs: [{ id: 'payload', label: 'Payload', type: 'any', required: true }],
  outputs: [{ id: 'status', label: 'Status', type: 'number' }],
  capabilities: { sideEffects: true },
  async execute({ config, inputs, ctx }) {
    const response = await fetch(config.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...config.headers },
      body: JSON.stringify(inputs.payload),
      signal: ctx.signal,
    });
    if (!response.ok) {
      throw new Error(`Webhook returned ${response.status}: ${await response.text()}`);
    }
    return { outputs: { status: response.status } };
  },
});

function chatWebhookNode(options: {
  type: string;
  label: string;
  icon: string;
  secretKey: string;
  buildBody: (text: string, channel?: string) => Record<string, unknown>;
}) {
  return defineNode({
    type: options.type,
    version: '1.0.0',
    label: options.label,
    description: `Post a message to ${options.label} via an incoming webhook.`,
    category: 'integration',
    icon: options.icon,
    accent: 'cyan',
    configSchema: z.object({
      webhookUrl: z.string().optional(),
      channel: z.string().optional(),
      text: z.string().default(''),
    }),
    configUi: {
      webhookUrl: {
        widget: 'secret',
        order: 1,
        help: `Defaults to the ${options.secretKey} secret.`,
      },
      channel: { widget: 'text', order: 2 },
      text: { widget: 'textarea', order: 3 },
    },
    inputs: [{ id: 'text', label: 'Text', type: 'string' }],
    outputs: [{ id: 'status', label: 'Status', type: 'number' }],
    secrets: [
      { key: options.secretKey, label: `${options.label} webhook URL`, required: true },
    ],
    capabilities: { sideEffects: true },
    async execute({ config, inputs, ctx }) {
      const url = config.webhookUrl ?? (await ctx.getSecret(options.secretKey));
      if (!url) {
        throw new Error(
          `${options.label} needs a webhook URL. Add the ${options.secretKey} secret in Settings → Credentials.`,
        );
      }
      const text = String(inputs.text ?? config.text);
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(options.buildBody(text, config.channel)),
        signal: ctx.signal,
      });
      if (!response.ok) {
        throw new Error(`${options.label} returned ${response.status}`);
      }
      return { outputs: { status: response.status } };
    },
  });
}

export const slackNode = chatWebhookNode({
  type: 'flowforge.slack',
  label: 'Slack',
  icon: 'MessageSquare',
  secretKey: 'SLACK_WEBHOOK_URL',
  buildBody: (text, channel) => (channel ? { text, channel } : { text }),
});

export const discordNode = chatWebhookNode({
  type: 'flowforge.discord',
  label: 'Discord',
  icon: 'MessagesSquare',
  secretKey: 'DISCORD_WEBHOOK_URL',
  buildBody: (text) => ({ content: text }),
});

export const githubNode = defineNode({
  type: 'flowforge.github',
  version: '1.0.0',
  label: 'GitHub',
  description: 'Read issues and repository metadata, or open an issue.',
  category: 'integration',
  icon: 'GitPullRequest',
  accent: 'cyan',
  configSchema: z.object({
    operation: z
      .enum(['listIssues', 'getRepo', 'createIssue', 'getFile'])
      .default('listIssues'),
    owner: z.string().min(1),
    repo: z.string().min(1),
    title: z.string().optional(),
    body: z.string().optional(),
    path: z.string().optional(),
    perPage: z.number().int().min(1).max(100).default(20),
  }),
  configUi: {
    operation: { widget: 'select', order: 1 },
    owner: { widget: 'text', order: 2 },
    repo: { widget: 'text', order: 3 },
    title: { widget: 'text', order: 4, help: 'createIssue only.' },
    body: { widget: 'textarea', order: 5 },
    path: { widget: 'text', order: 6, help: 'getFile only.' },
  },
  inputs: [{ id: 'input', label: 'Input', type: 'any' }],
  outputs: [{ id: 'data', label: 'Data', type: 'json' }],
  secrets: [
    {
      key: 'GITHUB_TOKEN',
      label: 'GitHub token',
      description: 'Only needed for private repos and writes.',
    },
  ],
  capabilities: { sideEffects: true },
  async execute({ config, ctx }) {
    const token = await ctx.getSecret('GITHUB_TOKEN');
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    const base = `https://api.github.com/repos/${config.owner}/${config.repo}`;
    const request = async (url: string, init?: RequestInit): Promise<unknown> => {
      const response = await fetch(url, { ...init, headers, signal: ctx.signal });
      if (!response.ok) {
        throw new Error(`GitHub ${response.status}: ${(await response.text()).slice(0, 300)}`);
      }
      return response.json();
    };

    switch (config.operation) {
      case 'getRepo':
        return { outputs: { data: await request(base) } };
      case 'listIssues':
        return {
          outputs: { data: await request(`${base}/issues?per_page=${config.perPage}`) },
        };
      case 'getFile': {
        if (!config.path) throw new Error('getFile requires a path');
        const file = (await request(`${base}/contents/${config.path}`)) as { content?: string };
        const content = file.content
          ? Buffer.from(file.content, 'base64').toString('utf8')
          : '';
        return { outputs: { data: { ...file, content } } };
      }
      case 'createIssue': {
        if (!token) throw new Error('createIssue requires the GITHUB_TOKEN secret');
        if (!config.title) throw new Error('createIssue requires a title');
        return {
          outputs: {
            data: await request(`${base}/issues`, {
              method: 'POST',
              body: JSON.stringify({ title: config.title, body: config.body }),
            }),
          },
        };
      }
      default:
        throw new Error(`Unsupported operation: ${config.operation}`);
    }
  },
});

export const webSearchNode = defineNode({
  type: 'flowforge.web_search',
  version: '1.0.0',
  label: 'Web Search',
  description: 'Search the web via a configured search API.',
  category: 'integration',
  icon: 'Telescope',
  accent: 'cyan',
  configSchema: z.object({
    query: z.string().default(''),
    maxResults: z.number().int().min(1).max(25).default(5),
  }),
  configUi: {
    query: { widget: 'text', order: 1 },
    maxResults: { widget: 'number', order: 2 },
  },
  inputs: [{ id: 'query', label: 'Query', type: 'string' }],
  outputs: [{ id: 'results', label: 'Results', type: 'array' }],
  secrets: [{ key: 'BRAVE_SEARCH_API_KEY', label: 'Brave Search API key', required: true }],
  capabilities: { sideEffects: true },
  async execute({ config, inputs, ctx }) {
    const key = await ctx.getSecret('BRAVE_SEARCH_API_KEY');
    const query = String(inputs.query ?? config.query);
    if (!key) {
      throw new Error(
        'Web Search needs the BRAVE_SEARCH_API_KEY secret. Brave offers a free tier; add the key in Settings → Credentials.',
      );
    }

    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(config.maxResults));

    const response = await fetch(url, {
      headers: { Accept: 'application/json', 'X-Subscription-Token': key },
      signal: ctx.signal,
    });
    if (!response.ok) throw new Error(`Brave Search returned ${response.status}`);

    const payload = (await response.json()) as {
      web?: { results?: { title: string; url: string; description: string }[] };
    };
    return {
      outputs: {
        results: (payload.web?.results ?? []).map((r) => ({
          title: r.title,
          url: r.url,
          snippet: r.description,
        })),
      },
    };
  },
});

/**
 * Bridge to an external MCP server.
 *
 * Speaks JSON-RPC 2.0 over the Streamable HTTP transport, which is the transport
 * a hosted MCP server exposes. Stdio servers are reached by fronting them with the
 * reference proxy in `docs/mcp.md`, so the node never spawns processes itself.
 */
export const mcpNode = defineNode({
  type: 'flowforge.mcp',
  version: '1.0.0',
  label: 'MCP Server',
  description: 'Call a tool on a Model Context Protocol server.',
  category: 'integration',
  icon: 'Plug',
  accent: 'cyan',
  configSchema: z.object({
    serverUrl: z.string().url(),
    operation: z.enum(['listTools', 'callTool']).default('callTool'),
    toolName: z.string().optional(),
    arguments: z.record(z.string(), z.unknown()).default({}),
    authHeader: z.string().optional(),
  }),
  configUi: {
    serverUrl: { widget: 'text', order: 1, placeholder: 'https://mcp.example.com/mcp' },
    operation: { widget: 'select', order: 2 },
    toolName: { widget: 'text', order: 3 },
    arguments: { widget: 'json', order: 4 },
    authHeader: { widget: 'secret', order: 5, help: 'Sent verbatim as Authorization.' },
  },
  inputs: [{ id: 'arguments', label: 'Arguments', type: 'json' }],
  outputs: [
    { id: 'result', label: 'Result', type: 'json' },
    { id: 'text', label: 'Text', type: 'string' },
  ],
  capabilities: { sideEffects: true },
  async execute({ config, inputs, ctx }) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (config.authHeader) headers.Authorization = config.authHeader;

    const rpc = async (method: string, params?: unknown): Promise<unknown> => {
      const response = await fetch(config.serverUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
        signal: ctx.signal,
      });
      if (!response.ok) {
        throw new Error(`MCP server returned ${response.status}: ${await response.text()}`);
      }
      const raw = await response.text();
      // Streamable HTTP may answer with SSE framing even for a single response.
      const jsonLine = raw.startsWith('event:')
        ? raw
            .split('\n')
            .find((l) => l.startsWith('data: '))
            ?.slice(6)
        : raw;
      const payload = JSON.parse(jsonLine ?? raw) as {
        result?: unknown;
        error?: { message: string };
      };
      if (payload.error) throw new Error(`MCP error: ${payload.error.message}`);
      return payload.result;
    };

    if (config.operation === 'listTools') {
      const result = await rpc('tools/list');
      return { outputs: { result, text: JSON.stringify(result, null, 2) } };
    }

    if (!config.toolName) throw new Error('callTool requires a toolName');
    const args = (inputs.arguments as Record<string, unknown>) ?? config.arguments;
    const result = (await rpc('tools/call', { name: config.toolName, arguments: args })) as {
      content?: { type: string; text?: string }[];
    };
    const text = (result?.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('\n');

    return { outputs: { result, text } };
  },
});

export const ioNodes = [
  manualTriggerNode,
  webhookTriggerNode,
  scheduleTriggerNode,
  outputNode,
  webhookOutNode,
  slackNode,
  discordNode,
  githubNode,
  webSearchNode,
  mcpNode,
] as unknown as NodeDefinition<never>[];
