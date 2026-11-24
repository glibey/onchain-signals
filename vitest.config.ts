import { defineConfig } from "vitest/config";
export default defineConfig({ test: { env: { CACHE_TTL_MS: "0" }, include: ["test/**/*.test.ts"] } });
