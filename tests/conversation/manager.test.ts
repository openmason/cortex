import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConversationManager, type ConversationState } from "../../src/conversation/manager";
import type { ChatMessage } from "../../src/clients/llm";
import type { Env } from "../../src/types";

function makeMockEnv(): Env {
  const store = new Map<string, string>();
  return {
    SESSION_CACHE: {
      put: vi.fn(async (key: string, value: string, _opts?: unknown) => {
        store.set(key, value);
      }),
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      delete: vi.fn(async (key: string) => { store.delete(key); }),
    } as unknown as KVNamespace,
    WORKFLOW_STATE: {} as KVNamespace,
    HYPERDRIVE: {} as Hyperdrive,
    R2_BUCKET: {} as R2Bucket,
    FORGE_QUEUE: { send: vi.fn() } as unknown as Queue,
    COGNIUM_QUEUE: { send: vi.fn() } as unknown as Queue,
    AI: {} as Ai,
    WORKFLOW_DO: {} as DurableObjectNamespace,
    ENVIRONMENT: "test",
    RUNICS_URL: "https://runics.test",
    COGNIUM_URL: "https://cognium.test",
    DAYTONA_TARGET: "us",
    LLM_MODEL: "test-model",
    DEFAULT_EXECUTION_MODE: "review_before_run",
    DEFAULT_APPETITE: "balanced",
    WORKFLOW_TIMEOUT_MS: "300000",
    MAX_SKILL_CHAIN_DEPTH: "10",
    LLMPROXY_URL: "https://llm.test",
    LLMPROXY_API_KEY: "test-key",
    DAYTONA_API_KEY: "test-key",
    DATABASE_URL: "postgresql://test:test@localhost/test",
    ADMIN_SECRET: "test-secret",
  } as Env;
}

