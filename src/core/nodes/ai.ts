import { z } from 'zod';
import { estimateTokens, priceOf } from '../providers/llm';
import { defineNode, type ChatMessage, type NodeDefinition } from '../registry/definition';

const messageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string(),
  name: z.string().optional(),
});

function coerceMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return [];
  const parsed = z.array(messageSchema).safeParse(value);
  return parsed.success ? parsed.data : [];
}

/** Renders `context` into a string a model can read, whatever shape it arrives in. */
function stringifyContext(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((item, index) => {
        if (typeof item === 'string') return `[${index + 1}] ${item}`;
        const record = item as Record<string, unknown>;
        const text = record.text ?? record.content ?? JSON.stringify(item);
        return `[${index + 1}] ${String(text)}`;
      })
      .join('\n\n');
  }
  return JSON.stringify(value, null, 2);
}

export const llmNode = defineNode({
  type: 'flowforge.llm',
  version: '1.0.0',
  label: 'LLM',
  description: 'Call a language model with a prompt and optional retrieved context.',
  category: 'model',
  icon: 'Sparkles',
  accent: 'violet',
  configSchema: z.object({
    provider: z.string().optional(),
    model: z.string().default('flowforge/mock'),
    systemPrompt: z.string().optional(),
    prompt: z.string().default(''),
    temperature: z.number().min(0).max(2).default(0.7),
    maxTokens: z.number().int().positive().max(200_000).default(1024),
    jsonMode: z.boolean().default(false),
    stream: z.boolean().default(true),
  }),
  configUi: {
    model: { widget: 'select', order: 1, help: 'Any model your provider exposes.' },
    systemPrompt: { widget: 'textarea', order: 2, placeholder: 'You are a helpful assistant.' },
    prompt: {
      widget: 'textarea',
      order: 3,
      placeholder: 'Answer using this context:\n{{ $.nodes.retrieve.output.text }}',
      help: 'Supports {{ }} expressions. Ignored when a messages input is connected.',
    },
    temperature: { widget: 'number', order: 4 },
    maxTokens: { widget: 'number', order: 5 },
    jsonMode: { widget: 'switch', order: 6, help: 'Ask the model for strict JSON.' },
    stream: { widget: 'switch', order: 7, help: 'Stream tokens into the debugger.' },
  },
  inputs: [
    { id: 'prompt', label: 'Prompt', type: 'string' },
    { id: 'messages', label: 'Messages', type: 'array' },
    { id: 'context', label: 'Context', type: 'any' },
  ],
  outputs: [
    { id: 'text', label: 'Text', type: 'string' },
    { id: 'json', label: 'JSON', type: 'json', conditional: true },
    { id: 'usage', label: 'Usage', type: 'json' },
  ],
  capabilities: { deterministic: false },
  async execute({ config, inputs, ctx }) {
    const provider = ctx.providers.llm(config.provider);
    const context = stringifyContext(inputs.context);

    const messages: ChatMessage[] = coerceMessages(inputs.messages);
    if (messages.length === 0) {
      if (config.systemPrompt) messages.push({ role: 'system', content: config.systemPrompt });
      const body = (inputs.prompt as string | undefined) ?? config.prompt;
      messages.push({
        role: 'user',
        content: context ? `${body}\n\n--- Context ---\n${context}` : body,
      });
    } else if (config.systemPrompt && !messages.some((m) => m.role === 'system')) {
      messages.unshift({ role: 'system', content: config.systemPrompt });
    }

    ctx.log('debug', `Calling ${config.model} with ${messages.length} message(s)`);

    // Streaming is a UX feature: the text is identical either way, but the debugger
    // shows tokens as they arrive instead of a spinner.
    if (config.stream && provider.stream) {
      let text = '';
      for await (const chunk of provider.stream({
        model: config.model,
        messages,
        temperature: config.temperature,
        maxTokens: config.maxTokens,
        jsonMode: config.jsonMode,
        signal: ctx.signal,
      })) {
        text += chunk;
        ctx.emitPartial('text', chunk);
      }

      // Streaming responses carry no usage frame, so tokens and cost are
      // estimated here. Without this, streaming — which is the default — would
      // silently report zero spend and make every cost dashboard wrong.
      const promptTokens = estimateTokens(messages.map((m) => m.content).join('\n'));
      const completionTokens = estimateTokens(text);
      const usage = {
        model: config.model,
        provider: provider.name,
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        costUsd: priceOf(config.model, promptTokens, completionTokens),
        estimated: true,
      };

      const outputs: Record<string, unknown> = { text, usage };
      const parsed = tryParseJson(text);
      if (parsed !== undefined) outputs.json = parsed;
      return { outputs, usage, debug: { streamed: true, usageEstimated: true } };
    }

    const response = await provider.complete({
      model: config.model,
      messages,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      jsonMode: config.jsonMode,
      signal: ctx.signal,
    });

    const outputs: Record<string, unknown> = { text: response.text, usage: response.usage };
    const parsed = tryParseJson(response.text);
    if (parsed !== undefined) outputs.json = parsed;

    return { outputs, usage: response.usage, debug: { finishReason: response.finishReason } };
  },
});

