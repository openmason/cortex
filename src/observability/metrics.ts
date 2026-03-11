/**
 * Cloudflare Analytics Engine metrics helper.
 *
 * Fire-and-forget — never throws, never blocks.
 * No-ops gracefully when the ANALYTICS binding is not configured.
 *
 * Dataset schema (positional):
 *   index:   tenantId
 *   blob1:   event type (request, skill_exec, llm_call, codegen, workflow, cron)
 *   blob2:   requestId
 *   blob3:   product
 *   blob4:   skillSlug
 *   blob5:   status (ok, error, timeout)
 *   blob6:   error message
 *   double1: durationMs
 *   double2: tokens
 */

export interface MetricContext {
  requestId?: string;
  tenantId?: string;
  product?: string;
  skillSlug?: string;
  status?: string;
  error?: string;
  durationMs?: number;
  tokens?: number;
}

export class Metrics {
  constructor(private analytics?: AnalyticsEngineDataset) {}

  /** Write a metric data point. Fire-and-forget. */
  write(event: string, ctx: MetricContext = {}): void {
    if (!this.analytics) return;
    try {
      this.analytics.writeDataPoint({
        indexes: [ctx.tenantId ?? "unknown"],
        blobs: [
          event,
          ctx.requestId ?? "",
          ctx.product ?? "",
          ctx.skillSlug ?? "",
          ctx.status ?? "",
          ctx.error ?? "",
        ],
        doubles: [ctx.durationMs ?? 0, ctx.tokens ?? 0],
      });
    } catch {
      // Fire-and-forget — never block the request
    }
  }
}
