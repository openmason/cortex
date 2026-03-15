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

    it("should accept 'tool_call' (singular) finish_reason as safety net", async () => {
      let callIndex = 0;
      vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
        callIndex++;
        if (callIndex === 1) {
          return Promise.resolve(mockOk(makeChatResponse(null, [{
            id: "call-1", type: "function",
            function: { name: "findSkill", arguments: '{"query":"test"}' },
          }], "tool_call"))); // singular — some providers do this
        }
        return Promise.resolve(mockOk(makeChatResponse("Done.")));
      }));

      const result = await client.agentLoop(
        [{ role: "user", content: "test" }],
        [],
        async () => ({ ok: true }),
      );

      expect(result.finalContent).toBe("Done.");
      expect(callIndex).toBe(2); // processed the tool call despite singular finish_reason
    });

    it("should accept 'function_call' finish_reason as safety net", async () => {
      let callIndex = 0;
      vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
        callIndex++;
        if (callIndex === 1) {
          return Promise.resolve(mockOk(makeChatResponse(null, [{
            id: "call-1", type: "function",
            function: { name: "findSkill", arguments: '{"query":"test"}' },
          }], "function_call"))); // legacy format
        }
        return Promise.resolve(mockOk(makeChatResponse("Done.")));
      }));

      const result = await client.agentLoop(
        [{ role: "user", content: "test" }],
        [],
        async () => ({ ok: true }),
      );

      expect(result.finalContent).toBe("Done.");
      expect(callIndex).toBe(2);
    });

    it("should skip tool calls with missing id", async () => {
      let callIndex = 0;
      vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
        callIndex++;
        if (callIndex === 1) {
          return Promise.resolve(mockOk(makeChatResponse(null, [
            { id: "", type: "function", function: { name: "badTool", arguments: '{}' } }, // empty id
            { id: "call-good", type: "function", function: { name: "goodTool", arguments: '{}' } },
          ], "tool_calls")));
        }
        return Promise.resolve(mockOk(makeChatResponse("Done.")));
      }));

      const executor = vi.fn().mockResolvedValue({ ok: true });
      await client.agentLoop(
        [{ role: "user", content: "test" }],
        [],
        executor,
      );

      // Only goodTool should have been executed (badTool skipped due to empty id)
      expect(executor).toHaveBeenCalledTimes(1);
      expect(executor).toHaveBeenCalledWith("goodTool", {});
    });

    it("should skip tool calls with missing function name", async () => {
      let callIndex = 0;
      vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
        callIndex++;
        if (callIndex === 1) {
          return Promise.resolve(mockOk(makeChatResponse(null, [
            { id: "call-1", type: "function", function: { name: "", arguments: '{}' } }, // empty name
            { id: "call-2", type: "function", function: { name: "goodTool", arguments: '{}' } },
          ], "tool_calls")));
        }
        return Promise.resolve(mockOk(makeChatResponse("Done.")));
      }));

      const executor = vi.fn().mockResolvedValue({ ok: true });
      await client.agentLoop(
        [{ role: "user", content: "test" }],
        [],
        executor,
      );

      expect(executor).toHaveBeenCalledTimes(1);
      expect(executor).toHaveBeenCalledWith("goodTool", {});
    });

    it("should normalize arguments from object to JSON string", async () => {
      let callIndex = 0;
      vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
        callIndex++;
        if (callIndex === 1) {
          return Promise.resolve(mockOk(makeChatResponse(null, [{
            id: "call-1", type: "function",
            function: { name: "findSkill", arguments: { query: "test" } as any }, // object instead of string
          }], "tool_calls")));
        }
        return Promise.resolve(mockOk(makeChatResponse("Done.")));
      }));

      const executor = vi.fn().mockResolvedValue({ ok: true });
      await client.agentLoop(
        [{ role: "user", content: "test" }],
        [],
        executor,
      );

      expect(executor).toHaveBeenCalledWith("findSkill", { query: "test" });
    });

    it("should end loop when all tool calls in a turn are malformed", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockOk(makeChatResponse("fallback content", [{
        id: "", type: "function", function: { name: "", arguments: '{}' }, // both invalid
      }], "tool_calls"))));

      const executor = vi.fn();
      const result = await client.agentLoop(
        [{ role: "user", content: "test" }],
        [],
        executor,
      );

      expect(executor).not.toHaveBeenCalled();
      expect(result.finalContent).toBe("fallback content");
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

  // -------------------------------------------------------------------------
  // Streaming helpers
  // -------------------------------------------------------------------------

  function makeChunkSSE(
    content?: string | null,
    toolCalls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>,
    finishReason?: string | null,
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number; cost?: number },
  ): string {
    const chunk = {
      id: "chatcmpl-stream-1",
      object: "chat.completion.chunk",
      created: Date.now(),
      model: "claude-sonnet-4-20250514",
      choices: [{
        index: 0,
        delta: {
          ...(content !== undefined ? { content } : {}),
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReason ?? null,
      }],
      ...(usage ? { usage } : {}),
    };
    return `data: ${JSON.stringify(chunk)}`;
  }

  function makeStreamResponse(...sseLines: string[]): { ok: true; body: ReadableStream; headers: typeof defaultHeaders } {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (const line of sseLines) {
          controller.enqueue(encoder.encode(line + "\n\n"));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return { ok: true, body: stream, headers: defaultHeaders };
  }

  describe("chatStream", () => {
    it("should yield chunks from streaming response", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
        makeStreamResponse(
          makeChunkSSE("Hello"),
          makeChunkSSE(" world"),
          makeChunkSSE(null, undefined, "stop", { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }),
        ),
      ));

      const chunks = [];
      for await (const chunk of client.chatStream({
        messages: [{ role: "user", content: "hi" }],
      })) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(3);
      expect(chunks[0].choices[0].delta.content).toBe("Hello");
      expect(chunks[1].choices[0].delta.content).toBe(" world");
      expect(chunks[2].choices[0].finish_reason).toBe("stop");
      expect(chunks[2].usage?.total_tokens).toBe(15);
    });

    it("should handle [DONE] sentinel", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
        makeStreamResponse(makeChunkSSE("hi")),
      ));

      const chunks = [];
      for await (const chunk of client.chatStream({
        messages: [{ role: "user", content: "hi" }],
      })) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(1);
    });

    it("should throw on non-ok response", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        text: () => Promise.resolve("Rate limited"),
      }));

      const chunks = [];
      await expect(async () => {
        for await (const chunk of client.chatStream({
          messages: [{ role: "user", content: "hi" }],
        })) {
          chunks.push(chunk);
        }
      }).rejects.toThrow("LLM proxy request failed: 429");
    });

    it("should include stream:true in request body", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
        makeStreamResponse(makeChunkSSE("ok", undefined, "stop")),
      ));

      const chunks = [];
      for await (const chunk of client.chatStream({
        messages: [{ role: "user", content: "hi" }],
      })) {
        chunks.push(chunk);
      }

      const body = JSON.parse((fetch as any).mock.calls[0][1].body);
      expect(body.stream).toBe(true);
      expect(body.stream_options).toEqual({ include_usage: true });
    });

    it("should yield tool call deltas", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
        makeStreamResponse(
          makeChunkSSE(undefined, [{ index: 0, id: "call-1", function: { name: "findSkill", arguments: '{"qu' } }]),
          makeChunkSSE(undefined, [{ index: 0, function: { arguments: 'ery":"test"}' } }]),
          makeChunkSSE(null, undefined, "tool_calls"),
        ),
      ));

      const chunks = [];
      for await (const chunk of client.chatStream({
        messages: [{ role: "user", content: "test" }],
      })) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(3);
      expect(chunks[0].choices[0].delta.tool_calls?.[0].id).toBe("call-1");
      expect(chunks[0].choices[0].delta.tool_calls?.[0].function?.name).toBe("findSkill");
      expect(chunks[1].choices[0].delta.tool_calls?.[0].function?.arguments).toBe('ery":"test"}');
    });
  });

  describe("agentLoopStreaming", () => {
    it("should stream text deltas via onEvent", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
        makeStreamResponse(
          makeChunkSSE("Hello"),
          makeChunkSSE(", "),
          makeChunkSSE("world!"),
          makeChunkSSE(null, undefined, "stop", { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }),
        ),
      ));

      const events: any[] = [];
      const result = await client.agentLoopStreaming(
        [{ role: "user", content: "hi" }],
        [],
        async () => ({}),
        { onEvent: (e) => { events.push(e); } },
      );

      expect(result.finalContent).toBe("Hello, world!");

      const textStart = events.find((e) => e.type === "text-start");
      const textDeltas = events.filter((e) => e.type === "text-delta");
      const textEnd = events.find((e) => e.type === "text-end");

      expect(textStart).toBeDefined();
      expect(textDeltas).toHaveLength(3);
      expect(textDeltas[0].delta).toBe("Hello");
      expect(textDeltas[1].delta).toBe(", ");
      expect(textDeltas[2].delta).toBe("world!");
      expect(textEnd).toBeDefined();
      expect(textStart.id).toBe(textEnd.id);
    });

    it("should accumulate tool call deltas and execute them", async () => {
      let callIndex = 0;
      vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
        callIndex++;
        if (callIndex === 1) {
          // First turn: tool call streamed in chunks
          return Promise.resolve(makeStreamResponse(
            makeChunkSSE(undefined, [{ index: 0, id: "call-1", function: { name: "findSkill", arguments: '{"qu' } }]),
            makeChunkSSE(undefined, [{ index: 0, function: { arguments: 'ery":"lint"}' } }]),
            makeChunkSSE(null, undefined, "tool_calls", { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 }),
          ));
        }
        // Second turn: text response
        return Promise.resolve(makeStreamResponse(
          makeChunkSSE("Found a linting skill."),
          makeChunkSSE(null, undefined, "stop", { prompt_tokens: 80, completion_tokens: 10, total_tokens: 90 }),
        ));
      }));

      const toolExecutor = vi.fn().mockResolvedValue({ results: ["lint-tool"] });
      const events: any[] = [];

      const result = await client.agentLoopStreaming(
        [{ role: "user", content: "lint my code" }],
        [],
        toolExecutor,
        { onEvent: (e) => { events.push(e); } },
      );

      expect(result.finalContent).toBe("Found a linting skill.");
      expect(toolExecutor).toHaveBeenCalledWith("findSkill", { query: "lint" });

      // Should have tool-call and tool-result events
      const toolCall = events.find((e) => e.type === "tool-call");
      const toolResult = events.find((e) => e.type === "tool-result");
      expect(toolCall).toBeDefined();
      expect(toolCall.toolName).toBe("findSkill");
      expect(toolResult).toBeDefined();

      // Should have text-delta events from second turn
      const textDeltas = events.filter((e) => e.type === "text-delta");
      expect(textDeltas).toHaveLength(1);
      expect(textDeltas[0].delta).toBe("Found a linting skill.");
    });

    it("should respect maxTurns in streaming mode", async () => {
      vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
        return Promise.resolve(makeStreamResponse(
          makeChunkSSE(undefined, [{ index: 0, id: "call-x", function: { name: "findSkill", arguments: '{"query":"x"}' } }]),
          makeChunkSSE(null, undefined, "tool_calls", { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }),
        ));
      }));

      await client.agentLoopStreaming(
        [{ role: "user", content: "loop" }],
        [],
        async () => ({ result: "ok" }),
        { maxTurns: 3 },
      );

      expect(fetch).toHaveBeenCalledTimes(3);
    });

    it("should return same shape as agentLoop()", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
        makeStreamResponse(
          makeChunkSSE("Answer"),
          makeChunkSSE(null, undefined, "stop", { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.01 }),
        ),
      ));

      const result = await client.agentLoopStreaming(
        [{ role: "user", content: "test" }],
        [],
        async () => ({}),
      );

      expect(result).toHaveProperty("messages");
      expect(result).toHaveProperty("finalContent");
      expect(result).toHaveProperty("usage");
      expect(result.usage).toHaveProperty("totalTokens");
      expect(result.usage).toHaveProperty("totalCost");
      expect(result.usage).toHaveProperty("turns");
      expect(result.usage.totalTokens).toBe(15);
      expect(result.usage.totalCost).toBe(0.01);
    });

    it("should handle content and tool calls in the same turn", async () => {
      let callIndex = 0;
      vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
        callIndex++;
        if (callIndex === 1) {
          // Some models emit text before tool calls
          return Promise.resolve(makeStreamResponse(
            makeChunkSSE("Let me search for that..."),
            makeChunkSSE(undefined, [{ index: 0, id: "call-1", function: { name: "findSkill", arguments: '{"query":"test"}' } }]),
            makeChunkSSE(null, undefined, "tool_calls", { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 }),
          ));
        }
        return Promise.resolve(makeStreamResponse(
          makeChunkSSE("Found it!"),
          makeChunkSSE(null, undefined, "stop", { prompt_tokens: 80, completion_tokens: 10, total_tokens: 90 }),
        ));
      }));

      const events: any[] = [];
      const result = await client.agentLoopStreaming(
        [{ role: "user", content: "test" }],
        [],
        async () => ({ ok: true }),
        { onEvent: (e) => { events.push(e); } },
      );

      // Text from first turn should have been streamed
      const firstTextDelta = events.find((e) => e.type === "text-delta" && e.delta === "Let me search for that...");
      expect(firstTextDelta).toBeDefined();

      // Tool call should have been executed
      const toolCall = events.find((e) => e.type === "tool-call");
      expect(toolCall).toBeDefined();

      // Final answer from second turn
      expect(result.finalContent).toBe("Found it!");
    });
  });
});
