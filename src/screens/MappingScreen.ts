import * as blessed from "blessed";
import { saveConfig } from "../lib/api.js";
import { padEnd } from "../lib/format.js";
import type { EnvMapping } from "../lib/types.js";
import type { AppContext } from "./context.js";
import type { EnvironmentsScreen } from "./EnvironmentsScreen.js";

export class MappingScreen {
  readonly leftWidget: blessed.Widgets.ListElement;
  readonly rightWidget: blessed.Widgets.ListElement;
  private configFile: string;
  private snapshot: EnvMapping[] = [];

  get footerText(): string {
    return (
      " {cyan-fg}Tab{/} Switch panels  {cyan-fg}Space{/} Link env→pipeline  " +
      "{cyan-fg}d{/} Delete  {cyan-fg}s{/} Save  {cyan-fg}Esc{/} Discard"
    );
  }

  constructor(
    private screen: blessed.Widgets.Screen,
    private ctx: AppContext,
    private envScreen: EnvironmentsScreen,
    configFile: string,
  ) {
    this.configFile = configFile;
    this.leftWidget = blessed.list({
      parent: screen, top: 1, left: 0, width: "50%", height: "100%-3",
      border: { type: "line" }, label: " Environments ",
      tags: true, keys: true, vi: true, scrollable: true,
      scrollbar: { ch: "│", style: { fg: "blue" } },
      style: { border: { fg: "gray" }, selected: { bg: "blue", fg: "white" }, focus: { border: { fg: "white" } } },
      items: [], hidden: true,
    });
    this.rightWidget = blessed.list({
      parent: screen, top: 1, left: "50%", width: "50%", height: "100%-3",
      border: { type: "line" }, label: " Pipeline Definitions ",
      tags: true, keys: true, vi: true, scrollable: true,
      scrollbar: { ch: "│", style: { fg: "blue" } },
      style: { border: { fg: "gray" }, selected: { bg: "blue", fg: "white" }, focus: { border: { fg: "white" } } },
      items: [], hidden: true,
    });
    this.registerKeys();
  }

  show(): void {
    if (this.ctx.state.pipelines.length === 0) {
      this.ctx.setStatus("Pipeline definitions still loading…");
      this.ctx.navigate({ view: "environments" });
      return;
    }
    this.snapshot = this.ctx.config.mappings.map(m => ({ ...m }));
    this.populateLeft();
    (this.rightWidget as any).setItems(this.ctx.state.pipelines.map(p => {
      const nm = padEnd(p.name, 50);
      const pt = p.path !== "\\" ? `  {gray-fg}${p.path}{/}` : "";
      return ` ${padEnd(String(p.id), 6)} ${nm}${pt}`;
    }));
    this.leftWidget.show();
    this.rightWidget.show();
    this.leftWidget.focus();
    this.screen.render();
  }

  hide(): void { this.leftWidget.hide(); this.rightWidget.hide(); }

  private populateLeft(): void {
    const rows = this.envScreen.getRows();
    (this.leftWidget as any).setItems(rows.map(row => {
      const name = padEnd(row.env.name, 32);
      let tag: string;
      if (row.mapping) {
        tag = `{cyan-fg}[${padEnd(row.mapping.pipelineName, 30)}]{/}`;
      } else if (row.deploy) {
        tag = `{gray-fg}[auto: ${padEnd(row.deploy.definition.name, 25)}]{/}`;
      } else {
        tag = "{gray-fg}[-]{/}";
      }
      return `${name} ${tag}`;
    }));
  }

  private link(): void {
    const rows = this.envScreen.getRows();
    const envSel = (this.leftWidget as any).selected as number ?? 0;
    const pipSel = (this.rightWidget as any).selected as number ?? 0;
    const row = rows[envSel];
    const pip = this.ctx.state.pipelines[pipSel];
    if (!row || !pip) return;
    const m: EnvMapping = {
      environmentId: row.env.id, environmentName: row.env.name,
      pipelineId: pip.id, pipelineName: pip.name,
    };
    this.ctx.config.mappings = this.ctx.config.mappings.filter(x => x.environmentId !== row.env.id);
    this.ctx.config.mappings.push(m);
    row.mapping = m;
    this.populateLeft();
    this.ctx.setStatus(`Linked "${row.env.name}" → "${pip.name}"`, 0);
    this.screen.render();
  }

  private discard(): void {
    this.ctx.config.mappings = this.snapshot;
    const rows = this.envScreen.getRows();
    rows.forEach(row => {
      row.mapping = this.ctx.config.mappings.find(m => m.environmentId === row.env.id);
    });
  }

  private save(): void {
    saveConfig(this.configFile, this.ctx.config);
    this.ctx.navigate({ view: "environments" });
    this.ctx.setStatus("Config saved");
  }

  private registerKeys(): void {
    this.leftWidget.key("tab",           () => { this.rightWidget.focus(); this.screen.render(); });
    this.rightWidget.key("tab",          () => { this.leftWidget.focus(); this.screen.render(); });
    this.leftWidget.key(["space", "enter"],  () => this.link());
    this.rightWidget.key(["space", "enter"], () => this.link());
    this.leftWidget.key("d", () => {
      const rows = this.envScreen.getRows();
      const sel = (this.leftWidget as any).selected as number ?? 0;
      const row = rows[sel];
      if (!row) return;
      this.ctx.config.mappings = this.ctx.config.mappings.filter(x => x.environmentId !== row.env.id);
      row.mapping = undefined;
      this.populateLeft();
      this.ctx.setStatus(`Deleted mapping for "${row.env.name}"`, 0);
      this.screen.render();
    });
    this.leftWidget.key("s",      () => this.save());
    this.rightWidget.key("s",     () => this.save());
    this.leftWidget.key("escape",  () => { this.discard(); this.ctx.navigate({ view: "environments" }); });
    this.rightWidget.key("escape", () => { this.discard(); this.ctx.navigate({ view: "environments" }); });
  }
}
