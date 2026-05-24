import { spawn } from "child_process";
import * as blessed from "blessed";
import { fetchPipelineRuns } from "../lib/api.js";
import { formatRunItem } from "../lib/format.js";
import type { PipelineDefinition, PipelineRun } from "../lib/types.js";
import { clearByPrefix } from "../cache.js";
import type { AppContext } from "./context.js";

export class PipelineRunsScreen {
  readonly widget: blessed.Widgets.ListElement;
  private pipeline: PipelineDefinition | null = null;
  private runs: PipelineRun[] = [];

  get footerText(): string {
    return (
      " {cyan-fg}↑↓{/} Navigate  {cyan-fg}Enter{/} Open run  {cyan-fg}b{/} Browser  " +
      "{cyan-fg}r{/} Refresh  {cyan-fg}Esc{/} Back  {cyan-fg}q{/} Quit"
    );
  }

  constructor(
    private screen: blessed.Widgets.Screen,
    private ctx: AppContext,
  ) {
    this.widget = blessed.list({
      parent: screen, top: 1, left: 0, width: "100%", height: "100%-3",
      border: { type: "line" }, label: " Pipeline Runs ",
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

  show(pipeline: PipelineDefinition): void {
    this.pipeline = pipeline;
    this.runs = [];
    this.widget.show();
    this.widget.setLabel(` Runs: ${pipeline.name} `);
    (this.widget as any).setItems([]);
    this.widget.focus();
    this.screen.render();
    this.loadData();
  }

  hide(): void { this.widget.hide(); }

  getPipeline(): PipelineDefinition | null { return this.pipeline; }

  private refresh(): void {
    if (!this.pipeline) return;
    (this.widget as any).setItems(this.runs.map(formatRunItem));
    this.widget.setLabel(` Runs: ${this.pipeline.name}  (${this.runs.length}) `);
    this.screen.render();
  }

  private selected(): PipelineRun | undefined {
    const idx = (this.widget as any).selected as number ?? 0;
    return this.runs[idx];
  }

  private async loadData(): Promise<void> {
    if (!this.pipeline) return;
    this.ctx.setStatus("Loading runs…", 0);
    try {
      const token = await this.ctx.getToken();
      this.runs = await fetchPipelineRuns(this.ctx.org, this.ctx.project, this.pipeline.id, token);
      this.refresh();
      this.ctx.setStatus("", 0);
    } catch (e) {
      this.ctx.setStatus(`Error: ${(e as Error).message.slice(0, 80)}`, 10_000);
    }
  }

  private registerKeys(): void {
    this.widget.key("enter", () => {
      const run = this.selected();
      if (!run) return;
      this.ctx.navigate({ view: "pipelineRun", buildId: String(run.id) });
    });
    this.widget.key("b", () => {
      const run = this.selected();
      if (!run) return;
      const { org, project } = this.ctx;
      const url = `https://dev.azure.com/${org}/${project}/_build/results?buildId=${run.id}`;
      try { spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref(); } catch {}
    });
    this.widget.key("r", () => {
      if (!this.pipeline) return;
      const { org, project } = this.ctx;
      clearByPrefix(`runs_${org}_${project}_${this.pipeline.id}`);
      this.runs = [];
      this.ctx.setStatus("Refreshing…", 0);
      this.loadData();
    });
    this.widget.key("escape", () => this.ctx.goBack());
  }
}
