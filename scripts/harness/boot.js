// Boots the real plugin inside harness.html, with `obsidian` swapped for the shim.
import { App } from "obsidian";
import PulsePlugin from "../../src/main";

// ?demo seeds a fresh profile (the author's plugins, Vault Orrery against four 3D-graph plugins);
// ?view= ?mode= ?range= ?theme=dark ?motion=off pick what a screenshot shows.
const q = new URLSearchParams(location.search);
if (q.has("demo")) {
  const saved = JSON.parse(localStorage.getItem("pp-data") || "null");
  const settings = {
    ...(saved?.settings ?? {}),
    mine: ["vault-orrery", "class-timetable", "vault-pet"],
    competitors: { "vault-orrery": ["constellations", "spherical-graph", "vault-galaxy", "galaxy-view"] },
    motion: q.get("motion") ?? "auto",
    ui: { view: q.get("view") ?? "overview", mode: q.get("mode") ?? "self", range: q.get("range") ?? "30", align: "date" },
  };
  settings.meta ??= {};
  localStorage.setItem("pp-data", JSON.stringify({ settings, store: saved?.store ?? {} }));
}
if (q.get("theme") === "dark") { document.body.classList.remove("theme-light"); document.body.classList.add("theme-dark"); }
if (q.has("bare")) document.body.classList.add("is-bare");
if (q.get("side") === "none") document.body.classList.add("no-side");
if (q.get("side") === "only") document.body.classList.add("only-side");

const app = new App();
const plugin = new PulsePlugin(app, { id: "plugin-pulse", name: "Download Pulse", version: "dev" });
window.pulse = plugin;
await plugin.onload();
await plugin.openDashboard();
await plugin.openGlance();

// Code blocks in a note, rendered the way Obsidian would.
const note = document.getElementById("note");
const first = plugin.settings.mine[0];
for (const src of ["", first ? `plugin: ${first}\nrivals: true\ndays: 30` : ""]) {
  const box = note.createDiv({ cls: "block-wrap" });
  box.createEl("pre", { cls: "block-src", text: "```plugin-pulse\n" + (src ? src + "\n" : "") + "```" });
  app.codeBlocks["plugin-pulse"](src, box.createDiv(), { addChild: (c) => c.load() });
}

// Headless screenshots wait for this: data loaded and every chart built.
plugin.engine.on("status", (s) => { if (s.state === "ok" || s.state === "partial") setTimeout(() => { document.title = "ready"; }, 2500); });
// ?scroll=<n> starts the page at its n-th chart card (for screenshots of what is below the fold):
// everything above it is hidden, so the card is revealed in place instead of by scrolling.
if (q.has("scroll")) {
  const n = Number(q.get("scroll"));
  const style = document.head.appendChild(document.createElement("style"));
  style.textContent = `#main .pp-hero, #main .pp-insights, #main .pp-tiles { display: none !important; }` +
    Array.from({ length: n }, (_, i) => `#main .pp-grid > .pp-card:nth-child(${i + 1}) { display: none !important; }`).join("");
}

document.getElementById("theme").addEventListener("click", () => {
  document.body.classList.toggle("theme-dark");
  document.body.classList.toggle("theme-light");
  app.workspace.trigger("css-change");
});
document.getElementById("reset").addEventListener("click", () => { localStorage.removeItem("pp-data"); location.reload(); });
document.getElementById("settings").addEventListener("click", () => plugin.openSettings());
for (const b of document.querySelectorAll("[data-width]")) {
  b.addEventListener("click", () => { document.getElementById("main").style.maxWidth = b.dataset.width; });
}
