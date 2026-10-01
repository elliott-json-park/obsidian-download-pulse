// npm run harness — bundles the plugin with the obsidian shim and serves harness.html.
import esbuild from "esbuild";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const ctx = await esbuild.context({
  entryPoints: [path.join(here, "boot.js")],
  bundle: true, format: "esm", target: "es2022", sourcemap: "inline",
  outfile: path.join(root, ".harness/boot.js"),
  alias: { obsidian: path.join(here, "obsidian-shim.js") },
  logLevel: "info",
});
await ctx.watch();

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png" };
const port = Number(process.env.PORT || 5178);
createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const file = path.join(root, decodeURIComponent(url.pathname === "/" ? "/scripts/harness/harness.html" : url.pathname));
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": types[path.extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" }).end(body);
  } catch { res.writeHead(404).end("not found"); }
}).listen(port, () => console.log(`harness on http://localhost:${port}/`));
