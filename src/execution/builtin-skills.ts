/**
 * Built-in skill implementations — compiled into Cortex for instant execution.
 * Keyed by skill slug. Each skill is a pure function: input → output.
 */

export type BuiltinSkillFn = (input: Record<string, unknown>) => Promise<unknown>;

// ---------------------------------------------------------------------------
// Helper: extract a string from common input field names
// ---------------------------------------------------------------------------
function getString(input: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    if (input[k] != null) return String(input[k]);
  }
  return "";
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

const mrComplexityScorer: BuiltinSkillFn = async (input) => {
  const code = getString(input, "code", "diff", "text");
  if (!code) return { error: "No code provided. Pass { code: '...' } or { diff: '...' } as input." };

  const lines = code.split("\n");
  const totalLines = lines.length;
  const addedLines = lines.filter((l) => l.startsWith("+")).length;
  const removedLines = lines.filter((l) => l.startsWith("-")).length;
  const changedFiles = new Set(
    lines.filter((l) => l.startsWith("diff --git") || l.startsWith("+++") || l.startsWith("---")).map((l) => l.split(" ").pop()),
  ).size;

  const issues: Array<{ severity: string; line: number; message: string }> = [];
  let complexityScore = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length > 120) {
      issues.push({ severity: "warning", line: i + 1, message: `Line exceeds 120 chars (${line.length})` });
      complexityScore += 1;
    }
    if (/\b(TODO|FIXME|HACK|XXX)\b/.test(line)) {
      issues.push({ severity: "info", line: i + 1, message: `Contains ${line.match(/\b(TODO|FIXME|HACK|XXX)\b/)![0]} marker` });
      complexityScore += 2;
    }
    const indent = lines[i].match(/^(\s*)/)?.[1].length ?? 0;
    if (indent >= 16) {
      issues.push({ severity: "warning", line: i + 1, message: "Deep nesting detected (4+ levels)" });
      complexityScore += 3;
    }
    if (/\b(console\.(log|debug|warn)|debugger|print\()\b/.test(line)) {
      issues.push({ severity: "warning", line: i + 1, message: "Debug statement detected" });
      complexityScore += 2;
    }
    if (/(?:password|secret|api_key|token)\s*[:=]\s*['"][^'"]+['"]/i.test(line)) {
      issues.push({ severity: "critical", line: i + 1, message: "Possible hardcoded secret/credential" });
      complexityScore += 10;
    }
    if (/\b(function |async function |=>\s*\{|\.then\()/.test(line)) {
      complexityScore += 1;
    }
  }

  if (totalLines > 500) complexityScore += 5;
  if (totalLines > 1000) complexityScore += 10;

  const rating = complexityScore <= 5 ? "low" : complexityScore <= 15 ? "medium" : complexityScore <= 30 ? "high" : "critical";
  const criticalCount = issues.filter((i) => i.severity === "critical").length;
  const warningCount = issues.filter((i) => i.severity === "warning").length;

  return {
    complexity: rating,
    complexityScore,
    stats: { totalLines, addedLines, removedLines, changedFiles: changedFiles || 1 },
    issues: issues.slice(0, 20),
    counts: { critical: criticalCount, warnings: warningCount, info: issues.length - criticalCount - warningCount },
    summary: `Complexity: ${rating} (score: ${complexityScore}). Found ${criticalCount} critical, ${warningCount} warnings across ${totalLines} lines.`,
    recommendation: criticalCount > 0 ? "Block merge — critical issues found." : warningCount > 5 ? "Request changes — multiple warnings." : "Approve — looks good.",
  };
};

const emotionState: BuiltinSkillFn = async (input) => {
  const text = getString(input, "text", "prompt", "content").toLowerCase();
  if (!text) return { error: "No text provided. Pass { text: '...' } as input." };

  const positive = ["love", "great", "amazing", "excellent", "wonderful", "fantastic", "awesome", "good", "happy", "best", "perfect", "beautiful", "enjoy", "pleased", "satisfied", "recommend"];
  const negative = ["hate", "terrible", "awful", "horrible", "bad", "worst", "broken", "poor", "disappointing", "frustrated", "angry", "useless", "waste", "fail", "sucks", "rubbish"];

  const words = text.split(/\s+/);
  let posCount = 0, negCount = 0;
  const posMatches: string[] = [], negMatches: string[] = [];

  for (const w of words) {
    const c = w.replace(/[^a-z]/g, "");
    if (positive.includes(c)) { posCount++; posMatches.push(c); }
    if (negative.includes(c)) { negCount++; negMatches.push(c); }
  }

  const total = posCount + negCount;
  const score = total === 0 ? 0.5 : posCount / total;
  const sentiment = total === 0 ? "neutral" : score > 0.6 ? "positive" : score < 0.4 ? "negative" : "mixed";

  return {
    sentiment, score: Math.round(score * 100) / 100,
    positiveSignals: posMatches, negativeSignals: negMatches,
    wordCount: words.length,
    summary: `Detected ${sentiment} sentiment (score: ${score.toFixed(2)}). Found ${posCount} positive and ${negCount} negative signals.`,
  };
};

// ---------------------------------------------------------------------------
// Developer Tools
// ---------------------------------------------------------------------------

const jsonFormatter: BuiltinSkillFn = async (input) => {
  const raw = getString(input, "json", "text", "data");
  if (!raw) return { error: "No JSON provided. Pass { json: '...' } as input." };

  const indent = typeof input.indent === "number" ? input.indent : 2;
  try {
    const parsed = JSON.parse(raw);
    const formatted = JSON.stringify(parsed, null, indent);
    const keys = Object.keys(typeof parsed === "object" && parsed !== null ? parsed : {});
    return {
      formatted,
      valid: true,
      type: Array.isArray(parsed) ? "array" : typeof parsed,
      topLevelKeys: keys.length > 0 ? keys : undefined,
      length: Array.isArray(parsed) ? parsed.length : undefined,
    };
  } catch (err) {
    return { formatted: null, valid: false, error: (err as Error).message };
  }
};

const regexTester: BuiltinSkillFn = async (input) => {
  const pattern = getString(input, "pattern", "regex");
  const text = getString(input, "text", "input", "string");
  const flags = getString(input, "flags") || "g";
  if (!pattern) return { error: "No pattern provided. Pass { pattern: '...', text: '...' } as input." };
  if (!text) return { error: "No text provided. Pass { pattern: '...', text: '...' } as input." };

  try {
    const re = new RegExp(pattern, flags);
    const matches: Array<{ match: string; index: number; groups?: Record<string, string> }> = [];
    let m: RegExpExecArray | null;

    if (flags.includes("g")) {
      while ((m = re.exec(text)) !== null) {
        matches.push({ match: m[0], index: m.index, groups: m.groups });
        if (m[0].length === 0) re.lastIndex++; // prevent infinite loop on zero-length match
      }
    } else {
      m = re.exec(text);
      if (m) matches.push({ match: m[0], index: m.index, groups: m.groups });
    }

    return {
      matches,
      matchCount: matches.length,
      hasMatch: matches.length > 0,
      pattern,
      flags,
    };
  } catch (err) {
    return { error: `Invalid regex: ${(err as Error).message}` };
  }
};

const base64Codec: BuiltinSkillFn = async (input) => {
  const text = getString(input, "text", "data", "input");
  const operation = getString(input, "operation", "op", "mode") || "encode";
  if (!text) return { error: "No text provided. Pass { text: '...', operation: 'encode'|'decode' } as input." };

  if (operation === "decode") {
    try {
      const decoded = atob(text.replace(/\s/g, ""));
      return { result: decoded, operation: "decode", inputLength: text.length, outputLength: decoded.length };
    } catch {
      return { error: "Invalid base64 input." };
    }
  }

  const encoded = btoa(text);
  return { result: encoded, operation: "encode", inputLength: text.length, outputLength: encoded.length };
};

const hashGenerator: BuiltinSkillFn = async (input) => {
  const text = getString(input, "text", "data", "input");
  const algorithm = getString(input, "algorithm", "algo") || "SHA-256";
  if (!text) return { error: "No text provided. Pass { text: '...' } as input." };

  const validAlgos = ["SHA-1", "SHA-256", "SHA-384", "SHA-512"];
  const algo = validAlgos.find((a) => a.toLowerCase() === algorithm.toLowerCase());
  if (!algo) return { error: `Unsupported algorithm. Use one of: ${validAlgos.join(", ")}` };

  const data = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest(algo, data);
  const hashHex = Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("");

  return { hash: hashHex, algorithm: algo, inputLength: text.length };
};

const jwtDecoder: BuiltinSkillFn = async (input) => {
  const token = getString(input, "token", "jwt", "text");
  if (!token) return { error: "No JWT provided. Pass { token: '...' } as input." };

  const parts = token.split(".");
  if (parts.length !== 3) return { error: "Invalid JWT format — expected 3 dot-separated parts." };

  const decode = (s: string) => {
    const padded = s.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(padded));
  };

  try {
    const header = decode(parts[0]);
    const payload = decode(parts[1]);
    const isExpired = payload.exp ? payload.exp * 1000 < Date.now() : undefined;
    const expiresAt = payload.exp ? new Date(payload.exp * 1000).toISOString() : undefined;
    const issuedAt = payload.iat ? new Date(payload.iat * 1000).toISOString() : undefined;

    return { header, payload, isExpired, expiresAt, issuedAt, signaturePresent: parts[2].length > 0 };
  } catch (err) {
    return { error: `Failed to decode JWT: ${(err as Error).message}` };
  }
};

