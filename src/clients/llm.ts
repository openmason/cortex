import type { Env, SSEEvent } from "../types";
import type { Logger } from "../observability/logger";
import type { Metrics } from "../observability/metrics";

// ---------------------------------------------------------------------------
// LLM Proxy Client — OpenAI-compatible chat completions via llmproxy.xus.one
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  tool_choice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
  temperature?: number;
  max_tokens?: number;
}

export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    index: number;
    message: ChatMessage;
    finish_reason: "stop" | "tool_calls" | "length" | "content_filter";
  }[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cost?: number;
  };
}

// ---------------------------------------------------------------------------
// Model metadata returned by the proxy's /v1/models endpoint
// ---------------------------------------------------------------------------

export interface ProxyModel {
  id: string;
  object: string;
  created?: number;
  owned_by?: string;
  // Capability metadata (v0.5.3+)
  supports_tool_calls?: boolean;
  supports_streaming?: boolean;
  max_context_tokens?: number;
  provider?: string;
  tier?: string;
}

export interface ProxyModelsResponse {
  object: string;
  data: ProxyModel[];
}

// ---------------------------------------------------------------------------
// Well-known model aliases for convenience
// ---------------------------------------------------------------------------

export const MODELS = {
  // Premium
  CLAUDE_OPUS: "cognium/claude-opus-latest",
  GPT_LATEST: "cognium/openai-gpt-latest",
  CLAUDE_SONNET: "cognium/claude-sonnet-latest",

  // Budget
  GROK_CODE: "cognium/grok-code-latest",
  DEEPSEEK: "cognium/deepseek-latest",
  CLAUDE_HAIKU: "cognium/claude-haiku-latest",

  // Specialized
  GEMINI_PRO: "cognium/gemini-pro-latest",
  Z_AI: "cognium/z-ai-latest",
  MINIMAX: "cognium/minimax-m-latest",

  // Cloudflare (no tool calling)
  GPT_OSS_120B: "cognium/gpt-oss-120b",
  QWEN_CODER: "cognium/qwen-2.5-coder",
} as const;

export type ModelAlias = (typeof MODELS)[keyof typeof MODELS];

// KV cache key + TTL for model capabilities
const MODEL_CACHE_KEY = "models:capabilities";
const MODEL_CACHE_TTL = 300; // 5 minutes

export class LLMClient {
  private baseUrl: string;
  private apiKey: string;
  private model: string;
  private toolCallModelOverride?: string;
  private kv?: KVNamespace;
  private log?: Logger;
  private metrics?: Metrics;

  constructor(env: Env, log?: Logger, metrics?: Metrics) {
    this.baseUrl = env.LLMPROXY_URL;
    this.apiKey = env.LLMPROXY_API_KEY;
    this.model = env.LLM_MODEL;
    this.toolCallModelOverride = env.TOOL_CALL_MODEL;
    this.kv = env.SESSION_CACHE;
    this.log = log;
    this.metrics = metrics;
  }

