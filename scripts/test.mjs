// npm test — bundles scripts/tests/run.ts with a Node stand-in for `obsidian` and runs it.
import esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(mkdtempSync(path.join(tmpdir(), "plugin-pulse-test-")), "run.mjs");
await esbuild.build({
  entryPoints: [path.join(here, "tests/run.ts")],
  bundle: true, platform: "node", format: "esm", target: "node20", outfile: out, logLevel: "warning",
  alias: { obsidian: path.join(here, "tests/obsidian-node.js") },
});
await import(pathToFileURL(out).href);