// ---------------------------------------------------------------------------
// Text Processing
// ---------------------------------------------------------------------------

const textSummarizer: BuiltinSkillFn = async (input) => {
  const text = getString(input, "text", "content", "input");
  if (!text) return { error: "No text provided. Pass { text: '...' } as input." };

  const maxSentences = typeof input.maxSentences === "number" ? input.maxSentences : 3;
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  const words = text.split(/\s+/).filter(Boolean);

  // Score sentences by word frequency (extractive summarization)
  const freq: Record<string, number> = {};
  for (const w of words) {
    const lw = w.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (lw.length > 3) freq[lw] = (freq[lw] || 0) + 1;
  }

  const scored = sentences.map((s, i) => {
    const sWords = s.split(/\s+/);
    const score = sWords.reduce((sum, w) => {
      const lw = w.toLowerCase().replace(/[^a-z0-9]/g, "");
      return sum + (freq[lw] || 0);
    }, 0) / (sWords.length || 1);
    return { sentence: s.trim(), score, index: i };
  });

  scored.sort((a, b) => b.score - a.score);
  const topSentences = scored.slice(0, maxSentences).sort((a, b) => a.index - b.index);
  const summary = topSentences.map((s) => s.sentence).join(" ");

  return {
    summary,
    originalWordCount: words.length,
    originalSentenceCount: sentences.length,
    summarySentenceCount: topSentences.length,
    compressionRatio: Math.round((summary.length / text.length) * 100) / 100,
  };
};

