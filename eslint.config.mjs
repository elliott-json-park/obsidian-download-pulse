// The same rules Obsidian's automated plugin review runs.
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  // Build and test tooling runs in Node, not in Obsidian.
  { ignores: ["main.js", "node_modules/", ".harness/", "scripts/", "esbuild.config.mjs", "eslint.config.mjs"] },
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: { projectService: { allowDefaultProject: [] } },
    },
  },
]);
