import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import { defineConfig } from "eslint/config";
import stylistic from "@stylistic/eslint-plugin";

export default defineConfig([
  {
    ignores: [
      "coverage/**",
      "drizzle/meta/**",
      ".claude/**",
    ],
  },
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  stylistic.configs.customize({
    commaDangle: "always-multiline",
    semi: true,
    arrowParens: true,
    braceStyle: "1tbs",
    severity: "warn",
  }),
  {
    plugins: {
      "@stylistic": stylistic,
    },
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        {
          allowAny: false,
          allowBoolean: true,
          allowNever: false,
          allowNullish: false,
          allowNumber: true,
          allowRegExp: false,
        },
      ],
      "@typescript-eslint/no-confusing-void-expression": ["error", { ignoreArrowShorthand: true }],
      "@stylistic/quotes": ["warn", "double", {
        avoidEscape: true,
      }],
      "@stylistic/operator-linebreak": ["warn", "after", { overrides: { "?": "before", ":": "before" } }],
      "@stylistic/no-multiple-empty-lines": ["warn", { max: 2 }],
      "@stylistic/lines-between-class-members": "off",
      "@stylistic/no-multi-spaces": "off",
      "@stylistic/key-spacing": "off",
    },
  },
]);