describe("ConversationManager", () => {
  let env: Env;
  let manager: ConversationManager;

  beforeEach(() => {
    vi.clearAllMocks();
    env = makeMockEnv();
    manager = new ConversationManager(env);
  });

  describe("generateId", () => {
    it("should produce conv_ prefixed UUID", () => {
      const id = manager.generateId();
      expect(id).toMatch(/^conv_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it("should produce unique IDs", () => {
      const id1 = manager.generateId();
      const id2 = manager.generateId();
      expect(id1).not.toBe(id2);
    });
  });

  describe("createState", () => {
    it("should create a new conversation state", () => {
      const state = manager.createState("conv_abc", "t1", "u1", "bombastic");
      expect(state.conversationId).toBe("conv_abc");
      expect(state.tenantId).toBe("t1");
      expect(state.userId).toBe("u1");
      expect(state.product).toBe("bombastic");
      expect(state.turnCount).toBe(0);
      expect(state.messages).toEqual([]);
      expect(state.createdAt).toBeDefined();
      expect(state.lastActivityAt).toBeDefined();
    });
  });

  describe("save and load", () => {
    it("should round-trip through KV", async () => {
      const state = manager.createState("conv_abc", "t1", "u1", "bombastic");
      state.messages = [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" },
      ];
      state.turnCount = 1;

      await manager.save(state);
      const loaded = await manager.load("t1", "conv_abc");

      expect(loaded).not.toBeNull();
      expect(loaded!.conversationId).toBe("conv_abc");
      expect(loaded!.messages).toHaveLength(2);
      expect(loaded!.turnCount).toBe(1);
    });

    it("should return null for non-existent conversation", async () => {
      const loaded = await manager.load("t1", "conv_nonexistent");
      expect(loaded).toBeNull();
    });

    it("should return null for wrong tenantId (security)", async () => {
      const state = manager.createState("conv_abc", "t1", "u1", "bombastic");
      await manager.save(state);

      // Try to load with a different tenant
      const loaded = await manager.load("t2", "conv_abc");
      expect(loaded).toBeNull();
    });

    it("should update lastActivityAt on save", async () => {
      const state = manager.createState("conv_abc", "t1", "u1", "bombastic");
      const originalTime = state.lastActivityAt;

      // Small delay to ensure different timestamp
      await new Promise((r) => setTimeout(r, 5));
      await manager.save(state);

      const loaded = await manager.load("t1", "conv_abc");
      expect(loaded!.lastActivityAt).not.toBe(originalTime);
    });

    it("should call KV put with TTL", async () => {
      const state = manager.createState("conv_abc", "t1", "u1", "bombastic");
      await manager.save(state);

      expect(env.SESSION_CACHE.put).toHaveBeenCalledWith(
        "conversation:t1:conv_abc",
        expect.any(String),
        { expirationTtl: 86400 },
      );
    });
  });

  describe("extractPersistableMessages", () => {
    it("should filter out system messages", () => {
      const messages: ChatMessage[] = [
        { role: "system", content: "You are a helpful assistant" },
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ];

      const result = manager.extractPersistableMessages(messages);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ role: "user", content: "hello" });
      expect(result[1]).toEqual({ role: "assistant", content: "hi" });
    });

    it("should filter out tool messages", () => {
      const messages: ChatMessage[] = [
        { role: "user", content: "find a skill" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call-1", type: "function", function: { name: "findSkill", arguments: '{"query":"test"}' } }],
        },
        { role: "tool", content: '{"results":[]}', tool_call_id: "call-1", name: "findSkill" },
        { role: "assistant", content: "I found some results." },
      ];

      const result = manager.extractPersistableMessages(messages);
      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({ role: "user", content: "find a skill" });
      // Tool-calling assistant message is annotated
      expect(result[1].role).toBe("assistant");
      expect(result[1].content).toBe("[Used tools: findSkill]");
      // Final assistant response preserved
      expect(result[2]).toEqual({ role: "assistant", content: "I found some results." });
    });

    it("should annotate tool-calling assistant with existing content", () => {
      const messages: ChatMessage[] = [
        {
          role: "assistant",
          content: "Let me search for that.",
          tool_calls: [{ id: "call-1", type: "function", function: { name: "findSkill", arguments: "{}" } }],
        },
      ];

      const result = manager.extractPersistableMessages(messages);
      expect(result[0].content).toBe("Let me search for that.\n[Used tools: findSkill]");
    });

    it("should handle multiple tool calls in one message", () => {
      const messages: ChatMessage[] = [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call-1", type: "function", function: { name: "findSkill", arguments: "{}" } },
            { id: "call-2", type: "function", function: { name: "buildPlan", arguments: "{}" } },
          ],
        },
      ];

      const result = manager.extractPersistableMessages(messages);
      expect(result[0].content).toBe("[Used tools: findSkill, buildPlan]");
    });

    it("should handle null content in plain assistant messages", () => {
      const messages: ChatMessage[] = [
        { role: "assistant", content: null },
      ];

      const result = manager.extractPersistableMessages(messages);
      expect(result[0]).toEqual({ role: "assistant", content: "" });
    });
  });

  describe("buildMessagesWithHistory", () => {
    it("should build messages with no history", () => {
      const result = manager.buildMessagesWithHistory(
        "System prompt",
        "What can you do?",
        undefined,
        [],
      );

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ role: "system", content: "System prompt" });
      expect(result[1]).toEqual({ role: "user", content: "What can you do?" });
    });

    it("should inject history between system and current message", () => {
      const history: ChatMessage[] = [
        { role: "user", content: "previous question" },
        { role: "assistant", content: "previous answer" },
      ];

      const result = manager.buildMessagesWithHistory(
        "System prompt",
        "follow up",
        undefined,
        history,
      );

      expect(result).toHaveLength(4);
      expect(result[0].role).toBe("system");
      expect(result[1]).toEqual({ role: "user", content: "previous question" });
      expect(result[2]).toEqual({ role: "assistant", content: "previous answer" });
      expect(result[3]).toEqual({ role: "user", content: "follow up" });
    });

    it("should append context after user message", () => {
      const result = manager.buildMessagesWithHistory(
        "System prompt",
        "Do something",
        { key: "value" },
        [],
      );

      expect(result).toHaveLength(3);
      expect(result[2].role).toBe("user");
      expect(result[2].content).toContain("Additional context:");
      expect(result[2].content).toContain('"key": "value"');
    });

    it("should not add context message for empty context", () => {
      const result = manager.buildMessagesWithHistory(
        "System prompt",
        "Do something",
        {},
        [],
      );

      expect(result).toHaveLength(2);
    });
  });

  describe("trimHistory", () => {
    it("should return empty array for empty history", () => {
      expect(manager.trimHistory([])).toEqual([]);
    });

    it("should not trim when under budget", () => {
      const history: ChatMessage[] = [
        { role: "user", content: "short message" },
        { role: "assistant", content: "short reply" },
      ];

      const result = manager.trimHistory(history);
      expect(result).toEqual(history);
    });

    it("should drop oldest pairs when over budget", () => {
      // Create a manager with a very low token budget
      const smallManager = new ConversationManager(env, { maxHistoryTokenEstimate: 20 });

      const history: ChatMessage[] = [
        { role: "user", content: "A".repeat(100) },
        { role: "assistant", content: "B".repeat(100) },
        { role: "user", content: "C".repeat(20) },
        { role: "assistant", content: "D".repeat(20) },
      ];

      const result = smallManager.trimHistory(history);
      // Should have dropped the first pair and added a trim note
      expect(result.length).toBeLessThan(history.length + 1); // +1 for possible trim note
      // The first message should be the synthetic trim note
      expect(result[0].role).toBe("system");
      expect(result[0].content).toContain("trimmed");
    });

    it("should add synthetic trim note when messages are dropped", () => {
      const smallManager = new ConversationManager(env, { maxHistoryTokenEstimate: 10 });

      const history: ChatMessage[] = [
        { role: "user", content: "A".repeat(200) },
        { role: "assistant", content: "B".repeat(200) },
        { role: "user", content: "short" },
        { role: "assistant", content: "short" },
      ];

      const result = smallManager.trimHistory(history);
      expect(result[0].role).toBe("system");
      expect(result[0].content).toContain("exchange(s) were trimmed");
    });
  });

  describe("estimateTokens", () => {
    it("should estimate roughly 4 chars per token", () => {
      const messages: ChatMessage[] = [
        { role: "user", content: "A".repeat(400) }, // ~400 chars + 10 overhead = 410/4 ≈ 103
      ];
      const estimate = manager.estimateTokens(messages);
      expect(estimate).toBeGreaterThan(90);
      expect(estimate).toBeLessThan(120);
    });

    it("should handle null content", () => {
      const messages: ChatMessage[] = [{ role: "assistant", content: null }];
      const estimate = manager.estimateTokens(messages);
      expect(estimate).toBeGreaterThan(0); // overhead
    });
  });
});