function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  const candidate = fenced ? fenced[1] : trimmed;
  if (!candidate.startsWith('{') && !candidate.startsWith('[')) return undefined;
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

export const promptNode = defineNode({
  type: 'flowforge.prompt',
  version: '1.0.0',
  label: 'Prompt',
  description: 'Build a reusable prompt template with named variables.',
  category: 'prompt',
  icon: 'FileText',
  accent: 'sky',
  configSchema: z.object({
    template: z.string().default(''),
    role: z.enum(['system', 'user', 'assistant']).default('user'),
  }),
  configUi: {
    template: {
      widget: 'textarea',
      order: 1,
      placeholder: 'Summarise the following in {{ $.vars.tone }} tone:\n{{ $.input.text }}',
    },
    role: { widget: 'select', order: 2 },
  },
  inputs: [{ id: 'variables', label: 'Variables', type: 'json' }],
  outputs: [
    { id: 'text', label: 'Text', type: 'string' },
    { id: 'messages', label: 'Messages', type: 'array' },
  ],
  capabilities: { deterministic: true },
  async execute({ config, inputs }) {
    // Config templates are already resolved by the executor; a `variables` input
    // allows a second, runtime-scoped pass using `{{ name }}` without the `$.` root.
    let text = config.template;
    if (inputs.variables && typeof inputs.variables === 'object') {
      for (const [key, value] of Object.entries(inputs.variables as Record<string, unknown>)) {
        text = text.replaceAll(
          `{{ ${key} }}`,
          typeof value === 'string' ? value : JSON.stringify(value),
        );
      }
    }
    return {
      outputs: { text, messages: [{ role: config.role, content: text }] },
    };
  },
});

export const embeddingNode = defineNode({
  type: 'flowforge.embedding',
  version: '1.0.0',
  label: 'Embedding',
  description: 'Turn text into vectors for semantic search.',
  category: 'knowledge',
  icon: 'Binary',
  accent: 'emerald',
  configSchema: z.object({
    provider: z.string().optional(),
    textField: z.string().default('text'),
  }),
  configUi: {
    textField: { widget: 'text', order: 1, help: 'Field to read when the input is objects.' },
  },
  inputs: [{ id: 'text', label: 'Text', type: 'any', required: true }],
  outputs: [
    { id: 'embeddings', label: 'Embeddings', type: 'array' },
    { id: 'dimensions', label: 'Dimensions', type: 'number' },
  ],
  capabilities: { deterministic: true },
  async execute({ config, inputs, ctx }) {
    const provider = ctx.providers.embedding(config.provider);
    const raw = Array.isArray(inputs.text) ? inputs.text : [inputs.text];
    const texts = raw.map((item) => {
      if (typeof item === 'string') return item;
      const record = item as Record<string, unknown>;
      return String(record?.[config.textField] ?? JSON.stringify(item));
    });

    const embeddings = await provider.embed(texts, ctx.signal);
    ctx.log('info', `Embedded ${texts.length} item(s) at ${provider.dimensions} dimensions`);
    return { outputs: { embeddings, dimensions: provider.dimensions } };
  },
});

