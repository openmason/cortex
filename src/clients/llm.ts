import type { Env, SSEEvent } from "../types";

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

  // Cloudflare
  GPT_OSS_120B: "cognium/gpt-oss-120b",
  QWEN_CODER: "cognium/qwen-2.5-coder",
} as const;

export type ModelAlias = (typeof MODELS)[keyof typeof MODELS];

export class LLMClient {
  private baseUrl: string;
  private apiKey: string;
  private model: string;

  constructor(env: Env) {
    this.baseUrl = env.LLMPROXY_URL;
    this.apiKey = env.LLMPROXY_API_KEY;
    this.model = env.LLM_MODEL;
  }

  /**
   * Send a chat completion request to the LLM proxy.
   */
  async chat(request: Omit<ChatCompletionRequest, "model"> & { model?: string }): Promise<ChatCompletionResponse> {
    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        ...request,
        model: request.model ?? this.model,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`LLM proxy request failed: ${res.status} ${text}`);
    }

    return res.json();
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

      // Add the assistant message (coerce null content to empty string for
      // proxy compatibility — some proxies reject null on assistant messages)
      allMessages.push({
        ...choice.message,
        content: choice.message.content ?? "",
      });

      // If the model didn't call any tools, we're done
      if (choice.finish_reason !== "tool_calls" || !choice.message.tool_calls?.length) {
        return {
          messages: allMessages,
          finalContent: choice.message.content ?? "",
        };
      }

      // Execute each tool call and add results
      for (const toolCall of choice.message.tool_calls) {
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
    const lastAssistant = allMessages.filter((m) => m.role === "assistant").pop();
    return {
      messages: allMessages,
      finalContent: lastAssistant?.content ?? "",
    };
  }
}
