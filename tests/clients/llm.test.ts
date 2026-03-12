import { describe, it, expect, vi, beforeEach } from "vitest";
import { LLMClient } from "../../src/clients/llm";
import type { Env } from "../../src/types";

const mockEnv = {
  LLMPROXY_URL: "https://llmproxy.test.local",
  LLMPROXY_API_KEY: "test-api-key",
  LLM_MODEL: "claude-sonnet-4-20250514",
} as unknown as Env;

const defaultHeaders = { get: (k: string) => k === "X-Proxy-Request-ID" ? "abc12345" : null };

function makeChatResponse(content: string | null, toolCalls?: any[], finishReason = "stop") {
  return {
    id: "chatcmpl-1",
    object: "chat.completion",
    created: Date.now(),
    model: "claude-sonnet-4-20250514",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content,
        tool_calls: toolCalls,
      },
      finish_reason: finishReason,
    }],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  };
}

function mockOk(body: unknown) {
  return { ok: true, headers: defaultHeaders, json: () => Promise.resolve(body) };
}

describe("LLMClient", () => {
  let client: LLMClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new LLMClient(mockEnv);
  });

  describe("chat", () => {
    it("should send a chat completion request to LiteLLM", async () => {
      const response = makeChatResponse("Hello, I can help with that.");
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockOk(response)));

      const result = await client.chat({
        messages: [
          { role: "system", content: "You are helpful." },
          { role: "user", content: "What can you do?" },
        ],
      });

      expect(result.choices[0].message.content).toBe("Hello, I can help with that.");
      expect(fetch).toHaveBeenCalledWith(
        "https://llmproxy.test.local/v1/chat/completions",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer test-api-key",
          }),
        }),
      );
    });

    it("should use the configured model by default", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockOk(makeChatResponse("ok"))));

      await client.chat({ messages: [{ role: "user", content: "hi" }] });

      const body = JSON.parse((fetch as any).mock.calls[0][1].body);
      expect(body.model).toBe("claude-sonnet-4-20250514");
    });

    it("should allow overriding the model", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockOk(makeChatResponse("ok"))));

      await client.chat({
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
      });

      const body = JSON.parse((fetch as any).mock.calls[0][1].body);
      expect(body.model).toBe("gpt-4o");
    });

    it("should throw on non-ok responses", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        text: () => Promise.resolve("Rate limited"),
      }));

      await expect(
        client.chat({ messages: [{ role: "user", content: "hi" }] }),
      ).rejects.toThrow("LLM proxy request failed: 429");
    });
  });

  describe("listModels", () => {
    it("should fetch models from the proxy", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          object: "list",
          data: [
            { id: "cognium/claude-sonnet-latest", object: "model", owned_by: "anthropic", supports_tool_calls: true },
            { id: "cognium/deepseek-latest", object: "model", owned_by: "deepseek", supports_tool_calls: true },
            { id: "cognium/gpt-oss-120b", object: "model", owned_by: "cloudflare", supports_tool_calls: false },
          ],
        }),
      }));

      const models = await client.listModels();

      expect(models).toHaveLength(3);
      expect(models[0].id).toBe("cognium/claude-sonnet-latest");
      expect(models[0].supports_tool_calls).toBe(true);
      expect(models[2].supports_tool_calls).toBe(false);
      expect(fetch).toHaveBeenCalledWith(
        "https://llmproxy.test.local/v1/models",
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer test-api-key",
          }),
        }),
      );
    });

    it("should throw on proxy error", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
      }));

      await expect(client.listModels()).rejects.toThrow("Failed to list models: 503");
    });
  });

  describe("getToolCallModel", () => {
    it("should return TOOL_CALL_MODEL override when set and capable", async () => {
      const envWithOverride = {
        ...mockEnv,
        TOOL_CALL_MODEL: "cognium/claude-opus-latest",
        SESSION_CACHE: { get: vi.fn().mockResolvedValue(null), put: vi.fn().mockResolvedValue(undefined) },
      } as unknown as Env;
      const c = new LLMClient(envWithOverride);

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          object: "list",
          data: [
            { id: "cognium/claude-opus-latest", object: "model", supports_tool_calls: true },
            { id: "cognium/gpt-oss-120b", object: "model", supports_tool_calls: false },
          ],
        }),
      }));

      const model = await c.getToolCallModel();
      expect(model).toBe("cognium/claude-opus-latest");
    });

    it("should skip non-capable override and select from capabilities", async () => {
      const envWithBadOverride = {
        ...mockEnv,
        TOOL_CALL_MODEL: "cognium/gpt-oss-120b",
        SESSION_CACHE: { get: vi.fn().mockResolvedValue(null), put: vi.fn().mockResolvedValue(undefined) },
      } as unknown as Env;
      const c = new LLMClient(envWithBadOverride);

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          object: "list",
          data: [
            { id: "cognium/claude-sonnet-latest", object: "model", supports_tool_calls: true },
            { id: "cognium/gpt-oss-120b", object: "model", supports_tool_calls: false },
          ],
        }),
      }));

      const model = await c.getToolCallModel();
      expect(model).not.toBe("cognium/gpt-oss-120b");
      expect(model).toBe("cognium/claude-sonnet-latest");
    });

    it("should fall back to default model when capability lookup fails", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));

      const model = await client.getToolCallModel();
      expect(model).toBe("claude-sonnet-4-20250514"); // LLM_MODEL default
    });

    it("should use KV cache when available", async () => {
      const cached = JSON.stringify([
        { id: "cognium/cached-model", object: "model", supports_tool_calls: true },
      ]);
      const envWithCache = {
        ...mockEnv,
        SESSION_CACHE: { get: vi.fn().mockResolvedValue(cached), put: vi.fn() },
      } as unknown as Env;
      const c = new LLMClient(envWithCache);

      const model = await c.getToolCallModel();
      expect(model).toBe("cognium/cached-model");
      expect(fetch).not.toHaveBeenCalled(); // should not fetch, used cache
    });

    it("should prefer default model if it is tool-capable", async () => {
      const envWithKV = {
        LLMPROXY_URL: "https://llmproxy.test.local",
        LLMPROXY_API_KEY: "test-api-key",
        LLM_MODEL: "cognium/claude-sonnet-latest",
        SESSION_CACHE: { get: vi.fn().mockResolvedValue(null), put: vi.fn().mockResolvedValue(undefined) },
      } as unknown as Env;
      const c = new LLMClient(envWithKV);

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          object: "list",
          data: [
            { id: "cognium/claude-opus-latest", object: "model", supports_tool_calls: true },
            { id: "cognium/claude-sonnet-latest", object: "model", supports_tool_calls: true },
          ],
        }),
      }));

      const model = await c.getToolCallModel();
      expect(model).toBe("cognium/claude-sonnet-latest"); // prefers default
    });
  });

  describe("agentLoop", () => {
    it("should return immediately when no tool calls", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockOk(makeChatResponse("I found the answer."))));

      const result = await client.agentLoop(
        [{ role: "user", content: "What is 2+2?" }],
        [],
        async () => ({}),
      );

      expect(result.finalContent).toBe("I found the answer.");
      expect(result.messages).toHaveLength(2); // user + assistant
    });

    it("should execute tool calls and feed results back", async () => {
      let callIndex = 0;
      vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
        callIndex++;
        if (callIndex === 1) {
          return Promise.resolve(mockOk(makeChatResponse(null, [{
            id: "call-1",
            type: "function",
            function: { name: "findSkill", arguments: '{"query":"lint code"}' },
          }], "tool_calls")));
        }
        return Promise.resolve(mockOk(makeChatResponse("Found a linting skill.")));
      }));

      const toolExecutor = vi.fn().mockResolvedValue({ results: ["lint-tool"] });

      const result = await client.agentLoop(
        [{ role: "user", content: "lint my code" }],
        [{
          type: "function",
          function: {
            name: "findSkill",
            description: "Search for skills",
            parameters: { type: "object", properties: { query: { type: "string" } } },
          },
        }],
        toolExecutor,
      );

      expect(result.finalContent).toBe("Found a linting skill.");
      expect(toolExecutor).toHaveBeenCalledWith("findSkill", { query: "lint code" });
      // user + assistant(tool_calls) + tool(result) + assistant(final)
      expect(result.messages).toHaveLength(4);
    });

    it("should handle multi-turn tool calling", async () => {
      let callIndex = 0;
      vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
        callIndex++;
        if (callIndex === 1) {
          return Promise.resolve(mockOk(makeChatResponse(null, [{
            id: "call-1", type: "function",
            function: { name: "findSkill", arguments: '{"query":"audit"}' },
          }], "tool_calls")));
        }
        if (callIndex === 2) {
          return Promise.resolve(mockOk(makeChatResponse(null, [{
            id: "call-2", type: "function",
            function: { name: "buildPlan", arguments: '{"steps":[]}' },
          }], "tool_calls")));
        }
        return Promise.resolve(mockOk(makeChatResponse("Plan ready.")));
      }));

      const result = await client.agentLoop(
        [{ role: "user", content: "audit" }],
        [],
        async () => ({ ok: true }),
      );

      expect(result.finalContent).toBe("Plan ready.");
      expect(callIndex).toBe(3);
    });

    it("should respect maxTurns limit", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockOk(makeChatResponse(null, [{
        id: "call-x", type: "function",
        function: { name: "findSkill", arguments: '{"query":"x"}' },
      }], "tool_calls"))));

      const result = await client.agentLoop(
        [{ role: "user", content: "loop" }],
        [],
        async () => ({ result: "ok" }),
        { maxTurns: 3 },
      );

      // Should have exactly 3 LLM calls (3 turns)
      expect(fetch).toHaveBeenCalledTimes(3);
    });

    it("should handle tool execution errors gracefully", async () => {
      let callIndex = 0;
      vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
        callIndex++;
        if (callIndex === 1) {
          return Promise.resolve(mockOk(makeChatResponse(null, [{
            id: "call-1", type: "function",
            function: { name: "failingTool", arguments: '{}' },
          }], "tool_calls")));
        }
        return Promise.resolve(mockOk(makeChatResponse("Handled the error.")));
      }));

      const result = await client.agentLoop(
        [{ role: "user", content: "do something" }],
        [],
        async () => { throw new Error("Tool crashed"); },
      );

      expect(result.finalContent).toBe("Handled the error.");
      // The tool result message should contain the error
      const toolMsg = result.messages.find((m) => m.role === "tool");
      expect(toolMsg).toBeDefined();
      expect(toolMsg!.content).toContain("Tool crashed");
    });
  });
});
