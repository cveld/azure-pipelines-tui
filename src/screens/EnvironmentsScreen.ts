import { spawn } from "child_process";
import * as blessed from "blessed";
import {
  fetchAllEnvironments, fetchLatestDeployment, fetchBuildInfo, fetchPipelineDefinitions,
} from "../lib/api.js";
import {
  buildEnvTree, flattenEnvTree, formatEnvItem, envColHeaderStr,
} from "../lib/format.js";
import type { EnvRow, FlatEnvItem } from "../lib/types.js";
import { clearByPrefix, clearAllCache } from "../cache.js";
import type { AppContext } from "./context.js";

export class EnvironmentsScreen {
  readonly colHeader: blessed.Widgets.BoxElement;
  readonly widget: blessed.Widgets.ListElement;
  private rows: EnvRow[] = [];
  private flatItems: FlatEnvItem[] = [];
  private collapsed = new Set<string>();

  get footerText(): string {
    return (
      " {cyan-fg}↑↓{/} Navigate  {cyan-fg}Enter{/} Expand/Stages  {cyan-fg}←{/} Collapse  " +
      "{cyan-fg}p{/} Pipelines  {cyan-fg}m{/} Mapping  {cyan-fg}r{/} Refresh  {cyan-fg}c{/} Clear  {cyan-fg}q{/} Quit"
    );
  }

  constructor(
    private screen: blessed.Widgets.Screen,
    private ctx: AppContext,
  ) {
    this.colHeader = blessed.box({
      parent: screen, top: 1, left: 0, width: "100%", height: 1,
      style: { bg: "black", fg: "cyan", bold: true },
      content: envColHeaderStr(), hidden: true,
    });
    this.widget = blessed.list({
      parent: screen, top: 2, left: 0, width: "100%", height: "100%-4",
      border: { type: "line" }, label: " Environments ",
      tags: true, keys: true, vi: true, scrollable: true,
      scrollbar: { ch: "│", style: { fg: "blue" } },
      style: {
        border: { fg: "cyan" }, selected: { bg: "blue", fg: "white", bold: true },
        item: { fg: "white" }, focus: { border: { fg: "white" } },
      },
      items: [], hidden: true,
    });
    this.registerKeys();
  }

  show(): void {
    this.colHeader.show();
    this.widget.show();
    this.widget.focus();
    if (this.rows.length === 0) this.loadData();
  }

  hide(): void { this.colHeader.hide(); this.widget.hide(); }

  getRows(): EnvRow[] { return this.rows; }

  private refresh(): void {
    const prevKey = this.flatItems[(this.widget as any).selected as number]?.key;
    const tree = buildEnvTree(this.rows);
    this.flatItems = [];
    flattenEnvTree(tree, this.collapsed, 0, this.flatItems);
    (this.widget as any).setItems(this.flatItems.map(formatEnvItem));
    if (prevKey) {
      const idx = this.flatItems.findIndex(i => i.key === prevKey);
      if (idx >= 0) (this.widget as any).select(idx);
    }
    this.screen.render();
  }

  private selected(): FlatEnvItem | undefined {
    const idx = (this.widget as any).selected as number ?? 0;
    return this.flatItems[idx];
  }

  private async openStagesForRow(row: EnvRow): Promise<void> {
    if (!row.mapping) {
      const bid = row.deploy?.owner?.id ? Number(row.deploy.owner.id) : 0;
      if (!bid) return;
      const url = `https://dev.azure.com/${this.ctx.org}/${this.ctx.project}/_build/results?buildId=${bid}`;
      try { spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref(); } catch {}
      return;
    }
    let pip = this.ctx.state.pipelines.find(p => p.id === row.mapping!.pipelineId);
    if (!pip) {
      this.ctx.setStatus("Loading pipeline definitions…", 0);
      try {
        await this.ctx.loadPipelineDefinitions();
        pip = this.ctx.state.pipelines.find(p => p.id === row.mapping!.pipelineId);
      } catch (e) {
        this.ctx.setStatus(`Error: ${(e as Error).message.slice(0, 80)}`, 5000);
        return;
      }
    }
    if (pip) this.ctx.navigate({ view: "stages", pipeline: pip });
    else this.ctx.setStatus(`Pipeline ${row.mapping.pipelineId} not found`);
  }

