import { defineConfig } from "vitest/config";
import { fileURLToPath } from "url";

export default defineConfig({
  // tsconfig says "preserve" (Next compiles JSX); tests that render pages need the automatic runtime.
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "sdk/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
