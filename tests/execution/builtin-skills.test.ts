import { describe, it, expect } from "vitest";
import { BUILTIN_SKILLS } from "../../src/execution/builtin-skills";

describe("BUILTIN_SKILLS registry", () => {
  it("should export all 16 skills", () => {
    expect(Object.keys(BUILTIN_SKILLS)).toHaveLength(16);
  });

  it("should have all expected slugs", () => {
    const expected = [
      "mr-complexity-scorer", "emotion-state",
      "json-formatter", "regex-tester", "base64-codec", "hash-generator", "jwt-decoder",
      "text-summarizer", "keyword-extractor", "markdown-to-text", "slug-generator",
      "csv-to-json", "json-schema-validator", "data-masker", "uuid-generator", "date-formatter",
    ];
    for (const slug of expected) {
      expect(BUILTIN_SKILLS[slug], `missing skill: ${slug}`).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Existing skills
// ---------------------------------------------------------------------------

describe("mr-complexity-scorer", () => {
  const skill = BUILTIN_SKILLS["mr-complexity-scorer"];

  it("should return error when no code provided", async () => {
    const res = await skill({}) as any;
    expect(res.error).toBeDefined();
  });

  it("should score simple code as low complexity", async () => {
    const res = await skill({ code: "const x = 1;\nconst y = 2;\n" }) as any;
    expect(res.complexity).toBe("low");
    expect(res.complexityScore).toBeTypeOf("number");
    expect(res.stats.totalLines).toBe(3);
  });

  it("should detect TODO markers", async () => {
    const res = await skill({ code: "// TODO: fix this\nconst x = 1;" }) as any;
    expect(res.issues.some((i: any) => i.message.includes("TODO"))).toBe(true);
  });

  it("should detect hardcoded secrets", async () => {
    const res = await skill({ code: 'const password = "hunter2";' }) as any;
    expect(res.issues.some((i: any) => i.severity === "critical")).toBe(true);
  });

  it("should detect debug statements", async () => {
    const res = await skill({ code: "console.log('debug');" }) as any;
    expect(res.issues.some((i: any) => i.message.includes("Debug"))).toBe(true);
  });
});

describe("emotion-state", () => {
  const skill = BUILTIN_SKILLS["emotion-state"];

  it("should return error when no text provided", async () => {
    const res = await skill({}) as any;
    expect(res.error).toBeDefined();
  });

  it("should detect positive sentiment", async () => {
    const res = await skill({ text: "I love this amazing product, it is excellent and wonderful" }) as any;
    expect(res.sentiment).toBe("positive");
    expect(res.score).toBeGreaterThan(0.6);
    expect(res.positiveSignals.length).toBeGreaterThan(0);
  });

  it("should detect negative sentiment", async () => {
    const res = await skill({ text: "This is terrible and horrible, the worst product ever" }) as any;
    expect(res.sentiment).toBe("negative");
    expect(res.score).toBeLessThan(0.4);
    expect(res.negativeSignals.length).toBeGreaterThan(0);
  });

  it("should detect neutral sentiment", async () => {
    const res = await skill({ text: "The sky is blue and water is wet" }) as any;
    expect(res.sentiment).toBe("neutral");
    expect(res.score).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// Developer Tools
// ---------------------------------------------------------------------------

describe("json-formatter", () => {
  const skill = BUILTIN_SKILLS["json-formatter"];

  it("should return error when no input", async () => {
    const res = await skill({}) as any;
    expect(res.error).toBeDefined();
  });

  it("should format valid JSON", async () => {
    const res = await skill({ json: '{"a":1,"b":[2,3]}' }) as any;
    expect(res.valid).toBe(true);
    expect(res.formatted).toContain("\n");
    expect(res.type).toBe("object");
    expect(res.topLevelKeys).toEqual(["a", "b"]);
  });

  it("should detect arrays", async () => {
    const res = await skill({ json: "[1,2,3]" }) as any;
    expect(res.valid).toBe(true);
    expect(res.type).toBe("array");
    expect(res.length).toBe(3);
  });

  it("should handle invalid JSON", async () => {
    const res = await skill({ json: "{bad json" }) as any;
    expect(res.valid).toBe(false);
    expect(res.error).toBeDefined();
  });

  it("should respect custom indent", async () => {
    const res = await skill({ json: '{"a":1}', indent: 4 }) as any;
    expect(res.formatted).toContain("    ");
  });
});

describe("regex-tester", () => {
  const skill = BUILTIN_SKILLS["regex-tester"];

  it("should return error when no pattern", async () => {
    const res = await skill({ text: "hello" }) as any;
    expect(res.error).toContain("No pattern");
  });

  it("should return error when no text", async () => {
    const res = await skill({ pattern: "\\d+" }) as any;
    expect(res.error).toContain("No text");
  });

  it("should find global matches", async () => {
    const res = await skill({ pattern: "\\d+", text: "abc 123 def 456" }) as any;
    expect(res.matchCount).toBe(2);
    expect(res.hasMatch).toBe(true);
    expect(res.matches[0].match).toBe("123");
    expect(res.matches[1].match).toBe("456");
  });

  it("should support named groups", async () => {
    const res = await skill({
      pattern: "(?<year>\\d{4})-(?<month>\\d{2})",
      text: "date: 2025-03",
      flags: "g",
    }) as any;
    expect(res.matches[0].groups?.year).toBe("2025");
    expect(res.matches[0].groups?.month).toBe("03");
  });

  it("should handle invalid regex", async () => {
    const res = await skill({ pattern: "[invalid", text: "test" }) as any;
    expect(res.error).toContain("Invalid regex");
  });

  it("should handle non-global flag", async () => {
    // flags defaults to "g" when empty, so pass "i" (no global) to test single match
    const res = await skill({ pattern: "\\d+", text: "1 2 3", flags: "i" }) as any;
    expect(res.matchCount).toBe(1);
  });
});

describe("base64-codec", () => {
  const skill = BUILTIN_SKILLS["base64-codec"];

  it("should return error when no text", async () => {
    const res = await skill({}) as any;
    expect(res.error).toBeDefined();
  });

  it("should encode text to base64", async () => {
    const res = await skill({ text: "Hello, World!" }) as any;
    expect(res.result).toBe(btoa("Hello, World!"));
    expect(res.operation).toBe("encode");
  });

  it("should decode base64 to text", async () => {
    const encoded = btoa("Hello, World!");
    const res = await skill({ text: encoded, operation: "decode" }) as any;
    expect(res.result).toBe("Hello, World!");
    expect(res.operation).toBe("decode");
  });

  it("should handle invalid base64 on decode", async () => {
    const res = await skill({ text: "!!!not-base64!!!", operation: "decode" }) as any;
    expect(res.error).toBeDefined();
  });
});

describe("hash-generator", () => {
  const skill = BUILTIN_SKILLS["hash-generator"];

  it("should return error when no text", async () => {
    const res = await skill({}) as any;
    expect(res.error).toBeDefined();
  });

  it("should generate SHA-256 hash by default", async () => {
    const res = await skill({ text: "hello" }) as any;
    expect(res.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(res.algorithm).toBe("SHA-256");
  });

  it("should generate SHA-512 hash", async () => {
    const res = await skill({ text: "hello", algorithm: "SHA-512" }) as any;
    expect(res.hash).toMatch(/^[0-9a-f]{128}$/);
    expect(res.algorithm).toBe("SHA-512");
  });

  it("should reject unsupported algorithm", async () => {
    const res = await skill({ text: "hello", algorithm: "MD5" }) as any;
    expect(res.error).toContain("Unsupported algorithm");
  });

  it("should produce consistent hashes", async () => {
    const res1 = await skill({ text: "test" }) as any;
    const res2 = await skill({ text: "test" }) as any;
    expect(res1.hash).toBe(res2.hash);
  });
});

describe("jwt-decoder", () => {
  const skill = BUILTIN_SKILLS["jwt-decoder"];

  // A valid JWT (HS256, payload: {sub:"1234567890",name:"John",iat:1516239022,exp:9999999999})
  const validJwt = [
    btoa(JSON.stringify({ alg: "HS256", typ: "JWT" })),
    btoa(JSON.stringify({ sub: "1234567890", name: "John", iat: 1516239022, exp: 9999999999 })),
    "signature",
  ].join(".");

  it("should return error when no token", async () => {
    const res = await skill({}) as any;
    expect(res.error).toBeDefined();
  });

  it("should reject non-3-part tokens", async () => {
    const res = await skill({ token: "only.two" }) as any;
    expect(res.error).toContain("3 dot-separated parts");
  });

  it("should decode a valid JWT", async () => {
    const res = await skill({ token: validJwt }) as any;
    expect(res.header.alg).toBe("HS256");
    expect(res.payload.sub).toBe("1234567890");
    expect(res.payload.name).toBe("John");
    expect(res.signaturePresent).toBe(true);
  });

  it("should detect non-expired token", async () => {
    const res = await skill({ token: validJwt }) as any;
    expect(res.isExpired).toBe(false);
    expect(res.expiresAt).toBeDefined();
  });

  it("should detect expired token", async () => {
    const expiredJwt = [
      btoa(JSON.stringify({ alg: "HS256" })),
      btoa(JSON.stringify({ exp: 1000000000 })), // year 2001
      "sig",
    ].join(".");

    const res = await skill({ token: expiredJwt }) as any;
    expect(res.isExpired).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Text Processing
// ---------------------------------------------------------------------------

describe("text-summarizer", () => {
  const skill = BUILTIN_SKILLS["text-summarizer"];

  it("should return error when no text", async () => {
    const res = await skill({}) as any;
    expect(res.error).toBeDefined();
  });

  it("should summarize text", async () => {
    const text = "The quick brown fox jumps over the lazy dog. " +
      "Artificial intelligence is transforming industries worldwide. " +
      "Machine learning algorithms process vast amounts of data. " +
      "Natural language processing enables computers to understand human speech. " +
      "Deep learning neural networks have achieved remarkable accuracy.";

    const res = await skill({ text }) as any;
    expect(res.summary).toBeTruthy();
    expect(res.originalWordCount).toBeGreaterThan(0);
    expect(res.originalSentenceCount).toBe(5);
    expect(res.summarySentenceCount).toBeLessThanOrEqual(3);
    expect(res.compressionRatio).toBeLessThanOrEqual(1);
  });

  it("should respect maxSentences", async () => {
    const text = "First sentence. Second sentence. Third sentence. Fourth sentence. Fifth sentence.";
    const res = await skill({ text, maxSentences: 2 }) as any;
    expect(res.summarySentenceCount).toBeLessThanOrEqual(2);
  });
});

describe("keyword-extractor", () => {
  const skill = BUILTIN_SKILLS["keyword-extractor"];

  it("should return error when no text", async () => {
    const res = await skill({}) as any;
    expect(res.error).toBeDefined();
  });

  it("should extract keywords from text", async () => {
    const text = "JavaScript is a programming language. JavaScript runs in the browser. JavaScript frameworks include React and Vue.";
    const res = await skill({ text }) as any;
    expect(res.keywords.length).toBeGreaterThan(0);
    expect(res.keywords[0].word).toBe("javascript");
    expect(res.keywords[0].count).toBe(3);
    expect(res.totalWords).toBeGreaterThan(0);
  });

  it("should filter stop words", async () => {
    const text = "the the the and and or or but";
    const res = await skill({ text }) as any;
    expect(res.keywords.length).toBe(0);
  });

  it("should respect maxKeywords", async () => {
    const text = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu";
    const res = await skill({ text, maxKeywords: 3 }) as any;
    expect(res.keywords.length).toBeLessThanOrEqual(3);
  });
});

describe("markdown-to-text", () => {
  const skill = BUILTIN_SKILLS["markdown-to-text"];

  it("should return error when no input", async () => {
    const res = await skill({}) as any;
    expect(res.error).toBeDefined();
  });

  it("should strip headers", async () => {
    const res = await skill({ markdown: "# Hello\n## World" }) as any;
    expect(res.text).toBe("Hello\nWorld");
  });

  it("should strip bold and italic", async () => {
    const res = await skill({ markdown: "**bold** and *italic* and ***both***" }) as any;
    expect(res.text).toBe("bold and italic and both");
  });

  it("should strip links but keep text", async () => {
    const res = await skill({ markdown: "[Click here](https://example.com)" }) as any;
    expect(res.text).toBe("Click here");
  });

  it("should remove code blocks", async () => {
    const md = "before\n" + "```" + "js\ncode here\n" + "```" + "\nafter";
    const res = await skill({ markdown: md }) as any;
    expect(res.text).not.toContain("code here");
    expect(res.text).toContain("before");
    expect(res.text).toContain("after");
  });

  it("should strip inline code backticks", async () => {
    const res = await skill({ markdown: "Use `npm install` to install" }) as any;
    expect(res.text).toBe("Use npm install to install");
  });

  it("should strip blockquotes", async () => {
    const res = await skill({ markdown: "> This is a quote" }) as any;
    expect(res.text).toBe("This is a quote");
  });

  it("should return lengths", async () => {
    const md = "# Hello **World**";
    const res = await skill({ markdown: md }) as any;
    expect(res.originalLength).toBe(md.length);
    expect(res.textLength).toBeLessThan(md.length);
  });
});

describe("slug-generator", () => {
  const skill = BUILTIN_SKILLS["slug-generator"];

  it("should return error when no text", async () => {
    const res = await skill({}) as any;
    expect(res.error).toBeDefined();
  });

  it("should generate a slug from text", async () => {
    const res = await skill({ text: "Hello World" }) as any;
    expect(res.slug).toBe("hello-world");
  });

  it("should strip special characters", async () => {
    const res = await skill({ text: "Hello, World! How's it going?" }) as any;
    expect(res.slug).toBe("hello-world-hows-it-going");
  });

  it("should strip accents", async () => {
    const res = await skill({ text: "Café Résumé" }) as any;
    expect(res.slug).toBe("cafe-resume");
  });

  it("should support custom separator", async () => {
    const res = await skill({ text: "Hello World", separator: "_" }) as any;
    expect(res.slug).toBe("hello_world");
  });

  it("should collapse multiple separators", async () => {
    const res = await skill({ text: "Hello   World" }) as any;
    expect(res.slug).toBe("hello-world");
  });
});

// ---------------------------------------------------------------------------
// Data Utilities
// ---------------------------------------------------------------------------

describe("csv-to-json", () => {
  const skill = BUILTIN_SKILLS["csv-to-json"];

  it("should return error when no input", async () => {
    const res = await skill({}) as any;
    expect(res.error).toBeDefined();
  });

  it("should parse CSV to JSON", async () => {
    const csv = "name,age,city\nAlice,30,NYC\nBob,25,LA";
    const res = await skill({ csv }) as any;
    expect(res.data).toHaveLength(2);
    expect(res.headers).toEqual(["name", "age", "city"]);
    expect(res.data[0]).toEqual({ name: "Alice", age: "30", city: "NYC" });
    expect(res.data[1]).toEqual({ name: "Bob", age: "25", city: "LA" });
    expect(res.rowCount).toBe(2);
    expect(res.columnCount).toBe(3);
  });

  it("should handle custom delimiter", async () => {
    const csv = "name;age\nAlice;30";
    const res = await skill({ csv, delimiter: ";" }) as any;
    expect(res.data[0]).toEqual({ name: "Alice", age: "30" });
  });

  it("should handle header-only CSV", async () => {
    const csv = "name,age";
    const res = await skill({ csv }) as any;
    expect(res.data).toHaveLength(0);
    expect(res.headers).toEqual(["name", "age"]);
  });

  it("should return error for empty CSV", async () => {
    const res = await skill({ csv: "   " }) as any;
    expect(res.error).toContain("Empty CSV");
  });
});

describe("json-schema-validator", () => {
  const skill = BUILTIN_SKILLS["json-schema-validator"];

  it("should return error when no data", async () => {
    const res = await skill({ schema: '{"type":"object"}' }) as any;
    expect(res.error).toContain("No data");
  });

  it("should return error when no schema", async () => {
    const res = await skill({ data: '{"a":1}' }) as any;
    expect(res.error).toContain("No schema");
  });

  it("should validate correct data", async () => {
    const data = JSON.stringify({ name: "Alice", age: 30 });
    const schema = JSON.stringify({
      type: "object",
      required: ["name", "age"],
      properties: { name: { type: "string" }, age: { type: "number" } },
    });
    const res = await skill({ data, schema }) as any;
    expect(res.valid).toBe(true);
    expect(res.errorCount).toBe(0);
  });

  it("should detect missing required fields", async () => {
    const data = JSON.stringify({ name: "Alice" });
    const schema = JSON.stringify({ type: "object", required: ["name", "age"] });
    const res = await skill({ data, schema }) as any;
    expect(res.valid).toBe(false);
    expect(res.errors.some((e: string) => e.includes("age"))).toBe(true);
  });

  it("should detect type mismatches", async () => {
    const data = JSON.stringify({ name: 123 });
    const schema = JSON.stringify({
      type: "object",
      properties: { name: { type: "string" } },
    });
    const res = await skill({ data, schema }) as any;
    expect(res.valid).toBe(false);
    expect(res.errors[0]).toContain("expected string");
  });

  it("should handle invalid JSON in data", async () => {
    const res = await skill({ data: "{bad", schema: '{"type":"object"}' }) as any;
    expect(res.error).toContain("Invalid JSON in data");
  });

  it("should handle invalid JSON in schema", async () => {
    const res = await skill({ data: '{"a":1}', schema: "{bad" }) as any;
    expect(res.error).toContain("Invalid JSON in schema");
  });

  it("should validate array type", async () => {
    const res = await skill({ data: "[1,2,3]", schema: '{"type":"array"}' }) as any;
    expect(res.valid).toBe(true);
  });

  it("should reject wrong top-level type", async () => {
    const res = await skill({ data: '"hello"', schema: '{"type":"object"}' }) as any;
    expect(res.valid).toBe(false);
  });
});

describe("data-masker", () => {
  const skill = BUILTIN_SKILLS["data-masker"];

  it("should return error when no text", async () => {
    const res = await skill({}) as any;
    expect(res.error).toBeDefined();
  });

  it("should mask email addresses", async () => {
    const res = await skill({ text: "Contact me at alice@example.com please" }) as any;
    expect(res.masked).not.toContain("alice@example.com");
    expect(res.findings.some((f: any) => f.type === "email")).toBe(true);
    expect(res.totalMasked).toBeGreaterThanOrEqual(1);
  });

  it("should mask SSN", async () => {
    const res = await skill({ text: "SSN: 123-45-6789" }) as any;
    expect(res.masked).not.toContain("123-45-6789");
    expect(res.findings.some((f: any) => f.type === "ssn")).toBe(true);
  });

  it("should mask credit card numbers", async () => {
    const res = await skill({ text: "Card: 4111 1111 1111 1111" }) as any;
    expect(res.masked).not.toContain("4111 1111 1111 1111");
    expect(res.findings.some((f: any) => f.type === "credit_card")).toBe(true);
  });

  it("should mask IP addresses", async () => {
    const res = await skill({ text: "Server at 192.168.1.100" }) as any;
    expect(res.masked).not.toContain("192.168.1.100");
    expect(res.findings.some((f: any) => f.type === "ip_address")).toBe(true);
  });

  it("should mask multiple types in one text", async () => {
    const text = "User alice@test.com at 10.0.0.1 SSN 111-22-3333";
    const res = await skill({ text }) as any;
    expect(res.totalMasked).toBeGreaterThanOrEqual(3);
  });

  it("should leave clean text unchanged", async () => {
    const text = "Hello world, nothing sensitive here.";
    const res = await skill({ text }) as any;
    expect(res.masked).toBe(text);
    expect(res.totalMasked).toBe(0);
  });
});

describe("uuid-generator", () => {
  const skill = BUILTIN_SKILLS["uuid-generator"];

  it("should generate one UUID by default", async () => {
    const res = await skill({}) as any;
    expect(res.uuids).toHaveLength(1);
    expect(res.uuids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("should generate multiple UUIDs", async () => {
    const res = await skill({ count: 5 }) as any;
    expect(res.uuids).toHaveLength(5);
    expect(res.count).toBe(5);
    // All should be unique
    expect(new Set(res.uuids).size).toBe(5);
  });

  it("should cap at 100", async () => {
    const res = await skill({ count: 200 }) as any;
    expect(res.uuids).toHaveLength(100);
  });
});

describe("date-formatter", () => {
  const skill = BUILTIN_SKILLS["date-formatter"];

  it("should format current date when no input", async () => {
    const res = await skill({}) as any;
    expect(res.all.iso).toBeDefined();
    expect(res.all.unix).toBeTypeOf("number");
  });

  it("should format 'now'", async () => {
    const res = await skill({ date: "now" }) as any;
    expect(res.all.iso).toBeDefined();
  });

  it("should parse ISO date string", async () => {
    const res = await skill({ date: "2025-01-15T12:00:00Z" }) as any;
    expect(res.all.date).toBe("2025-01-15");
    expect(res.all.dayOfWeek).toBe("Wednesday");
  });

  it("should parse unix timestamp (seconds)", async () => {
    // 1704067200 = 2024-01-01T00:00:00Z
    const res = await skill({ date: "1704067200" }) as any;
    expect(res.all.date).toBe("2024-01-01");
  });

  it("should parse unix timestamp (milliseconds)", async () => {
    const res = await skill({ date: "1704067200000" }) as any;
    expect(res.all.date).toBe("2024-01-01");
  });

  it("should return requested format", async () => {
    const res = await skill({ date: "2025-06-15T00:00:00Z", format: "date" }) as any;
    expect(res.formatted).toBe("2025-06-15");
  });

  it("should return error for invalid date", async () => {
    const res = await skill({ date: "not-a-date" }) as any;
    expect(res.error).toContain("Invalid date");
  });

  it("should include relative time", async () => {
    const res = await skill({ date: "2025-01-01T00:00:00Z" }) as any;
    expect(res.all.relative).toContain("ago");
  });
});
