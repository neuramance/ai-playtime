import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";
import { noTautologicalAssertion } from "./eslint/no-tautological-assertion.ts";

export default defineConfig(
  globalIgnores(["dist"]),
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  { languageOptions: { parserOptions: { projectService: true } } },
  { files: ["eslint.config.js"], extends: [tseslint.configs.disableTypeChecked] },
  {
    plugins: { local: { rules: { "no-tautological-assertion": noTautologicalAssertion } } },
    rules: {
      "local/no-tautological-assertion": "error",
      complexity: ["error", { max: 10, variant: "classic" }],
      "max-depth": ["error", 3],
      "max-lines": ["error", { max: 500, skipBlankLines: false, skipComments: false }],
      "max-lines-per-function": [
        "error",
        { max: 100, skipBlankLines: false, skipComments: false, IIFEs: true },
      ],
    },
  },
);
