import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "preact",
  },
  test: {
    environment: "jsdom",
    include: [
      "app/**/*.test.{js,jsx,ts,tsx}",
      "extensions/**/*.test.{js,jsx,ts,tsx}",
      "e2e/**/*.test.js",
    ],
  },
});