export const knowledgeBaseNode = defineNode({
  type: 'flowforge.knowledge',
  version: '1.0.0',
  label: 'Knowledge Base',
  description: 'Chunk documents, embed them, and write them to a vector collection.',
  category: 'knowledge',
  icon: 'Library',
  accent: 'emerald',
  configSchema: z.object({
    collection: z.string().min(1).default('default'),
    chunkSize: z.number().int().min(64).max(8000).default(800),
    chunkOverlap: z.number().int().min(0).max(2000).default(100),
    store: z.string().optional(),
    embeddingProvider: z.string().optional(),
  }),
  configUi: {
    collection: { widget: 'text', order: 1 },
    chunkSize: { widget: 'number', order: 2, help: 'Characters per chunk.' },
    chunkOverlap: { widget: 'number', order: 3 },
  },
  inputs: [{ id: 'documents', label: 'Documents', type: 'any', required: true }],
  outputs: [
    { id: 'collection', label: 'Collection', type: 'string' },
    { id: 'chunks', label: 'Chunks written', type: 'number' },
  ],
  capabilities: { sideEffects: true },
  async execute({ config, inputs, ctx }) {
    const store = ctx.providers.vector(config.store);
    const embedder = ctx.providers.embedding(config.embeddingProvider);
    const documents = Array.isArray(inputs.documents) ? inputs.documents : [inputs.documents];

    const chunks: { text: string; metadata: Record<string, unknown> }[] = [];
    for (const [docIndex, doc] of documents.entries()) {
      const text =
        typeof doc === 'string'
          ? doc
          : String((doc as Record<string, unknown>)?.text ?? JSON.stringify(doc));
      const metadata =
        typeof doc === 'object' && doc !== null
          ? (((doc as Record<string, unknown>).metadata as Record<string, unknown>) ?? {})
          : {};
      for (const chunk of chunkText(text, config.chunkSize, config.chunkOverlap)) {
        chunks.push({ text: chunk, metadata: { ...metadata, docIndex } });
      }
    }

    if (chunks.length === 0) {
      return { outputs: { collection: config.collection, chunks: 0 } };
    }

    const vectors = await embedder.embed(
      chunks.map((c) => c.text),
      ctx.signal,
    );
    await store.upsert(
      config.collection,
      chunks.map((chunk, index) => ({
        id: `${ctx.runId}_${index}`,
        vector: vectors[index],
        text: chunk.text,
        metadata: chunk.metadata,
      })),
    );

    ctx.log('info', `Wrote ${chunks.length} chunks to "${config.collection}"`);
    return { outputs: { collection: config.collection, chunks: chunks.length } };
  },
});

/** Splits on paragraph boundaries where possible, falling back to hard slicing. */
export function chunkText(text: string, size: number, overlap: number): string[] {
  const clean = text.trim();
  if (clean.length <= size) return clean ? [clean] : [];

  const chunks: string[] = [];
  const step = Math.max(1, size - overlap);
  for (let start = 0; start < clean.length; start += step) {
    let end = Math.min(clean.length, start + size);
    if (end < clean.length) {
      const boundary = clean.lastIndexOf('\n\n', end);
      if (boundary > start + size * 0.5) end = boundary;
    }
    const chunk = clean.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= clean.length) break;
  }
  return chunks;
}

export const vectorSearchNode = defineNode({
  type: 'flowforge.vector_search',
  version: '1.0.0',
  label: 'Vector Search',
  description: 'Retrieve the most semantically similar chunks for a query.',
  category: 'knowledge',
  icon: 'Search',
  accent: 'emerald',
  configSchema: z.object({
    collection: z.string().min(1).default('default'),
    topK: z.number().int().min(1).max(100).default(4),
    minScore: z.number().min(-1).max(1).default(0),
    store: z.string().optional(),
    embeddingProvider: z.string().optional(),
  }),
  configUi: {
    collection: { widget: 'text', order: 1 },
    topK: { widget: 'number', order: 2 },
    minScore: { widget: 'number', order: 3, help: 'Drop matches below this cosine score.' },
  },
  inputs: [{ id: 'query', label: 'Query', type: 'string', required: true }],
  outputs: [
    { id: 'documents', label: 'Documents', type: 'array' },
    { id: 'text', label: 'Joined text', type: 'string' },
    { id: 'empty', label: 'No matches', type: 'trigger', conditional: true },
  ],
  capabilities: { deterministic: true },
  async execute({ config, inputs, ctx }) {
    const store = ctx.providers.vector(config.store);
    const embedder = ctx.providers.embedding(config.embeddingProvider);
    const query = String(inputs.query ?? '');

    const [vector] = await embedder.embed([query], ctx.signal);
    const matches = (await store.query(config.collection, vector, config.topK)).filter(
      (m) => m.score >= config.minScore,
    );

    ctx.log('info', `Retrieved ${matches.length} match(es) from "${config.collection}"`);

    // The `empty` port lets a workflow branch into a fallback when retrieval whiffs
    // — the usual fix for a RAG pipeline confidently answering from nothing.
    if (matches.length === 0) {
      return { outputs: { empty: true } };
    }

    return {
      outputs: {
        documents: matches.map((m) => ({
          text: m.text,
          score: Number(m.score.toFixed(4)),
          metadata: m.metadata,
        })),
        text: matches.map((m, i) => `[${i + 1}] ${m.text}`).join('\n\n'),
      },
      debug: { topScore: matches[0]?.score },
    };
  },
});

