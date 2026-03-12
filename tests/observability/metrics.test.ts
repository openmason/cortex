import { describe, it, expect, vi } from "vitest";
import { Metrics } from "../../src/observability/metrics";

describe("Metrics", () => {
  it("calls writeDataPoint with correct schema", () => {
    const mockAnalytics = {
      writeDataPoint: vi.fn(),
    };

    const metrics = new Metrics(mockAnalytics as unknown as AnalyticsEngineDataset);
    metrics.write("request", {
      requestId: "req-123",
      tenantId: "t1",
      product: "bombastic",
      status: "ok",
      durationMs: 150,
    });

    expect(mockAnalytics.writeDataPoint).toHaveBeenCalledOnce();
    const call = mockAnalytics.writeDataPoint.mock.calls[0][0];

    expect(call.indexes).toEqual(["t1"]);
    expect(call.blobs[0]).toBe("request");
    expect(call.blobs[1]).toBe("req-123");
    expect(call.blobs[2]).toBe("bombastic");
    expect(call.doubles[0]).toBe(150);
  });

  it("no-ops when analytics is undefined", () => {
    const metrics = new Metrics();
    // Should not throw
    metrics.write("request", { tenantId: "t1" });
  });

  it("does not throw when writeDataPoint fails", () => {
    const mockAnalytics = {
      writeDataPoint: vi.fn().mockImplementation(() => {
        throw new Error("Analytics Engine unavailable");
      }),
    };

    const metrics = new Metrics(mockAnalytics as unknown as AnalyticsEngineDataset);
    // Should not throw
    metrics.write("request", { tenantId: "t1" });
  });

  it("uses 'unknown' as default index when tenantId is missing", () => {
    const mockAnalytics = {
      writeDataPoint: vi.fn(),
    };

    const metrics = new Metrics(mockAnalytics as unknown as AnalyticsEngineDataset);
    metrics.write("cron", {});

    const call = mockAnalytics.writeDataPoint.mock.calls[0][0];
    expect(call.indexes).toEqual(["unknown"]);
  });

  it("fills empty strings for missing blob fields", () => {
    const mockAnalytics = {
      writeDataPoint: vi.fn(),
    };

    const metrics = new Metrics(mockAnalytics as unknown as AnalyticsEngineDataset);
    metrics.write("skill_exec", { tenantId: "t1", skillSlug: "test-skill" });

    const call = mockAnalytics.writeDataPoint.mock.calls[0][0];
    expect(call.blobs).toHaveLength(6);
    expect(call.blobs[0]).toBe("skill_exec");
    expect(call.blobs[1]).toBe(""); // requestId
    expect(call.blobs[2]).toBe(""); // product
    expect(call.blobs[3]).toBe("test-skill");
    expect(call.blobs[4]).toBe(""); // status
    expect(call.blobs[5]).toBe(""); // error
    expect(call.doubles).toEqual([0, 0, 0]);
  });

  it("records cost in double3", () => {
    const mockAnalytics = {
      writeDataPoint: vi.fn(),
    };

    const metrics = new Metrics(mockAnalytics as unknown as AnalyticsEngineDataset);
    metrics.write("llm_call", { tenantId: "t1", durationMs: 200, tokens: 500, cost: 0.00059 });

    const call = mockAnalytics.writeDataPoint.mock.calls[0][0];
    expect(call.doubles).toEqual([200, 500, 0.00059]);
  });
});