const keywordExtractor: BuiltinSkillFn = async (input) => {
  const text = getString(input, "text", "content", "input");
  if (!text) return { error: "No text provided. Pass { text: '...' } as input." };

  const maxKeywords = typeof input.maxKeywords === "number" ? input.maxKeywords : 10;
  const stopWords = new Set([
    "the", "be", "to", "of", "and", "a", "in", "that", "have", "i", "it", "for", "not", "on",
    "with", "he", "as", "you", "do", "at", "this", "but", "his", "by", "from", "they", "we",
    "say", "her", "she", "or", "an", "will", "my", "one", "all", "would", "there", "their",
    "what", "so", "up", "out", "if", "about", "who", "get", "which", "go", "me", "when",
    "make", "can", "like", "time", "no", "just", "him", "know", "take", "people", "into",
    "year", "your", "some", "could", "them", "see", "other", "than", "then", "now", "look",
    "only", "come", "its", "over", "think", "also", "back", "after", "use", "two", "how",
    "our", "work", "first", "well", "way", "even", "new", "want", "because", "any", "these",
    "give", "day", "most", "us", "is", "are", "was", "were", "been", "being", "has", "had",
    "did", "does", "doing", "will", "shall", "should", "may", "might", "must", "need",
  ]);

  const words = text.toLowerCase().split(/\s+/).map((w) => w.replace(/[^a-z0-9]/g, "")).filter((w) => w.length > 2 && !stopWords.has(w));
  const freq: Record<string, number> = {};
  for (const w of words) freq[w] = (freq[w] || 0) + 1;

  const keywords = Object.entries(freq)
    .sort(([, a], [, b]) => b - a)
    .slice(0, maxKeywords)
    .map(([word, count]) => ({ word, count, frequency: Math.round((count / words.length) * 10000) / 100 }));

  return {
    keywords,
    totalWords: text.split(/\s+/).length,
    uniqueKeywords: keywords.length,
  };
};

