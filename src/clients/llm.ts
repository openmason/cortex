import type { Env, OnStreamEvent } from "../types";
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
// Streaming — OpenAI-compatible SSE chunk format
// ---------------------------------------------------------------------------

export interface ChatCompletionChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    index: number;
    delta: {
      role?: string;
      content?: string | null;
      tool_calls?: ToolCallDelta[];
    };
    finish_reason: string | null;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cost?: number;
  } | null;
}

export interface ToolCallDelta {
  index: number;
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
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

export interface AgentLoopTurnUsage {
  turn: number;
  tokens: number;
  cost?: number;
  toolCalls: string[];
}

export interface AgentLoopUsage {
  totalTokens: number;
  totalCost: number;
  turns: AgentLoopTurnUsage[];
}

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

    // Sanitize messages for Workers AI compatibility:
    // - Normalize content:null → "" (Workers AI rejects null content)
    const sanitizedMessages = request.messages.map((msg) => ({
      ...msg,
      content: msg.content ?? "",
    }));

    // Build request body, omitting tool_choice:"auto" (Workers AI doesn't support it;
    // models default to auto behavior when tools are present but tool_choice is absent)
    const body: Record<string, unknown> = {
      model,
      messages: sanitizedMessages,
      temperature: request.temperature,
      max_tokens: request.max_tokens,
    };
    if (request.tools?.length) {
      body.tools = request.tools;
    }
    if (request.tool_choice && request.tool_choice !== "auto") {
      body.tool_choice = request.tool_choice;
    }

    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
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
   * Send a streaming chat completion request to the LLM proxy.
   * Yields ChatCompletionChunk objects as they arrive via SSE.
   */
  async *chatStream(
    request: Omit<ChatCompletionRequest, "model"> & { model?: string },
  ): AsyncGenerator<ChatCompletionChunk> {
    const model = request.model ?? this.model;
    const start = Date.now();

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    };
    const requestId = this.log?.getContext().requestId;
    if (requestId) headers["X-Request-ID"] = requestId;

    const sanitizedMessages = request.messages.map((msg) => ({
      ...msg,
      content: msg.content ?? "",
    }));

    const body: Record<string, unknown> = {
      model,
      messages: sanitizedMessages,
      temperature: request.temperature,
      max_tokens: request.max_tokens,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (request.tools?.length) {
      body.tools = request.tools;
    }
    if (request.tool_choice && request.tool_choice !== "auto") {
      body.tool_choice = request.tool_choice;
    }

    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      const durationMs = Date.now() - start;
      this.log?.warn("LLM streaming chat failed", { model, status: res.status, durationMs });
      this.metrics?.write("llm_call", { status: "error", durationMs, error: `${res.status}` });
      throw new Error(`LLM proxy request failed: ${res.status} ${text}`);
    }