  /**
   * Send a chat completion request to the LLM proxy.
   */
  async chat(request: Omit<ChatCompletionRequest, "model"> & { model?: string }): Promise<ChatCompletionResponse> {
    const model = request.model ?? this.model;
    const start = Date.now();

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    };
    const requestId = this.log?.getContext().requestId;
    if (requestId) headers["X-Request-ID"] = requestId;

    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        ...request,
        model,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      const durationMs = Date.now() - start;
      this.log?.warn("LLM chat failed", { model, status: res.status, durationMs });
      this.metrics?.write("llm_call", { status: "error", durationMs, error: `${res.status}` });
      throw new Error(`LLM proxy request failed: ${res.status} ${text}`);
    }

    const proxyReqId = res.headers?.get?.("X-Proxy-Request-ID") ?? undefined;
    const response: ChatCompletionResponse = await res.json();
    const durationMs = Date.now() - start;
    const tokens = response.usage.total_tokens;

    this.log?.debug("LLM chat completed", {
      model: response.model,
      durationMs,
      tokens,
      cost: response.usage.cost,
      finishReason: response.choices[0]?.finish_reason,
      proxyReqId,
    });
    this.metrics?.write("llm_call", { status: "ok", durationMs, tokens, cost: response.usage.cost });

    return response;
  }

  /**
   * Discover available models from the proxy.
   * Calls GET /v1/models (OpenAI-compatible endpoint).
   */
  async listModels(): Promise<ProxyModel[]> {
    const res = await fetch(`${this.baseUrl}/v1/models`, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
    });

    if (!res.ok) {
      throw new Error(`Failed to list models: ${res.status}`);
    }

    const data: ProxyModelsResponse = await res.json();
    return data.data;
  }

  /**
   * Resolve the best model for tool calling.
   *
   * Priority:
   * 1. TOOL_CALL_MODEL env override (if set and tool-capable)
   * 2. Best tool-capable model from proxy capabilities (KV-cached)
   * 3. Default LLM_MODEL as final fallback
   */
  async getToolCallModel(): Promise<string> {
    // If override is set and we have no capability data, trust the override
    const override = this.toolCallModelOverride;

    try {
      const models = await this.getCachedModels();
      if (models.length === 0) return override ?? this.model;

      // If override is explicitly set, validate it's tool-capable
      if (override) {
        const overrideModel = models.find((m) => m.id === override);
        if (!overrideModel || overrideModel.supports_tool_calls !== false) {
          return override; // trust the override (unknown or capable)
        }
        this.log?.warn("TOOL_CALL_MODEL override is not tool-capable, selecting from capabilities", {
          override,
        });
      }

      // Select best tool-capable model: prefer same as default, then any capable model
      const capable = models.filter((m) => m.supports_tool_calls === true);
      if (capable.length === 0) return override ?? this.model;

      // Prefer the default model if it's tool-capable
      const defaultCapable = capable.find((m) => m.id === this.model);
      if (defaultCapable) return defaultCapable.id;

      // Otherwise pick the first capable model
      return capable[0].id;
    } catch {
      // Capability lookup failed — fall back to override or default
      return override ?? this.model;
    }
  }

  /**
   * Get models list with KV caching to avoid per-request /v1/models calls.
   */
  private async getCachedModels(): Promise<ProxyModel[]> {
    // Try KV cache first
    if (this.kv) {
      try {
        const cached = await this.kv.get(MODEL_CACHE_KEY);
        if (cached) return JSON.parse(cached);
      } catch {
        // Cache read failed — fall through to live fetch
      }
    }

    // Fetch from proxy
    const models = await this.listModels();

    // Backfill cache (best-effort)
    if (this.kv) {
      try {
        await this.kv.put(MODEL_CACHE_KEY, JSON.stringify(models), {
          expirationTtl: MODEL_CACHE_TTL,
        });
      } catch {
        // Cache write failed — non-critical
      }
    }

    return models;
  }

  /**
   * Check if finish_reason indicates the model wants to call tools.
   * Handles provider variants: "tool_calls" (OpenAI), "tool_call" (singular), "function_call" (legacy).
   * Proxy normalizes to "tool_calls" but we accept variants as a safety net.
   */
  private isToolCallFinishReason(reason: string): boolean {
    return reason === "tool_calls" || reason === "tool_call" || reason === "function_call";
  }

  /**
   * Validate and normalize a tool call from the LLM response.
   * Returns null if the tool call is malformed (logged as warning).
   */
  private validateToolCall(toolCall: ToolCall, turn: number): ToolCall | null {
    if (!toolCall.id) {
      this.log?.warn("Skipping tool call with missing id", { turn, name: toolCall.function?.name });
      return null;
    }

    if (!toolCall.function?.name) {
      this.log?.warn("Skipping tool call with missing function name", { turn, id: toolCall.id });
      return null;
    }

    // Normalize arguments: some providers return an object instead of a JSON string
    let args = toolCall.function.arguments;
    if (typeof args !== "string") {
      try {
        args = JSON.stringify(args);
        this.log?.debug("Normalized tool call arguments from object to string", { turn, name: toolCall.function.name });
      } catch {
        this.log?.warn("Skipping tool call with un-serializable arguments", { turn, name: toolCall.function.name });
        return null;
      }
    }

    return {
      id: toolCall.id,
      type: "function",
      function: { name: toolCall.function.name, arguments: args },
    };
  }

  /**
   * Run a multi-turn agentic loop: send messages, process tool calls,
   * feed results back, repeat until the model stops calling tools.
   */
  async agentLoop(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    toolExecutor: (name: string, args: Record<string, unknown>) => Promise<unknown>,
    options: { model?: string; maxTurns?: number; temperature?: number; maxTokens?: number; onEvent?: (event: SSEEvent) => void | Promise<void> } = {},
  ): Promise<{ messages: ChatMessage[]; finalContent: string }> {
    const maxTurns = options.maxTurns ?? 10;
    const allMessages = [...messages];

    for (let turn = 0; turn < maxTurns; turn++) {
      // Proxy handles model-level fallback chains — no client-side retry needed
      const response = await this.chat({
        model: options.model,
        messages: allMessages,
        tools,
        tool_choice: "auto",
        temperature: options.temperature ?? 0.2,
        max_tokens: options.maxTokens ?? 4096,
      });

      const choice = response.choices[0];
      if (!choice) {
        throw new Error("LLM proxy returned no choices");
      }

      // Add the assistant message (proxy normalizes content:null → "" on input)
      allMessages.push(choice.message);

      // If the model didn't call any tools, we're done
      const hasToolCalls = this.isToolCallFinishReason(choice.finish_reason) && choice.message.tool_calls?.length;
      if (!hasToolCalls) {
        this.log?.debug("Agent loop completed", { turn, totalMessages: allMessages.length });
        return {
          messages: allMessages,
          finalContent: choice.message.content ?? "",
        };
      }

      // Validate and execute each tool call
      const validToolCalls = choice.message.tool_calls
        .map((tc) => this.validateToolCall(tc, turn))
        .filter((tc): tc is ToolCall => tc !== null);

      if (validToolCalls.length === 0) {
        this.log?.warn("All tool calls in turn were malformed, ending loop", { turn });
        return {
          messages: allMessages,
          finalContent: choice.message.content ?? "",
        };
      }

      this.log?.debug("Processing tool calls", {
        turn,
        tools: validToolCalls.map((tc) => tc.function.name),
        messageCount: allMessages.length,
      });

      for (const toolCall of validToolCalls) {
        await options.onEvent?.({
          event: "tool_call",
          data: { name: toolCall.function.name, arguments: toolCall.function.arguments, turn },
        });

        let toolResult: unknown;
        try {
          const args = JSON.parse(toolCall.function.arguments);
          toolResult = await toolExecutor(toolCall.function.name, args);
        } catch (err) {
          toolResult = { error: err instanceof Error ? err.message : String(err) };
        }

        await options.onEvent?.({
          event: "tool_result",
          data: { name: toolCall.function.name, result: toolResult as Record<string, unknown>, turn },
        });

        allMessages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          name: toolCall.function.name,
          content: JSON.stringify(toolResult),
        });
      }
    }

    // If we hit maxTurns, return what we have
    this.log?.warn("Agent loop hit maxTurns", { maxTurns, totalMessages: allMessages.length });
    const lastAssistant = allMessages.filter((m) => m.role === "assistant").pop();
    return {
      messages: allMessages,
      finalContent: lastAssistant?.content ?? "",
    };
  }
}
