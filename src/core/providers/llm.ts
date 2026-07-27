import { createHash } from 'node:crypto';
import type {
  ChatMessage,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  UsageReport,
} from '../registry/definition';

/** Rough token estimate. Good enough for cost projection without a tokenizer dep. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

export interface ModelPricing {
  /** USD per 1M prompt tokens. */
  promptPerMillion: number;
  /** USD per 1M completion tokens. */
  completionPerMillion: number;
}

/**
 * Published list prices, used for cost *projection* in the debugger and eval
 * reports. Real spend is always taken from the provider response when it reports
 * one. Update via `MODEL_PRICING` rather than hard-coding numbers in nodes.
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  'anthropic/claude-sonnet-4.5': { promptPerMillion: 3, completionPerMillion: 15 },
  'anthropic/claude-haiku-4.5': { promptPerMillion: 1, completionPerMillion: 5 },
  'openai/gpt-4.1': { promptPerMillion: 2, completionPerMillion: 8 },
  'openai/gpt-4.1-mini': { promptPerMillion: 0.4, completionPerMillion: 1.6 },
  'google/gemini-2.5-pro': { promptPerMillion: 1.25, completionPerMillion: 10 },
  'meta-llama/llama-3.3-70b-instruct': { promptPerMillion: 0.12, completionPerMillion: 0.3 },
  'flowforge/mock': { promptPerMillion: 0, completionPerMillion: 0 },
};

export function priceOf(model: string, promptTokens: number, completionTokens: number): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return 0;
  const cost =
    (promptTokens / 1_000_000) * pricing.promptPerMillion +
    (completionTokens / 1_000_000) * pricing.completionPerMillion;
  return Number(cost.toFixed(8));
}

function usageFor(model: string, prompt: string, completion: string): UsageReport {
  const promptTokens = estimateTokens(prompt);
  const completionTokens = estimateTokens(completion);
  return {
    model,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    costUsd: priceOf(model, promptTokens, completionTokens),
  };
}

const flatten = (messages: ChatMessage[]): string =>
  messages.map((m) => `${m.role}: ${m.content}`).join('\n');

/**
 * A deterministic, offline model.
 *
 * FlowForge runs end-to-end with no API keys and no spend. The mock derives its
 * reply from a hash of the request, so the same prompt always produces the same
 * output — which is exactly what makes the evaluation harness and the test suite
 * reproducible. Swap in a real provider by setting `OPENROUTER_API_KEY`.
 */
export class MockLLMProvider implements LLMProvider {
  readonly name = 'mock';
  readonly models = ['flowforge/mock'] as const;

  /** Canned replies keyed by a substring of the prompt, for scripted tests. */
  constructor(private readonly fixtures: Record<string, string> = {}) {}

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const prompt = flatten(req.messages);
    const text = this.synthesize(prompt, req);
    return {
      text,
      finishReason: 'stop',
      usage: { ...usageFor(req.model || 'flowforge/mock', prompt, text), provider: this.name },
    };
  }

  async *stream(req: LLMRequest): AsyncIterable<string> {
    const { text } = await this.complete(req);
    for (const word of text.split(/(?<=\s)/)) {
      if (req.signal?.aborted) return;
      yield word;
    }
  }

  private synthesize(prompt: string, req: LLMRequest): string {
    for (const [needle, reply] of Object.entries(this.fixtures)) {
      if (prompt.includes(needle)) return reply;
    }

    const digest = createHash('sha256').update(prompt).digest('hex');
    const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
    const subject = (lastUser?.content ?? '').trim().slice(0, 160) || 'the request';

    if (req.jsonMode) {
      return JSON.stringify(
        {
          answer: `Mock response for: ${subject}`,
          confidence: (parseInt(digest.slice(0, 2), 16) / 255).toFixed(2),
          fingerprint: digest.slice(0, 8),
        },
        null,
        2,
      );
    }
    return [
      `Mock response for: ${subject}`,
      '',
      "This deterministic reply comes from FlowForge's offline model, so the workflow",
      'runs end to end without an API key. Set OPENROUTER_API_KEY and pick a real model',
      'on the LLM node to swap in live inference.',
      '',
      `fingerprint: ${digest.slice(0, 16)}`,
    ].join('\n');
  }
}

interface OpenRouterChoice {
  message?: { content?: string };
  delta?: { content?: string };
  finish_reason?: string;
}

interface OpenRouterPayload {
  choices?: OpenRouterChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { message?: string };
}

/**
 * OpenRouter adapter — one endpoint, every major model.
 *
 * Only instantiated when an API key is present, so the default $0 path never
 * constructs it. Costs are computed from `MODEL_PRICING` because OpenRouter
 * reports spend asynchronously on a separate generation endpoint.
 */
export class OpenRouterProvider implements LLMProvider {
  readonly name = 'openrouter';
  readonly models = Object.keys(MODEL_PRICING).filter((m) => m !== 'flowforge/mock');

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = 'https://openrouter.ai/api/v1',
    private readonly referer = 'https://github.com/itsshreyasbhardwaj-design/flowforge-ai',
  ) {}

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': this.referer,
      'X-Title': 'FlowForge AI',
    };
  }

  private body(req: LLMRequest, stream: boolean): string {
    return JSON.stringify({
      model: req.model,
      messages: req.messages.map(({ role, content, name }) => ({ role, content, name })),
      temperature: req.temperature,
      max_tokens: req.maxTokens,
      top_p: req.topP,
      stop: req.stop,
      stream,
      ...(req.jsonMode ? { response_format: { type: 'json_object' } } : {}),
    });
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: this.body(req, false),
      signal: req.signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`OpenRouter ${response.status}: ${detail.slice(0, 400)}`);
    }

    const payload = (await response.json()) as OpenRouterPayload;
    if (payload.error) throw new Error(`OpenRouter: ${payload.error.message}`);

    const text = payload.choices?.[0]?.message?.content ?? '';
    const promptTokens = payload.usage?.prompt_tokens ?? estimateTokens(flatten(req.messages));
    const completionTokens = payload.usage?.completion_tokens ?? estimateTokens(text);

    return {
      text,
      finishReason: payload.choices?.[0]?.finish_reason === 'length' ? 'length' : 'stop',
      usage: {
        model: req.model,
        provider: this.name,
        promptTokens,
        completionTokens,
        totalTokens: payload.usage?.total_tokens ?? promptTokens + completionTokens,
        costUsd: priceOf(req.model, promptTokens, completionTokens),
      },
    };
  }

  async *stream(req: LLMRequest): AsyncIterable<string> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: this.body(req, true),
      signal: req.signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`OpenRouter ${response.status}: stream unavailable`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') return;
        try {
          const chunk = JSON.parse(data) as OpenRouterPayload;
          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) yield delta;
        } catch {
          // Ignore keep-alive comments and partial frames.
        }
      }
    }
  }
}

/** Chooses the live provider when a key is configured, the mock otherwise. */
export function createDefaultLLMProvider(env: NodeJS.ProcessEnv = process.env): LLMProvider {
  const key = env.OPENROUTER_API_KEY;
  return key ? new OpenRouterProvider(key) : new MockLLMProvider();
}
