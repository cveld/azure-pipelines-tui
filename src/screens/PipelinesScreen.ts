import { spawn } from "child_process";
import * as blessed from "blessed";
import { fetchPipelineRuns } from "../lib/api.js";
import { buildPipeTree, flattenPipeTree, formatPipeItem } from "../lib/format.js";
import type { FlatPipeItem, PipelineDefinition } from "../lib/types.js";
import { clearByPrefix } from "../cache.js";
import type { AppContext } from "./context.js";

export class PipelinesScreen {
  readonly widget: blessed.Widgets.ListElement;
  private flatItems: FlatPipeItem[] = [];
  private collapsed = new Set<string>();

  get footerText(): string {
    return (
      " {cyan-fg}↑↓{/} Navigate  {cyan-fg}Enter{/} Stages  {cyan-fg}v{/} Runs  {cyan-fg}o{/} Open  " +
      "{cyan-fg}e{/} Envs  {cyan-fg}b{/} Browser  {cyan-fg}r{/} Refresh  {cyan-fg}q{/} Quit"
    );
  }

  constructor(
    private screen: blessed.Widgets.Screen,
    private ctx: AppContext,
  ) {
    this.widget = blessed.list({
      parent: screen, top: 1, left: 0, width: "100%", height: "100%-3",
      border: { type: "line" }, label: " Pipeline Definitions ",
      tags: true, keys: true, vi: true, scrollable: true,
      scrollbar: { ch: "│", style: { fg: "blue" } },
      style: {
        border: { fg: "cyan" }, selected: { bg: "blue", fg: "white" },
        focus: { border: { fg: "white" } },
      },
      items: [], hidden: true,
    });
    this.registerKeys();
  }

  show(): void {
    this.widget.show();
    this.widget.focus();
    if (this.ctx.state.pipelines.length === 0) {
      this.ctx.loadPipelineDefinitions().then(() => this.refresh());
    } else {
      this.refresh();
    }
  }

  hide(): void { this.widget.hide(); }

  refresh(scrollTo?: PipelineDefinition): void {
    const tree = buildPipeTree(this.ctx.state.pipelines);
    this.flatItems = [];
    flattenPipeTree(tree, this.collapsed, 0, this.flatItems);
    (this.widget as any).setItems(this.flatItems.map(formatPipeItem));
    if (scrollTo) {
      const idx = this.flatItems.findIndex(i => i.kind === "pipeline" && i.pipeline.id === scrollTo.id);
      if (idx >= 0) {
        (this.widget as any).select(idx);
        const vis = ((this.widget as any).height as number) - 2;
        (this.widget as any).scrollTo(Math.max(0, idx - Math.floor(vis / 2)));
      }
    }
    this.screen.render();
  }

  scrollTo(pipeline: PipelineDefinition): void { this.refresh(pipeline); }

  private selected(): FlatPipeItem | undefined {
    const idx = (this.widget as any).selected as number ?? 0;
    return this.flatItems[idx];
  }

  private registerKeys(): void {
    this.widget.key("e", () => this.ctx.navigate({ view: "environments" }));
    this.widget.key("r", () => {
      const { org, project } = this.ctx;
      clearByPrefix(`pipelines_${org}_${project}`);
      this.ctx.state.pipelines = [];
      this.ctx.setStatus("Refreshing…", 0);
      this.ctx.loadPipelineDefinitions().then(() => this.refresh());
    });
    this.widget.key("b", () => {
      const item = this.selected();
      if (!item || item.kind !== "pipeline") return;
      const { org, project } = this.ctx;
      const url = `https://dev.azure.com/${org}/${project}/_build?definitionId=${item.pipeline.id}&_a=summary`;
      try { spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref(); } catch {}
    });
    this.widget.key("enter", () => {
      const item = this.selected();
      if (!item) return;
      if (item.kind === "folder") {
        if (this.collapsed.has(item.key)) this.collapsed.delete(item.key);
        else this.collapsed.add(item.key);
        this.refresh();
      } else {
        this.ctx.navigate({ view: "stages", pipeline: item.pipeline });
      }
    });
    this.widget.key("v", () => {
      const item = this.selected();
      if (!item || item.kind !== "pipeline") return;
      this.ctx.navigate({ view: "runs", pipeline: item.pipeline });
    });
    this.widget.key("o", async () => {
      const item = this.selected();
      if (!item || item.kind !== "pipeline") return;
      this.ctx.setStatus("Loading latest run…", 0);
      try {
        const token = await this.ctx.getToken();
        const runs = await fetchPipelineRuns(this.ctx.org, this.ctx.project, item.pipeline.id, token, 1);
        if (runs.length === 0) { this.ctx.setStatus("No runs found for this pipeline"); return; }
        this.ctx.navigate({ view: "pipelineRun", buildId: String(runs[0].id) });
      } catch (e) {
        this.ctx.setStatus(`Error: ${(e as Error).message.slice(0, 80)}`, 5000);
      }
    });
    this.widget.key("right", () => {
      const item = this.selected();
      if (!item || item.kind !== "folder" || item.isExpanded) return;
      this.collapsed.delete(item.key);
      this.refresh();
    });
    this.widget.key("left", () => {
      const item = this.selected();
      if (!item) return;
      if (item.kind === "folder" && item.isExpanded) {
        this.collapsed.add(item.key);
        this.refresh();
      } else {
        const parentKey = item.key.slice(0, item.key.lastIndexOf("\\")) || "\\";
        const idx = this.flatItems.findIndex(i => i.kind === "folder" && i.key === parentKey);
        if (idx >= 0) { (this.widget as any).select(idx); this.screen.render(); }
      }
    });
  }
}