  private async loadData(): Promise<void> {
    this.ctx.setStatus("Loading environments…", 0);
    try {
      const token = await this.ctx.getToken();
      const envs = await fetchAllEnvironments(this.ctx.org, this.ctx.project, token);
      this.rows = envs.map(env => ({
        env, mapping: this.ctx.config.mappings.find(m => m.environmentId === env.id), loading: true,
      }));
      this.refresh();
      this.ctx.setStatus(`${envs.length} environments — loading deployments…`, 0);

      if (this.ctx.state.pipelines.length === 0) {
        fetchPipelineDefinitions(this.ctx.org, this.ctx.project, token)
          .then(defs => { this.ctx.state.pipelines = defs; })
          .catch(() => {});
      }

      const BATCH = 10;
      for (let i = 0; i < this.rows.length; i += BATCH) {
        const batch = this.rows.slice(i, i + BATCH);
        await Promise.all(batch.map(async row => {
          row.deploy = (await fetchLatestDeployment(this.ctx.org, this.ctx.project, row.env.id, token)) ?? undefined;
          row.loading = false;
        }));
        this.refresh();
        this.ctx.setStatus(`Deployments ${Math.min(i + BATCH, this.rows.length)}/${this.rows.length}…`, 0);
      }

      const withDeploy = this.rows.filter(r => r.deploy?.owner?.id);
      let done = 0;
      for (let i = 0; i < withDeploy.length; i += BATCH) {
        const batch = withDeploy.slice(i, i + BATCH);
        await Promise.all(batch.map(async row => {
          row.build = (await fetchBuildInfo(this.ctx.org, this.ctx.project, row.deploy!.owner.id, token)) ?? undefined;
          done++;
        }));
        this.refresh();
        this.ctx.setStatus(`Build info ${done}/${withDeploy.length}…`, 0);
      }
      this.ctx.setStatus("", 0);
    } catch (e) {
      this.ctx.setStatus(`Error: ${(e as Error).message.slice(0, 80)}`, 10_000);
    }
  }

  private registerKeys(): void {
    this.widget.key("p", () => this.ctx.navigate({ view: "pipelines" }));
    this.widget.key("m", () => this.ctx.navigate({ view: "mapping" }));
    this.widget.key("r", () => {
      const { org, project } = this.ctx;
      clearByPrefix(`envs_${org}_${project}`);
      clearByPrefix(`deploy_${org}_${project}`);
      this.rows = [];
      this.ctx.setStatus("Refreshing…", 0);
      this.loadData();
    });
    this.widget.key("c", () => { clearAllCache(); this.ctx.setStatus("All caches cleared"); });
    this.widget.key("enter", () => {
      const item = this.selected();
      if (!item) return;
      if (item.kind === "group") {
        if (this.collapsed.has(item.key)) this.collapsed.delete(item.key);
        else this.collapsed.add(item.key);
        this.refresh();
      } else {
        this.openStagesForRow(item.row);
      }
    });
    this.widget.key("left", () => {
      const item = this.selected();
      if (!item) return;
      if (item.kind === "group" && item.isExpanded) {
        this.collapsed.add(item.key);
        this.refresh();
      } else {
        const parentKey = item.key.split("-").slice(0, -1).join("-");
        if (parentKey) {
          const idx = this.flatItems.findIndex(i => i.kind === "group" && i.key === parentKey);
          if (idx >= 0) { (this.widget as any).select(idx); this.screen.render(); }
        }
      }
    });
  }
}
