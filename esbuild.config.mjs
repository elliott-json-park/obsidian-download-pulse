import esbuild from "esbuild";
import process from "node:process";
import { builtinModules } from "node:module";

const banner = `/*
 * Download Pulse — bundled by esbuild. Do not edit main.js directly; the source is in src/.
 * Bundles Chart.js (MIT, https://www.chartjs.org) — see THIRD-PARTY-NOTICES.md.
 */
`;

const prod = process.argv[2] === "production";

const ctx = await esbuild.context({
  banner: { js: banner },
  entryPoints: ["src/main.ts"],
  bundle: true,
  // Chart.js is bundled in on purpose: a plugin may not load code from the network.
  external: [
    "obsidian", "electron",
    "@codemirror/autocomplete", "@codemirror/collab", "@codemirror/commands",
    "@codemirror/language", "@codemirror/lint", "@codemirror/search",
    "@codemirror/state", "@codemirror/view",
    "@lezer/common", "@lezer/highlight", "@lezer/lr",
    ...builtinModules, ...builtinModules.map((m) => "node:" + m),
  ],
  format: "cjs",
  target: "es2020",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: prod,
});

if (prod) { await ctx.rebuild(); await ctx.dispose(); }
else { await ctx.watch(); }
