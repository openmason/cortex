import type { ChatMessage } from "../clients/llm";
import type { Env, Product } from "../types";
import type { Logger } from "../observability/logger";

// ---------------------------------------------------------------------------
// Conversation State
// ---------------------------------------------------------------------------

export interface TurnMetrics {
  turn: number;
  tokens?: number;
  cost?: number;
  toolCalls?: string[];    // tool names invoked in this turn
  durationMs?: number;
}

export interface ConversationState {
  conversationId: string;
  tenantId: string;
  userId: string;
  product: Product;
  createdAt: string;
  lastActivityAt: string;
  turnCount: number;
  messages: ChatMessage[]; // user + assistant only (no system, no tool)
  turnMetrics?: TurnMetrics[];
}

export interface ConversationConfig {
  ttlSeconds: number;
  maxTurns: number;
  maxHistoryTokenEstimate: number;
}

const DEFAULT_CONFIG: ConversationConfig = {
  ttlSeconds: 86400, // 24 hours
  maxTurns: 50,
  maxHistoryTokenEstimate: 30000,
};

// ---------------------------------------------------------------------------
// Conversation Manager
// ---------------------------------------------------------------------------

export class ConversationManager {
  private kv: KVNamespace;
  private config: ConversationConfig;

  constructor(env: Env, config?: Partial<ConversationConfig>) {
    this.kv = env.SESSION_CACHE;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  generateId(): string {
    return `conv_${crypto.randomUUID()}`;
  }

  private key(tenantId: string, conversationId: string): string {
    return `conversation:${tenantId}:${conversationId}`;
  }

  async load(tenantId: string, conversationId: string): Promise<ConversationState | null> {
    const raw = await this.kv.get(this.key(tenantId, conversationId));
    if (!raw) return null;

    const state: ConversationState = JSON.parse(raw);

    // Defense-in-depth: verify tenantId matches
    if (state.tenantId !== tenantId) {
      return null;
    }

    return state;
  }

  async save(state: ConversationState): Promise<void> {
    state.lastActivityAt = new Date().toISOString();
    try {
      await this.kv.put(
        this.key(state.tenantId, state.conversationId),
        JSON.stringify(state),
        { expirationTtl: this.config.ttlSeconds },
      );
    } catch {
      // KV save is best-effort — don't block the request
    }
  }

  createState(
    conversationId: string,
    tenantId: string,
    userId: string,
    product: Product,
  ): ConversationState {
    const now = new Date().toISOString();
    return {
      conversationId,
      tenantId,
      userId,
      product,
      createdAt: now,
      lastActivityAt: now,
      turnCount: 0,
      messages: [],
    };
  }

  /**
   * Extract persistable messages from the agentLoop result.
   * Filters out system and tool messages. Compresses assistant messages
   * that contained tool calls into a summary annotation.
   */
  extractPersistableMessages(agentMessages: ChatMessage[]): ChatMessage[] {
    const result: ChatMessage[] = [];

    for (const msg of agentMessages) {
      if (msg.role === "system") continue;
      if (msg.role === "tool") continue;

      if (msg.role === "assistant" && msg.tool_calls?.length) {
        const toolNames = msg.tool_calls.map((tc) => tc.function.name);
        result.push({
          role: "assistant",
          content: msg.content
            ? `${msg.content}\n[Used tools: ${toolNames.join(", ")}]`
            : `[Used tools: ${toolNames.join(", ")}]`,
        });
        continue;
      }

      result.push({
        role: msg.role,
        content: msg.content ?? "",
      });
    }

    return result;
  }

  /**
   * Build the messages array for the LLM, incorporating history.
   */
  buildMessagesWithHistory(
    systemPrompt: string,
    currentPrompt: string,
    context: Record<string, unknown> | undefined,
    history: ChatMessage[],
  ): ChatMessage[] {
    // Merge context into system prompt so it shapes agent behavior from the start
    let fullSystemPrompt = systemPrompt;
    if (context && Object.keys(context).length > 0) {
      fullSystemPrompt += `\n\n## Context\n${JSON.stringify(context, null, 2)}`;
    }

    const messages: ChatMessage[] = [
      { role: "system", content: fullSystemPrompt },
    ];

    const trimmedHistory = this.trimHistory(history);
    messages.push(...trimmedHistory);

    messages.push({ role: "user", content: currentPrompt });

    return messages;
  }

  /**
   * Trim history to fit within token budget.
   * Drops oldest message pairs when over budget.
   */
  trimHistory(history: ChatMessage[]): ChatMessage[] {
    if (history.length === 0) return [];

    if (this.estimateTokens(history) <= this.config.maxHistoryTokenEstimate) {
      return history;
    }

    let trimmed = [...history];
    while (
      trimmed.length > 2 &&
      this.estimateTokens(trimmed) > this.config.maxHistoryTokenEstimate
    ) {
      trimmed = trimmed.slice(2);
    }

    if (trimmed.length < history.length) {
      const droppedCount = Math.floor((history.length - trimmed.length) / 2);
      trimmed.unshift({
        role: "system",
        content: `[Earlier conversation context: ${droppedCount} exchange(s) were trimmed for context window management.]`,
      });
    }

    return trimmed;
  }

  /** Rough token estimation: ~4 chars per token */
  estimateTokens(messages: ChatMessage[]): number {
    let chars = 0;
    for (const msg of messages) {
      chars += (msg.content?.length ?? 0) + 10;
    }
    return Math.ceil(chars / 4);
  }
}
