/** @jest-config-loader ts-node */
import { defineConfig } from "vitest/config";
import path from "path";

const config = defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.{ts,js}"],
      exclude: [
        "src/index.ts",
        "src/register-commands.ts",
        "src/utils/visualHelpers.ts",
        "src/config.ts",
        "src/constants.ts",
      ],
    },
  },
});

export default config;