export const memoryNode = defineNode({
  type: 'flowforge.memory',
  version: '1.0.0',
  label: 'Memory',
  description: 'Read and append to conversation memory shared across the run.',
  category: 'memory',
  icon: 'Brain',
  accent: 'amber',
  configSchema: z.object({
    key: z.string().min(1).default('conversation'),
    operation: z.enum(['read', 'append', 'clear']).default('append'),
    maxMessages: z.number().int().min(1).max(500).default(50),
    role: z.enum(['user', 'assistant', 'system']).default('user'),
  }),
  configUi: {
    operation: { widget: 'select', order: 1 },
    key: { widget: 'text', order: 2, help: 'Memory bucket name, scoped to the run.' },
    role: { widget: 'select', order: 3 },
    maxMessages: { widget: 'number', order: 4, help: 'Oldest entries are dropped past this.' },
  },
  inputs: [{ id: 'value', label: 'Value', type: 'any' }],
  outputs: [
    { id: 'messages', label: 'Messages', type: 'array' },
    { id: 'size', label: 'Size', type: 'number' },
  ],
  async execute({ config, inputs, ctx }) {
    const stateKey = `memory:${config.key}`;
    const existing = ctx.state.get<ChatMessage[]>(stateKey) ?? [];

    if (config.operation === 'clear') {
      ctx.state.set(stateKey, []);
      return { outputs: { messages: [], size: 0 } };
    }

    if (config.operation === 'append' && inputs.value !== undefined) {
      const content =
        typeof inputs.value === 'string' ? inputs.value : JSON.stringify(inputs.value);
      const next = [...existing, { role: config.role, content } satisfies ChatMessage].slice(
        -config.maxMessages,
      );
      ctx.state.set(stateKey, next);
      return { outputs: { messages: next, size: next.length } };
    }

    return { outputs: { messages: existing, size: existing.length } };
  },
});

const AGENT_ROLES = [
  'planner',
  'researcher',
  'coder',
  'reviewer',
  'critic',
  'manager',
  'custom',
] as const;

/**
 * A role-scoped agent that can delegate to other workflows.
 *
 * Multi-agent systems are expressed as agents whose tools are *other workflows*.
 * That keeps every agent independently runnable, testable, and versionable, and
 * it means delegation reuses the same executor, tracing, and cost accounting as
 * everything else rather than a parallel code path.
 */
