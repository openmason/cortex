/**
 * Cloudflare Analytics Engine SQL API client.
 *
 * Queries the cortex_metrics dataset via the CF REST API.
 * SQL dialect: ClickHouse.
 *
 * Schema (from src/observability/metrics.ts):
 *   index1:  tenantId
 *   blob1:   event type
 *   blob2:   requestId
 *   blob3:   product
 *   blob4:   skillSlug
 *   blob5:   status (ok | error | timeout)
 *   blob6:   error message
 *   double1: durationMs
 *   double2: tokens
 *   double3: cost (USD)
 */

export interface AnalyticsRow {
  [key: string]: string | number | null;
}

export interface AnalyticsResult {
  meta: { name: string; type: string }[];
  data: AnalyticsRow[];
  rows: number;
}

export class AnalyticsClient {
  private endpoint: string;
  private apiToken: string;

  constructor(accountId: string, apiToken: string) {
    this.endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`;
    this.apiToken = apiToken;
  }

  /**
   * Execute a SQL query against the cortex_metrics dataset.
   * Returns structured rows with column names.
   */
  async query(sql: string): Promise<AnalyticsResult> {
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiToken}` },
      body: sql,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Analytics query failed: ${res.status} ${text}`);
    }

    return res.json();
  }
}
