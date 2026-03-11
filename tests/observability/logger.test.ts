import { describe, it, expect, vi, beforeEach } from "vitest";
import { Logger } from "../../src/observability/logger";

describe("Logger", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("outputs valid JSON to console.log for info level", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const log = new Logger("test");
    log.info("hello world");

    expect(spy).toHaveBeenCalledOnce();
    const output = JSON.parse(spy.mock.calls[0][0]);
    expect(output.level).toBe("info");
    expect(output.module).toBe("test");
    expect(output.msg).toBe("hello world");
    expect(output.ts).toBeDefined();
  });

  it("uses console.error for error level", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = new Logger("test");
    log.error("something broke", { code: 500 });

    expect(spy).toHaveBeenCalledOnce();
    const output = JSON.parse(spy.mock.calls[0][0]);
    expect(output.level).toBe("error");
    expect(output.msg).toBe("something broke");
    expect(output.code).toBe(500);
  });

  it("uses console.warn for warn level", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = new Logger("test");
    log.warn("caution");

    expect(spy).toHaveBeenCalledOnce();
    const output = JSON.parse(spy.mock.calls[0][0]);
    expect(output.level).toBe("warn");
  });

  it("uses console.debug for debug level", () => {
    const spy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const log = new Logger("test", {}, "debug");
    log.debug("verbose info");

    expect(spy).toHaveBeenCalledOnce();
    const output = JSON.parse(spy.mock.calls[0][0]);
    expect(output.level).toBe("debug");
    expect(output.msg).toBe("verbose info");
  });

  it("filters debug messages when level is info", () => {
    const spy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const log = new Logger("test", {}, "info");
    log.debug("should not appear");

    expect(spy).not.toHaveBeenCalled();
  });

  it("filters info messages when level is warn", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const log = new Logger("test", {}, "warn");
    log.info("should not appear");

    expect(logSpy).not.toHaveBeenCalled();
  });

  it("includes context in output", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const log = new Logger("test", { requestId: "req-123", tenantId: "t1" });
    log.info("with context");

    const output = JSON.parse(spy.mock.calls[0][0]);
    expect(output.requestId).toBe("req-123");
    expect(output.tenantId).toBe("t1");
  });

  it("merges data with context", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const log = new Logger("test", { requestId: "req-123" });
    log.info("with data", { extra: "value" });

    const output = JSON.parse(spy.mock.calls[0][0]);
    expect(output.requestId).toBe("req-123");
    expect(output.extra).toBe("value");
  });

  describe("child()", () => {
    it("creates a child logger with merged context", () => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      const parent = new Logger("test", { requestId: "req-123" });
      const child = parent.child({ workflowId: "wf-456" });
      child.info("from child");

      const output = JSON.parse(spy.mock.calls[0][0]);
      expect(output.requestId).toBe("req-123");
      expect(output.workflowId).toBe("wf-456");
      expect(output.module).toBe("test");
    });

    it("inherits log level from parent", () => {
      const spy = vi.spyOn(console, "debug").mockImplementation(() => {});
      const parent = new Logger("test", {}, "debug");
      const child = parent.child({ extra: true });
      child.debug("debug from child");

      expect(spy).toHaveBeenCalledOnce();
    });

    it("does not mutate parent context", () => {
      const parentSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const parent = new Logger("test", { requestId: "req-123" });
      parent.child({ workflowId: "wf-456" });
      parent.info("from parent");

      const output = JSON.parse(parentSpy.mock.calls[0][0]);
      expect(output.workflowId).toBeUndefined();
    });
  });
});