    if (!res.body) {
      throw new Error("LLM proxy returned no response body for streaming request");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete lines
        while (true) {
          const lineEnd = buffer.indexOf("\n");
          if (lineEnd === -1) break;

          const line = buffer.slice(0, lineEnd).trim();
          buffer = buffer.slice(lineEnd + 1);

          if (!line || line.startsWith(":")) continue;
          if (line === "data: [DONE]") {
            const durationMs = Date.now() - start;
            this.log?.debug("LLM streaming completed", { model, durationMs });
            this.metrics?.write("llm_call", { status: "ok", durationMs, streaming: true });
            return;
          }
          if (!line.startsWith("data: ")) continue;

          try {
            const chunk: ChatCompletionChunk = JSON.parse(line.slice(6));
            yield chunk;
          } catch {
            this.log?.debug("Skipping unparseable SSE chunk", { line });
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    const durationMs = Date.now() - start;
    this.log?.debug("LLM streaming completed (stream ended)", { model, durationMs });
    this.metrics?.write("llm_call", { status: "ok", durationMs, streaming: true });
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
   * Check if any tool-capable model is available from the proxy.
   * Returns true if at least one model has supports_tool_calls === true.
   */
  async hasToolCapableModel(): Promise<boolean> {
    try {
      const models = await this.getCachedModels();
      return models.some((m) => m.supports_tool_calls === true);
    } catch {
      return false;
    }
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
      if (capable.length === 0) {
        // No capable models known — trust override if set, otherwise fall back
        // but never return a model explicitly marked as non-tool-capable
        if (override) return override;
        const defaultModel = models.find((m) => m.id === this.model);
        if (defaultModel?.supports_tool_calls === false) {
          this.log?.warn("Default model is not tool-capable and no override set", { model: this.model });
        }
        return this.model;
      }

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
    options: { model?: string; maxTurns?: number; temperature?: number; maxTokens?: number; onEvent?: OnStreamEvent } = {},
  ): Promise<{ messages: ChatMessage[]; finalContent: string; usage: AgentLoopUsage }> {
    const maxTurns = options.maxTurns ?? 10;
    const allMessages = [...messages];
    const usage: AgentLoopUsage = { totalTokens: 0, totalCost: 0, turns: [] };

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

      // Track usage for this turn
      const turnTokens = response.usage?.total_tokens ?? 0;
      const turnCost = response.usage?.cost;
      usage.totalTokens += turnTokens;
      if (turnCost) usage.totalCost += turnCost;

      // Add the assistant message (proxy normalizes content:null → "" on input)
      allMessages.push(choice.message);

      // If the model didn't call any tools, we're done
      const hasToolCalls = this.isToolCallFinishReason(choice.finish_reason) && choice.message.tool_calls?.length;
      if (!hasToolCalls) {
        usage.turns.push({ turn, tokens: turnTokens, cost: turnCost, toolCalls: [] });
        this.log?.debug("Agent loop completed", { turn, totalMessages: allMessages.length });
        return { messages: allMessages, finalContent: choice.message.content ?? "", usage };
      }

      // Validate and execute each tool call
      const validToolCalls = choice.message.tool_calls
        .map((tc) => this.validateToolCall(tc, turn))
        .filter((tc): tc is ToolCall => tc !== null);

      if (validToolCalls.length === 0) {
        usage.turns.push({ turn, tokens: turnTokens, cost: turnCost, toolCalls: [] });
        this.log?.warn("All tool calls in turn were malformed, ending loop", { turn });
        return { messages: allMessages, finalContent: choice.message.content ?? "", usage };
      }

      const toolCallNames = validToolCalls.map((tc) => tc.function.name);
      usage.turns.push({ turn, tokens: turnTokens, cost: turnCost, toolCalls: toolCallNames });

      this.log?.debug("Processing tool calls", {
        turn,
        tools: toolCallNames,
        messageCount: allMessages.length,
      });

      for (let i = 0; i < validToolCalls.length; i++) {
        const toolCall = validToolCalls[i];
        const toolCallId = toolCall.id || `tc_${turn}_${i}`;

        let parsedArgs: Record<string, unknown> = {};
        try {
          parsedArgs = JSON.parse(toolCall.function.arguments);
        } catch {
          // keep empty args
        }

        await options.onEvent?.({
          type: "tool-call",
          toolCallId,
          toolName: toolCall.function.name,
          args: parsedArgs,
        });

        let toolResult: unknown;
        try {
          toolResult = await toolExecutor(toolCall.function.name, parsedArgs);
        } catch (err) {
          toolResult = { error: err instanceof Error ? err.message : String(err) };
        }

        await options.onEvent?.({
          type: "tool-result",
          toolCallId,
          result: toolResult,
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
    return { messages: allMessages, finalContent: lastAssistant?.content ?? "", usage };
  }

  /**
   * Event-emitting variant of agentLoop: uses non-streaming chat() internally
   * (because LLM proxy providers don't reliably stream tool_calls deltas) but
   * emits text-start/text-delta/text-end and tool-call/tool-result events so
   * clients receive the AI SDK stream event protocol.
   *
   * Same signature and return type as agentLoop().
   */
  async agentLoopStreaming(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    toolExecutor: (name: string, args: Record<string, unknown>) => Promise<unknown>,
    options: { model?: string; maxTurns?: number; temperature?: number; maxTokens?: number; onEvent?: OnStreamEvent } = {},
  ): Promise<{ messages: ChatMessage[]; finalContent: string; usage: AgentLoopUsage }> {
    // Uses non-streaming chat() internally because many LLM proxy providers
    // (Workers AI, OpenRouter) don't reliably stream tool_calls deltas.
    // Text content is emitted as text-start/text-delta/text-end events after
    // each turn completes so the client still gets the streaming event protocol.
    const maxTurns = options.maxTurns ?? 10;
    const allMessages = [...messages];
    const usage: AgentLoopUsage = { totalTokens: 0, totalCost: 0, turns: [] };

    for (let turn = 0; turn < maxTurns; turn++) {
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

      // Track usage for this turn
      const turnTokens = response.usage?.total_tokens ?? 0;
      const turnCost = response.usage?.cost;
      usage.totalTokens += turnTokens;
      if (turnCost) usage.totalCost += turnCost;

      // Emit text content as stream events
      const content = choice.message.content ?? "";
      if (content) {
        const textId = `text_${turn}_${crypto.randomUUID().slice(0, 8)}`;
        await options.onEvent?.({ type: "text-start", id: textId });
        await options.onEvent?.({ type: "text-delta", id: textId, delta: content });
        await options.onEvent?.({ type: "text-end", id: textId });
      }

      // Add the assistant message
      allMessages.push(choice.message);

      // If no tool calls, we're done
      const hasToolCalls = this.isToolCallFinishReason(choice.finish_reason) && choice.message.tool_calls?.length;
      if (!hasToolCalls) {
        usage.turns.push({ turn, tokens: turnTokens, cost: turnCost, toolCalls: [] });
        this.log?.debug("Streaming agent loop completed", { turn, totalMessages: allMessages.length });
        return { messages: allMessages, finalContent: content, usage };
      }

      // Validate tool calls
      const validToolCalls = choice.message.tool_calls!
        .map((tc) => this.validateToolCall(tc, turn))
        .filter((tc): tc is ToolCall => tc !== null);

      if (validToolCalls.length === 0) {
        usage.turns.push({ turn, tokens: turnTokens, cost: turnCost, toolCalls: [] });
        this.log?.warn("All tool calls in turn were malformed, ending loop", { turn });
        return { messages: allMessages, finalContent: content, usage };
      }

      const toolCallNames = validToolCalls.map((tc) => tc.function.name);
      usage.turns.push({ turn, tokens: turnTokens, cost: turnCost, toolCalls: toolCallNames });

      this.log?.debug("Processing tool calls (streaming)", {
        turn,
        tools: toolCallNames,
        messageCount: allMessages.length,
      });

      for (let i = 0; i < validToolCalls.length; i++) {
        const toolCall = validToolCalls[i];
        const toolCallId = toolCall.id || `tc_${turn}_${i}`;

        let parsedArgs: Record<string, unknown> = {};
        try {
          parsedArgs = JSON.parse(toolCall.function.arguments);
        } catch {
          // keep empty args
        }

        await options.onEvent?.({
          type: "tool-call",
          toolCallId,
          toolName: toolCall.function.name,
          args: parsedArgs,
        });

        let toolResult: unknown;
        try {
          toolResult = await toolExecutor(toolCall.function.name, parsedArgs);
        } catch (err) {
          toolResult = { error: err instanceof Error ? err.message : String(err) };
        }

        await options.onEvent?.({
          type: "tool-result",
          toolCallId,
          result: toolResult,
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
    this.log?.warn("Streaming agent loop hit maxTurns", { maxTurns, totalMessages: allMessages.length });
    const lastAssistant = allMessages.filter((m) => m.role === "assistant").pop();
    return { messages: allMessages, finalContent: lastAssistant?.content ?? "", usage };
  }
}
