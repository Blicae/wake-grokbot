import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { process: "readonly", console: "readonly", Buffer: "readonly", setTimeout: "readonly", clearTimeout: "readonly", URL: "readonly", AbortSignal: "readonly", fetch: "readonly" } },
    rules: { "@typescript-eslint/no-explicit-any": "error", "no-console": "off" },
  },
  { files: ["tests/**"], rules: { "@typescript-eslint/no-explicit-any": "off" } },
);
