import { defineConfig } from "vitest/config";
import path from "node:path";

// Frontend unit tests: pure-logic only (the date formatter). No jsdom, no
// browser environment — component behavior is covered by the Playwright e2e
// suite. A dedicated config (rather than reusing vite.config.ts) keeps the
// react + Tailwind plugins out of a fast, dependency-free run.
export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