const markdownToText: BuiltinSkillFn = async (input) => {
  const md = getString(input, "markdown", "text", "md", "content");
  if (!md) return { error: "No markdown provided. Pass { markdown: '...' } as input." };

  let text = md;
  // Headers
  text = text.replace(/^#{1,6}\s+/gm, "");
  // Bold/italic
  text = text.replace(/\*\*\*(.+?)\*\*\*/g, "$1");
  text = text.replace(/\*\*(.+?)\*\*/g, "$1");
  text = text.replace(/\*(.+?)\*/g, "$1");
  text = text.replace(/___(.+?)___/g, "$1");
  text = text.replace(/__(.+?)__/g, "$1");
  text = text.replace(/_(.+?)_/g, "$1");
  // Strikethrough
  text = text.replace(/~~(.+?)~~/g, "$1");
  // Code blocks (must run before inline code)
  text = text.replace(/```[\s\S]*?```/g, "");
  // Inline code
  text = text.replace(/`(.+?)`/g, "$1");
  // Links
  text = text.replace(/\[(.+?)\]\(.+?\)/g, "$1");
  // Images
  text = text.replace(/!\[.*?\]\(.+?\)/g, "");
  // Blockquotes
  text = text.replace(/^\s*>\s?/gm, "");
  // Lists
  text = text.replace(/^\s*[-*+]\s+/gm, "");
  text = text.replace(/^\s*\d+\.\s+/gm, "");
  // Horizontal rules
  text = text.replace(/^[-*_]{3,}\s*$/gm, "");
  // HTML tags
  text = text.replace(/<[^>]+>/g, "");
  // Collapse whitespace
  text = text.replace(/\n{3,}/g, "\n\n").trim();

  return { text, originalLength: md.length, textLength: text.length };
};

const slugGenerator: BuiltinSkillFn = async (input) => {
  const text = getString(input, "text", "title", "name", "input");
  if (!text) return { error: "No text provided. Pass { text: '...' } as input." };

  const separator = getString(input, "separator") || "-";
  const slug = text
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // strip accents
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, separator)
    .replace(new RegExp(`${separator.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}+`, "g"), separator)
    .replace(new RegExp(`^${separator.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|${separator.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "g"), "");

  return { slug, original: text, separator };
};

// ---------------------------------------------------------------------------
// Data Utilities
// ---------------------------------------------------------------------------

const csvToJson: BuiltinSkillFn = async (input) => {
  const csv = getString(input, "csv", "text", "data");
  if (!csv) return { error: "No CSV provided. Pass { csv: '...' } as input." };

  const delimiter = getString(input, "delimiter") || ",";
  const lines = csv.trim().split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return { error: "Empty CSV." };

  const headers = lines[0].split(delimiter).map((h) => h.trim().replace(/^"|"$/g, ""));
  const rows = lines.slice(1).map((line) => {
    const values = line.split(delimiter).map((v) => v.trim().replace(/^"|"$/g, ""));
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => { obj[h] = values[i] ?? ""; });
    return obj;
  });

  return { data: rows, headers, rowCount: rows.length, columnCount: headers.length };
};

const jsonSchemaValidator: BuiltinSkillFn = async (input) => {
  const dataStr = getString(input, "data", "json");
  const schemaStr = getString(input, "schema");
  if (!dataStr) return { error: "No data provided. Pass { data: '...', schema: '...' } as input." };
  if (!schemaStr) return { error: "No schema provided. Pass { data: '...', schema: '...' } as input." };

  let data: unknown, schema: Record<string, unknown>;
  try { data = JSON.parse(dataStr); } catch { return { error: "Invalid JSON in data field." }; }
  try { schema = JSON.parse(schemaStr); } catch { return { error: "Invalid JSON in schema field." }; }

  const errors: string[] = [];

  const validateType = (val: unknown, expected: string, path: string) => {
    if (expected === "array" && !Array.isArray(val)) errors.push(`${path}: expected array, got ${typeof val}`);
    else if (expected === "object" && (typeof val !== "object" || val === null || Array.isArray(val))) errors.push(`${path}: expected object, got ${Array.isArray(val) ? "array" : typeof val}`);
    else if (expected === "string" && typeof val !== "string") errors.push(`${path}: expected string, got ${typeof val}`);
    else if (expected === "number" && typeof val !== "number") errors.push(`${path}: expected number, got ${typeof val}`);
    else if (expected === "boolean" && typeof val !== "boolean") errors.push(`${path}: expected boolean, got ${typeof val}`);
    else if (expected === "integer" && (!Number.isInteger(val))) errors.push(`${path}: expected integer, got ${typeof val}`);
  };

  if (schema.type) validateType(data, schema.type as string, "$");
  if (schema.required && typeof data === "object" && data !== null) {
    for (const key of schema.required as string[]) {
      if (!(key in (data as Record<string, unknown>))) errors.push(`$: missing required field "${key}"`);
    }
  }
  if (schema.properties && typeof data === "object" && data !== null) {
    const props = schema.properties as Record<string, Record<string, unknown>>;
    for (const [key, propSchema] of Object.entries(props)) {
      const val = (data as Record<string, unknown>)[key];
      if (val !== undefined && propSchema.type) validateType(val, propSchema.type as string, `$.${key}`);
    }
  }

  return { valid: errors.length === 0, errors, errorCount: errors.length };
};

const dataMasker: BuiltinSkillFn = async (input) => {
  let text = getString(input, "text", "data", "content");
  if (!text) return { error: "No text provided. Pass { text: '...' } as input." };

  const maskChar = getString(input, "maskChar") || "*";
  const findings: Array<{ type: string; original: string; masked: string }> = [];

  // Email
  text = text.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, (m) => {
    const masked = m[0] + maskChar.repeat(5) + "@" + maskChar.repeat(5);
    findings.push({ type: "email", original: m, masked });
    return masked;
  });

  // Phone (US-style)
  text = text.replace(/\b(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, (m) => {
    const masked = maskChar.repeat(m.length);
    findings.push({ type: "phone", original: m, masked });
    return masked;
  });

  // SSN
  text = text.replace(/\b\d{3}-\d{2}-\d{4}\b/g, (m) => {
    const masked = `${maskChar.repeat(3)}-${maskChar.repeat(2)}-${maskChar.repeat(4)}`;
    findings.push({ type: "ssn", original: m, masked });
    return masked;
  });

  // Credit card (simple 16 digit)
  text = text.replace(/\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g, (m) => {
    const last4 = m.replace(/[-\s]/g, "").slice(-4);
    const masked = `${maskChar.repeat(12)}${last4}`;
    findings.push({ type: "credit_card", original: m, masked });
    return masked;
  });

  // IP address
  text = text.replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, (m) => {
    const masked = `${maskChar.repeat(3)}.${maskChar.repeat(3)}.${maskChar.repeat(3)}.${maskChar.repeat(3)}`;
    findings.push({ type: "ip_address", original: m, masked });
    return masked;
  });

  return { masked: text, findings, totalMasked: findings.length };
};

const uuidGenerator: BuiltinSkillFn = async (input) => {
  const count = Math.min(typeof input.count === "number" ? input.count : 1, 100);
  const uuids = Array.from({ length: count }, () => crypto.randomUUID());
  return { uuids, count: uuids.length };
};

const dateFormatter: BuiltinSkillFn = async (input) => {
  const dateStr = getString(input, "date", "timestamp", "input");
  const format = getString(input, "format") || "iso";

  let date: Date;
  if (!dateStr || dateStr === "now") {
    date = new Date();
  } else {
    const parsed = Number(dateStr);
    date = !isNaN(parsed) && dateStr.length >= 10 ? new Date(parsed > 1e12 ? parsed : parsed * 1000) : new Date(dateStr);
  }

  if (isNaN(date.getTime())) return { error: `Invalid date: "${dateStr}"` };

  const results: Record<string, string | number> = {
    iso: date.toISOString(),
    utc: date.toUTCString(),
    locale: date.toLocaleString("en-US"),
    date: date.toISOString().split("T")[0],
    time: date.toISOString().split("T")[1].replace("Z", ""),
    unix: Math.floor(date.getTime() / 1000),
    unixMs: date.getTime(),
    dayOfWeek: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][date.getUTCDay()],
    relative: getRelativeTime(date),
  };

  return { formatted: results[format] ?? results.iso, all: results };
};

function getRelativeTime(date: Date): string {
  const diff = Date.now() - date.getTime();
  const abs = Math.abs(diff);
  const suffix = diff > 0 ? "ago" : "from now";
  if (abs < 60000) return `${Math.floor(abs / 1000)} seconds ${suffix}`;
  if (abs < 3600000) return `${Math.floor(abs / 60000)} minutes ${suffix}`;
  if (abs < 86400000) return `${Math.floor(abs / 3600000)} hours ${suffix}`;
  return `${Math.floor(abs / 86400000)} days ${suffix}`;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const BUILTIN_SKILLS: Record<string, BuiltinSkillFn> = {
  // Existing
  "mr-complexity-scorer": mrComplexityScorer,
  "emotion-state": emotionState,

  // Developer Tools
  "json-formatter": jsonFormatter,
  "regex-tester": regexTester,
  "base64-codec": base64Codec,
  "hash-generator": hashGenerator,
  "jwt-decoder": jwtDecoder,

  // Text Processing
  "text-summarizer": textSummarizer,
  "keyword-extractor": keywordExtractor,
  "markdown-to-text": markdownToText,
  "slug-generator": slugGenerator,

  // Data Utilities
  "csv-to-json": csvToJson,
  "json-schema-validator": jsonSchemaValidator,
  "data-masker": dataMasker,
  "uuid-generator": uuidGenerator,
  "date-formatter": dateFormatter,
};
