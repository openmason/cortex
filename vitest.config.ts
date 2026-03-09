import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["tests/**/*.test.ts"],
    alias: {
      // Mock cloudflare:workers for non-Workers vitest environment
      "cloudflare:workers": new URL("./tests/__mocks__/cloudflare-workers.ts", import.meta.url).pathname,
    },
  },
});