export const agentNode = defineNode({
  type: 'flowforge.agent',
  version: '1.0.0',
  label: 'Agent',
  description: 'A role-scoped agent that reasons and may delegate to sub-workflows.',
  category: 'agent',
  icon: 'Bot',
  accent: 'fuchsia',
  configSchema: z.object({
    role: z.enum(AGENT_ROLES).default('custom'),
    name: z.string().default('Agent'),
    instructions: z.string().default(''),
    model: z.string().default('flowforge/mock'),
    provider: z.string().optional(),
    maxIterations: z.number().int().min(1).max(12).default(4),
    temperature: z.number().min(0).max(2).default(0.3),
    tools: z
      .array(
        z.object({
          name: z.string(),
          description: z.string(),
          workflowId: z.string(),
        }),
      )
      .default([]),
  }),
  configUi: {
    name: { widget: 'text', order: 1 },
    role: { widget: 'select', order: 2 },
    instructions: { widget: 'textarea', order: 3, placeholder: 'You break goals into steps…' },
    model: { widget: 'select', order: 4 },
    maxIterations: { widget: 'number', order: 5 },
    tools: { widget: 'json', order: 6, help: 'Each tool delegates to another workflow.' },
  },
  inputs: [
    { id: 'task', label: 'Task', type: 'string', required: true },
    { id: 'context', label: 'Context', type: 'any' },
  ],
  outputs: [
    { id: 'result', label: 'Result', type: 'string' },
    { id: 'transcript', label: 'Transcript', type: 'array' },
    { id: 'iterations', label: 'Iterations', type: 'number' },
  ],
  capabilities: { invokesSubflows: true },
  async execute({ config, inputs, ctx }) {
    const provider = ctx.providers.llm(config.provider);
    const roleBrief = ROLE_BRIEFS[config.role] ?? '';
    const toolBrief = config.tools.length
      ? [
          '',
          'AVAILABLE TOOLS — to use one, reply with only this JSON:',
          '{"action":"tool","tool":"<name>","input":<any>}',
          'To finish, reply with only: {"action":"final","answer":"<your answer>"}',
          '',
          ...config.tools.map((t) => `- ${t.name}: ${t.description}`),
        ].join('\n')
      : '';

    const system = [config.instructions, roleBrief, toolBrief].filter(Boolean).join('\n\n');
    const transcript: ChatMessage[] = [
      { role: 'system', content: system },
      {
        role: 'user',
        content: inputs.context
          ? `${inputs.task}\n\n--- Context ---\n${stringifyContext(inputs.context)}`
          : String(inputs.task),
      },
    ];

    let iterations = 0;
    let result = '';

    while (iterations < config.maxIterations) {
      iterations++;
      const response = await provider.complete({
        model: config.model,
        messages: transcript,
        temperature: config.temperature,
        jsonMode: config.tools.length > 0,
        signal: ctx.signal,
      });
      ctx.reportUsage(response.usage);
      transcript.push({ role: 'assistant', content: response.text });

      const action = parseAgentAction(response.text);

      // Anything that isn't a well-formed tool call is treated as the final answer.
      // Models drift; a agent that hard-fails on unparseable output is unusable.
      if (!action || action.type === 'final') {
        result = action?.type === 'final' ? action.answer : response.text;
        break;
      }

      const tool = config.tools.find((t) => t.name === action.tool);
      if (!tool) {
        transcript.push({
          role: 'user',
          content: `No tool named "${action.tool}". Available: ${config.tools.map((t) => t.name).join(', ')}.`,
        });
        continue;
      }

      ctx.log('info', `${config.name} → ${tool.name}`);
      try {
        const output = await ctx.invoke(tool.workflowId, action.input);
        transcript.push({
          role: 'tool',
          name: tool.name,
          content: JSON.stringify(output).slice(0, 4000),
        });
      } catch (error) {
        transcript.push({
          role: 'tool',
          name: tool.name,
          content: `Tool failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }

    if (!result) {
      result = transcript.filter((m) => m.role === 'assistant').at(-1)?.content ?? '';
      ctx.log(
        'warn',
        `Hit the ${config.maxIterations}-iteration ceiling without a final answer`,
      );
    }

    return {
      outputs: { result, transcript, iterations },
      debug: { role: config.role, toolCount: config.tools.length },
    };
  },
});

type AgentAction =
  { type: 'final'; answer: string } | { type: 'tool'; tool: string; input: unknown };

function parseAgentAction(text: string): AgentAction | null {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(trimmed);
  const candidate = (fenced ? fenced[1] : trimmed).trim();
  if (!candidate.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(candidate) as Record<string, unknown>;
    if (parsed.action === 'final')
      return { type: 'final', answer: String(parsed.answer ?? '') };
    if (parsed.action === 'tool' && typeof parsed.tool === 'string') {
      return { type: 'tool', tool: parsed.tool, input: parsed.input };
    }
    return null;
  } catch {
    return null;
  }
}

const ROLE_BRIEFS: Record<string, string> = {
  planner: 'You decompose goals into an ordered, minimal set of concrete steps.',
  researcher: 'You gather evidence and cite where each claim came from.',
  coder: 'You write correct, idiomatic code and explain the trade-offs you took.',
  reviewer: 'You check work against the requirements and report concrete defects.',
  critic: 'You argue the strongest case against the proposal before accepting it.',
  manager: 'You route work to the right specialist and synthesise their output.',
};

export const aiNodes = [
  llmNode,
  promptNode,
  agentNode,
  embeddingNode,
  knowledgeBaseNode,
  vectorSearchNode,
  memoryNode,
] as unknown as NodeDefinition<never>[];
