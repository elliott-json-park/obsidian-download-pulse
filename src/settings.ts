import { App, Notice, PluginSettingTab, SecretComponent, Setting, normalizePath, type SettingDefinitionItem } from "obsidian";
import type PulsePlugin from "./main";
import { t, setLanguage } from "./i18n";
import { emptyStore } from "./types";
import { importInto } from "./data/store";
import { AuthorModal, CompetitorsModal, PluginSearchModal } from "./ui/modals";

/** One settings row: its label, and the controls it adds to an Obsidian `Setting`. */
interface Row { name: string; desc?: string; render: (s: Setting) => unknown }
interface Group { heading: string; rows: Row[] }

/** Declarative settings: Obsidian renders the rows and indexes them for its settings search. */
export class PulseSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: PulsePlugin) { super(app, plugin); }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return this.groups().map((g) => ({
      type: "group" as const,
      heading: g.heading,
      items: g.rows.map((r) => ({ name: r.name, desc: r.desc, render: (s: Setting) => this.row(s, r) })),
    }));
  }

  private row(s: Setting, r: Row) {
    s.setName(r.name);
    if (r.desc) s.setDesc(r.desc);
    s.settingEl.addClass("pp-setting");
    r.render(s);
  }

  /** Re-renders after a change that adds or removes rows. */
  private refresh() { this.update(); }

  private groups(): Group[] {
    const s = this.plugin.settings, plugin = this.plugin;
    const changed = async () => { await plugin.trackedChanged(); this.refresh(); };

    const plugins: Row[] = s.mine.map((id) => {
      const n = (s.competitors[id] ?? []).length;
      return {
        name: s.meta[id]?.name ?? id,
        desc: `${id} · ${t().rivalsCount(n)}`,
        render: (row) => row
          .addButton((b) => b.setButtonText(n ? t().editRivals : t().addRivals).onClick(() =>
            new CompetitorsModal(this.app, plugin, id, () => this.refresh()).open()))
          .addExtraButton((b) => b.setIcon("arrow-up").setTooltip(t().moveUp).setDisabled(s.mine.indexOf(id) === 0).onClick(() => {
            const i = s.mine.indexOf(id);
            [s.mine[i - 1], s.mine[i]] = [s.mine[i], s.mine[i - 1]];
            void changed();
          }))
          .addExtraButton((b) => b.setIcon("trash").setTooltip(t().remove).onClick(() => {
            s.mine = s.mine.filter((x) => x !== id);
            delete s.competitors[id];
            void changed();
          })),
      };
    });
    plugins.push(
      { name: t().sAdd, desc: t().sAddDesc, render: (row) => row.addButton((b) => b.setButtonText(t().searchAny).setCta().onClick(() =>
        new PluginSearchModal(this.app, plugin, new Set(s.mine), (p) => void plugin.follow([p]).then(() => this.refresh())).open())) },
      { name: t().sByAuthor, desc: t().sByAuthorDesc, render: (row) => row.addButton((b) => b.setButtonText(t().find).onClick(() =>
        new AuthorModal(this.app, plugin, () => this.refresh()).open())) },
    );

    const updates: Row[] = [
      { name: t().sInterval, desc: t().sIntervalDesc, render: (row) => row.addDropdown((d) => {
        for (const m of [0, 30, 60, 180, 360]) d.addOption(String(m), t().every(m));
        d.setValue(String(s.refreshMinutes)).onChange(async (v) => { s.refreshMinutes = +v; await plugin.saveSettings(); plugin.schedule(); });
      }) },
      { name: t().sArchive, desc: t().sArchiveDesc, render: (row) => row.addToggle((tg) => tg.setValue(s.useArchive).onChange(async (v) => {
        s.useArchive = v;
        if (v) plugin.store.archivedAt = {};
        await plugin.saveSettings();
        if (v) void plugin.engine.refresh();
      })) },
      { name: t().sCatchUp, desc: t().sCatchUpDesc, render: (row) => row.addToggle((tg) => tg.setValue(s.catchUp).onChange(async (v) => { s.catchUp = v; await plugin.saveSettings(); })) },
      { name: t().sBackfill, desc: t().sBackfillDesc, render: (row) => {
        for (const n of [14, 30]) row.addButton((b) => b.setButtonText(t().sBackfillBtn(n)).onClick(async () => {
          b.setDisabled(true);
          const note = new Notice(t().backfillProgress(0, n), 0);
          try {
            const done = await plugin.engine.backfillOfficial(n, (a, total) => note.setMessage(t().backfillProgress(a, total)));
            note.setMessage(t().backfillDone(done));
          } catch (e) {
            note.setMessage(String((e as Error).message));
          }
          window.setTimeout(() => note.hide(), 4000);
          b.setDisabled(false);
        }));
      } },
      { name: t().sToken, desc: t().sTokenDesc, render: (row) => row.addComponent((el) =>
        new SecretComponent(this.app, el).setValue(s.githubSecret).onChange(async (v) => {
          s.githubSecret = v;
          plugin.store.githubAt = {};
          await plugin.saveSettings();
        })) },
    ];

    const display: Row[] = [
      { name: t().sMotion, desc: t().sMotionDesc, render: (row) => row.addDropdown((d) => d
        .addOption("auto", t().motionAuto).addOption("on", t().motionOn).addOption("off", t().motionOff)
        .setValue(s.motion).onChange(async (v) => { s.motion = v as typeof s.motion; await plugin.saveSettings(); plugin.redraw(); })) },
      { name: t().sStatusBar, desc: t().sStatusBarDesc, render: (row) => row.addToggle((tg) => tg.setValue(s.statusBar).onChange(async (v) => {
        s.statusBar = v; await plugin.saveSettings(); plugin.updateStatusBar();
      })) },
      { name: t().sNotices, desc: t().sNoticesDesc, render: (row) => row.addToggle((tg) => tg.setValue(s.milestoneNotices).onChange(async (v) => { s.milestoneNotices = v; await plugin.saveSettings(); })) },
      { name: t().sLanguage, render: (row) => row.addDropdown((d) => d
        .addOption("auto", t().langAuto).addOption("en", "English").addOption("ko", "한국어")
        .setValue(s.language).onChange(async (v) => {
          s.language = v as typeof s.language;
          setLanguage(s.language);
          await plugin.saveSettings();
          plugin.redraw();
          this.refresh();
        })) },
    ];

    let armed = false;
    const data: Row[] = [
      { name: t().sExport, desc: t().sExportDesc, render: (row) => row.addButton((b) => b.setButtonText(t().exportBtn).onClick(async () => {
        const path = normalizePath(`Download Pulse export ${new Date().toISOString().slice(0, 10)}.json`);
        const body = JSON.stringify({ format: "plugin-pulse", version: 1, store: plugin.store }, null, 1);
        const existing = this.app.vault.getFileByPath(path);
        if (existing) await this.app.vault.modify(existing, body); else await this.app.vault.create(path, body);
        new Notice(t().exported(path));
      })) },
      { name: t().sImport, desc: t().sImportDesc, render: (row) => row.addButton((b) => b.setButtonText(t().importBtn).onClick(() => this.pickImport())) },
      { name: t().sClear, desc: t().sClearDesc, render: (row) => row.addButton((b) => {
        b.setButtonText(t().clearBtn).setDestructive();
        b.onClick(() => {
          if (!armed) { armed = true; b.setButtonText(t().sClearConfirm); return; }
          plugin.store = emptyStore();
          void plugin.saveSettings().then(() => {
            plugin.engine.trigger("changed");
            new Notice(t().cleared);
            this.refresh();
          });
        });
      }) },
      { name: t().sNetwork, desc: t().sNetworkDesc, render: () => undefined },
    ];

    return [
      { heading: t().sPlugins, rows: plugins },
      { heading: t().sUpdates, rows: updates },
      { heading: t().sDisplay, rows: display },
      { heading: t().sData, rows: data },
    ];
  }

  private pickImport() {
    const input = createEl("input", { type: "file", attr: { accept: ".json,application/json" } });
    input.addEventListener("change", () => void (async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const n = importInto(this.plugin.store, JSON.parse(await file.text()), new Set(this.plugin.settings.mine));
        if (!n) throw new Error("empty");
        await this.plugin.saveSettings();
        this.plugin.engine.trigger("changed");
        new Notice(t().imported(n));
      } catch {
        new Notice(t().importFailed);
      }
    })());
    input.click();
  }
}
