import { spawn } from "child_process";
import * as blessed from "blessed";
import { fetchPipelineRuns, fetchRunStages } from "../lib/api.js";
import {
  buildStageBranchSummaries, branchHasRun, statusCell,
  padEnd, BRANCH_COL, PLAN_COL, APPLY_COL,
} from "../lib/format.js";
import type { PipelineDefinition, PipelineRun, StageInfo, StageMeta } from "../lib/types.js";
import { clearByPrefix } from "../cache.js";
import type { AppContext } from "./context.js";

export class StagesScreen {
  readonly colHeader: blessed.Widgets.BoxElement;
  readonly widget: blessed.Widgets.ListElement;
  private pipeline: PipelineDefinition | null = null;
  private runs: PipelineRun[] = [];
  private stagesMap = new Map<number, StageInfo[]>();
  private meta: StageMeta[] = [];

  get footerText(): string {
    return (
      " {cyan-fg}↑↓{/} Navigate  {cyan-fg}Enter{/} Open run  {cyan-fg}r{/} Refresh  " +
      "{cyan-fg}b{/} Browser  {cyan-fg}p{/} Pipelines  {cyan-fg}e{/} Envs  {cyan-fg}q{/} Quit"
    );
  }

  constructor(
    private screen: blessed.Widgets.Screen,
    private ctx: AppContext,
  ) {
    this.colHeader = blessed.box({
      parent: screen, top: 1, left: 0, width: "100%", height: 1,
      style: { bg: "black", fg: "cyan", bold: true },
      hidden: true,
    });
    this.widget = blessed.list({
      parent: screen, top: 2, left: 0, width: "100%", height: "100%-4",
      border: { type: "line" }, label: " Stages ",
      tags: true, keys: true, vi: true, scrollable: true,
      scrollbar: { ch: "│", style: { fg: "blue" } },
      style: {
        border: { fg: "magenta" }, selected: { bg: "blue", fg: "white", bold: true },
        item: { fg: "white" }, focus: { border: { fg: "white" } },
      },
      items: [], hidden: true,
    });
    this.registerKeys();
  }

  show(pipeline: PipelineDefinition): void {
    this.pipeline = pipeline;
    this.runs = [];
    this.stagesMap = new Map();
    this.meta = [];
    this.colHeader.show();
    this.widget.show();
    (this.widget as any).setItems([]);
    this.widget.setLabel(` Stages: ${pipeline.name} `);
    this.widget.focus();
    this.screen.render();
    this.loadData();
  }

  hide(): void { this.colHeader.hide(); this.widget.hide(); }

  getPipeline(): PipelineDefinition | null { return this.pipeline; }

  private refresh(): void {
    if (!this.pipeline) return;
    const baseGroups = buildStageBranchSummaries(this.runs, this.stagesMap);
    this.colHeader.setContent(
      padEnd("  Stage / Branch", BRANCH_COL + 2) + padEnd("Plan", PLAN_COL) + "Apply"
    );
    const items: string[] = [];
    const meta: StageMeta[] = [];
    for (let gi = 0; gi < baseGroups.length; gi++) {
      const { displayName, branches } = baseGroups[gi];
      items.push(`{bold} ${padEnd(displayName, BRANCH_COL)}{/}`);
      meta.push({ kind: "base", displayName });
      let mostRecentBranch: string | undefined;
      let mostRecentTime = "";
      for (const [branch, summary] of branches) {
        if (!branchHasRun(summary)) continue;
        const t = summary.applyLatest?.finishTime ?? summary.planLatest?.finishTime ??
                  summary.applyPrevOk?.finishTime ?? summary.planPrevOk?.finishTime ?? "";
        if (!mostRecentBranch || t > mostRecentTime) { mostRecentTime = t; mostRecentBranch = branch; }
      }
      for (const [branch, summary] of branches) {
        if (!branchHasRun(summary)) continue;
        const dim = branch !== mostRecentBranch;
        const branchText = padEnd("   " + branch, BRANCH_COL);
        const branchPart = dim ? `{#3a3a3a-fg}${branchText}{/}` : `{bold}${branchText}{/bold}`;
        const planPart   = statusCell(summary.planLatest,  summary.planPrevOk,  PLAN_COL,  false, summary.planPrevActive);
        const applyPart  = statusCell(summary.applyLatest, summary.applyPrevOk, APPLY_COL, false, summary.applyPrevActive);
        const latestRunId = summary.applyLatest?.runId ?? summary.planLatest?.runId;
        items.push(` ${branchPart} ${planPart}${applyPart}`);
        meta.push({ kind: "branch", branch, latestRunId });
      }
      if (gi < baseGroups.length - 1) { items.push(""); meta.push({ kind: "separator" }); }
    }
    this.meta = meta;
    (this.widget as any).setItems(items);
    this.widget.setLabel(` Stages: ${this.pipeline.name}  (${this.runs.length} runs) `);
    this.screen.render();
  }

  private async loadData(): Promise<void> {
    if (!this.pipeline) return;
    this.ctx.setStatus("Loading pipeline runs…", 0);
    try {
      const token = await this.ctx.getToken();
      this.runs = await fetchPipelineRuns(this.ctx.org, this.ctx.project, this.pipeline.id, token);
      this.ctx.setStatus(`${this.runs.length} runs — loading timelines…`, 0);
      this.refresh();
      const BATCH = 10;
      for (let i = 0; i < this.runs.length; i += BATCH) {
        await Promise.all(this.runs.slice(i, i + BATCH).map(async run => {
          const stages = await fetchRunStages(this.ctx.org, this.ctx.project, run.id, token);
          this.stagesMap.set(run.id, stages);
        }));
        this.refresh();
        this.ctx.setStatus(`Timelines ${Math.min(i + BATCH, this.runs.length)}/${this.runs.length}…`, 0);
      }
      this.ctx.setStatus("", 0);
    } catch (e) {
      this.ctx.setStatus(`Error: ${(e as Error).message.slice(0, 80)}`, 10_000);
    }
  }

  private registerKeys(): void {
    this.widget.key("p", () => this.ctx.navigate({ view: "pipelines" }));
    this.widget.key("e", () => this.ctx.navigate({ view: "environments" }));
    this.widget.key("escape", () => this.ctx.goBack());
    this.widget.key("r", () => {
      if (!this.pipeline) return;
      const { org, project } = this.ctx;
      clearByPrefix(`runs_${org}_${project}_${this.pipeline.id}`);
      clearByPrefix(`stages_${org}_${project}`);
      this.runs = [];
      this.stagesMap = new Map();
      this.ctx.setStatus("Refreshing…", 0);
      this.loadData();
    });
    this.widget.key("b", () => {
      if (!this.pipeline) return;
      const { org, project } = this.ctx;
      const url = `https://dev.azure.com/${org}/${project}/_build?definitionId=${this.pipeline.id}&_a=summary`;
      try { spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref(); } catch {}
    });
    this.widget.key("enter", () => {
      const sel = (this.widget as any).selected as number ?? 0;
      const m   = this.meta[sel];
      if (!m || m.kind !== "branch" || !m.latestRunId) return;
      this.ctx.navigate({ view: "pipelineRun", buildId: String(m.latestRunId) });
    });
  }
}
