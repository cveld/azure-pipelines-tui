import * as blessed from "blessed";
import {
  fetchBuild, fetchTimeline, fetchLogLines, fetchProjectId, httpPatch, API_VER, enc,
} from "../lib/api.js";
import { buildFlatRunTree, runItemLabel, formatLogLine } from "../lib/format.js";
import type { Build, TimelineRecord, FlatRunItem, RegularItem } from "../lib/types.js";
import { connectSignalR, type HubEvent, type SignalRHandle } from "../signalr.js";
import type { AppContext } from "./context.js";

export class PipelineRunScreen {
  readonly treeWidget: blessed.Widgets.ListElement;
  readonly logWidget: blessed.Widgets.Log;

  // Build state
  private buildId: string | null = null;
  private build: Build | null = null;
  private records: TimelineRecord[] = [];
  private logCache = new Map<number, string[]>();
  private collapsed = new Set<string>();
  private expandedGroups = new Set<string>();
  private treeItems: FlatRunItem[] = [];
  private selectedLogId: string | null = null;
  private followLog = true;
  private keepTimestamps: boolean;

  // Spinner
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;
  private spinnerFrame = 0;
  private readonly SPINNER_FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

  // SignalR
  private signalRHandle: SignalRHandle | null = null;
  private signalRStarted = false;
  private signalRDelay = 3_000;
  private pendingLines = new Map<string, string[]>();

  // Polling
  private pollGen = 0;

  get footerText(): string {
    const live = this.followLog && this.selectedLogId ? "  {green-fg}● LIVE{/}" : "";
    return (
      " {cyan-fg}↑↓{/} Navigate  {cyan-fg}Enter/→{/} Select  {cyan-fg}←/Esc{/} Back  " +
      `{cyan-fg}Tab{/} Switch  {cyan-fg}f{/} Follow  {cyan-fg}r{/} Retry  {cyan-fg}q{/} Quit${live}`
    );
  }

  constructor(
    private screen: blessed.Widgets.Screen,
    private ctx: AppContext,
    opts: { keepTimestamps?: boolean } = {},
  ) {
    this.keepTimestamps = opts.keepTimestamps ?? false;

    this.treeWidget = blessed.list({
      parent: screen, top: 1, left: 0, width: "34%", height: "100%-3",
      border: { type: "line" }, label: " Pipeline ",
      tags: true, keys: true, vi: true, scrollable: true,
      scrollbar: { ch: "│", style: { fg: "blue" } },
      style: {
        border: { fg: "cyan" }, selected: { bg: "blue", fg: "white", bold: true },
        item: { fg: "white" }, focus: { border: { fg: "white" } },
      },
      items: [], hidden: true,
    });
    this.logWidget = blessed.log({
      parent: screen, top: 1, left: "34%", width: "66%", height: "100%-3",
      border: { type: "line" }, label: " Logs — select a task in the tree ",
      tags: true, keys: true, vi: true, scrollable: true, alwaysScroll: true,
      scrollbar: { ch: "│", style: { fg: "blue" } },
      style: { border: { fg: "gray" }, focus: { border: { fg: "white" } } },
      hidden: true,
    });
    this.registerKeys();
  }

  show(buildId: string): void {
    this.buildId = buildId;
    this.build = null;
    this.records = [];
    this.logCache.clear();
    this.collapsed.clear();
    this.expandedGroups.clear();
    this.treeItems = [];
    this.selectedLogId = null;
    this.followLog = true;
    this.pendingLines.clear();

    this.treeWidget.show();
    this.logWidget.show();
    (this.treeWidget as any).setItems([]);
    (this.logWidget as blessed.Widgets.Log).setContent("");
    this.logWidget.setLabel(" Logs — select a task in the tree ");
    this.treeWidget.focus();
    this.screen.render();

    const gen = ++this.pollGen;
    this.poll(buildId, gen);
  }

  hide(): void {
    this.pollGen++; // stop active poll loop
    this.treeWidget.hide();
    this.logWidget.hide();
  }

  getBuild(): Build | null { return this.build; }
  getBuildId(): string | null { return this.buildId; }

  private refreshTree(): void {
    const sel    = (this.treeWidget as any).selected as number ?? 0;
    const prevId = this.treeItems[sel]
      ? (this.treeItems[sel].kind === "group" ? this.treeItems[sel].id : (this.treeItems[sel] as RegularItem).record.id)
      : undefined;
    this.treeItems = buildFlatRunTree(this.records, this.collapsed, this.expandedGroups);
    (this.treeWidget as any).setItems(this.treeItems.map(runItemLabel));
    if (prevId) {
      const idx = this.treeItems.findIndex(t =>
        t.kind === "group" ? t.id === prevId : (t as RegularItem).record.id === prevId
      );
      if (idx >= 0) (this.treeWidget as any).select(idx);
    }
    this.screen.render();
  }

  private startSpinner(label: string): void {
    if (this.spinnerTimer) clearInterval(this.spinnerTimer);
    this.spinnerFrame = 0;
    this.spinnerTimer = setInterval(() => {
      const ch = this.SPINNER_FRAMES[this.spinnerFrame++ % this.SPINNER_FRAMES.length];
      this.logWidget.setLabel(` ${label}  {yellow-fg}${ch}{/} `);
      this.screen.render();
    }, 80);
  }

  private stopSpinner(label: string): void {
    if (this.spinnerTimer) { clearInterval(this.spinnerTimer); this.spinnerTimer = null; }
    this.logWidget.setLabel(` ${label} `);
    this.screen.render();
  }

  private selectLog(id: string): void {
    this.selectedLogId = id;
    const rec = this.records.find(r => r.id === id);
    const name = rec?.name ?? "Logs";
    (this.logWidget as blessed.Widgets.Log).setContent("");
    const srLines   = this.pendingLines.get(id) ?? [];
    const restLines = rec?.log?.id ? (this.logCache.get(rec.log.id) ?? []) : [];
    const allLines  = [...srLines, ...restLines];
    if (allLines.length > 0) {
      this.stopSpinner(name);
      for (const l of allLines) (this.logWidget as blessed.Widgets.Log).log(formatLogLine(l, this.keepTimestamps));
      this.followLog = true;
      (this.logWidget as any).setScrollPerc(100);
    } else {
      this.startSpinner(name);
    }
    this.screen.render();
  }

  private appendLines(logId: number, lines: string[], recordName: string): void {
    const existing = this.logCache.get(logId) ?? [];
    this.logCache.set(logId, [...existing, ...lines]);
    if (this.selectedLogId) {
      const rec = this.records.find(r => r.id === this.selectedLogId);
      if (rec?.log?.id === logId) {
        if (this.spinnerTimer) this.stopSpinner(recordName);
        for (const l of lines) (this.logWidget as blessed.Widgets.Log).log(formatLogLine(l, this.keepTimestamps));
        if (this.followLog) (this.logWidget as any).setScrollPerc(100);
        this.screen.render();
      }
    }
  }

  private handleSignalR(event: HubEvent): void {
    const { method, args } = event;
    if (["BuildUpdated", "TimelineUpdated", "TimelineRecordsUpdated", "timelineRecordsUpdated",
         "JobAssigned", "JobStarted", "JobCompleted"].includes(method)) {
      if (this.buildId) this.poll(this.buildId, this.pollGen);
      return;
    }
    if (method === "logConsoleLines") {
      const payload = args[0] as { lines?: string[]; stepRecordId?: string } | undefined;
      const lines   = payload?.lines;
      const recordId = payload?.stepRecordId;
      if (!lines?.length || !recordId) return;
      const rec = this.records.find(r => r.id === recordId);
      if (rec?.log?.id != null) {
        this.appendLines(rec.log.id, lines, rec.name);
      } else {
        const prev = this.pendingLines.get(recordId) ?? [];
        this.pendingLines.set(recordId, [...prev, ...lines]);
        if (this.selectedLogId === recordId) {
          const name = rec?.name ?? recordId;
          if (this.spinnerTimer) this.stopSpinner(name);
          for (const l of lines) (this.logWidget as blessed.Widgets.Log).log(formatLogLine(l, this.keepTimestamps));
          if (this.followLog) (this.logWidget as any).setScrollPerc(100);
          this.screen.render();
        }
      }
    }
  }

  private async setupSignalR(buildId: string): Promise<void> {
    if (this.signalRStarted) {
      if (this.signalRHandle) {
        try {
          const token = await this.ctx.getToken();
          const projectId = await fetchProjectId(this.ctx.org, this.ctx.project, token);
          this.signalRHandle.invoke("builddetailhub", "WatchBuild", projectId, Number(buildId));
        } catch { /* non-fatal */ }
      }
      return;
    }
    this.signalRStarted = true;
    try {
      const token = await this.ctx.getToken();
      const projectId = await fetchProjectId(this.ctx.org, this.ctx.project, token);
      this.signalRHandle = await connectSignalR(
        this.ctx.org, projectId, token,
        (e) => this.handleSignalR(e),
        (msg) => this.ctx.setStatus(msg, 5000),
        () => {
          this.signalRHandle = null;
          this.signalRStarted = false;
          this.ctx.setStatus(`SignalR: reconnecting in ${this.signalRDelay / 1000}s…`, 0);
          setTimeout(() => { if (this.buildId) this.setupSignalR(this.buildId); }, this.signalRDelay);
          this.signalRDelay = Math.min(this.signalRDelay * 2, 30_000);
        },
      );
      this.signalRDelay = 3_000;
      this.signalRHandle.invoke("builddetailhub", "WatchBuild", projectId, Number(buildId));
    } catch (e) {
      this.signalRStarted = false;
      this.ctx.setStatus(`SignalR: ${(e as Error).message.slice(0, 50)} — retry in ${this.signalRDelay / 1000}s`, 0);
      setTimeout(() => { if (this.buildId) this.setupSignalR(this.buildId); }, this.signalRDelay);
      this.signalRDelay = Math.min(this.signalRDelay * 2, 30_000);
    }
  }

  private async poll(buildId: string, gen: number): Promise<void> {
    if (gen !== this.pollGen) return;
    try {
      const token = await this.ctx.getToken();
      const [newBuild, timeline] = await Promise.all([
        fetchBuild(this.ctx.org, this.ctx.project, buildId, token),
        fetchTimeline(this.ctx.org, this.ctx.project, buildId, token),
      ]);
      if (gen !== this.pollGen) return;
      this.build = newBuild;
      if (timeline?.records) {
        this.records = timeline.records;
        this.refreshTree();
        for (const [stepId, lines] of [...this.pendingLines.entries()]) {
          const rec = this.records.find(r => r.id === stepId);
          if (rec?.log?.id != null) {
            const existing = this.logCache.get(rec.log.id) ?? [];
            this.logCache.set(rec.log.id, [...existing, ...lines]);
            this.pendingLines.delete(stepId);
          }
        }
      }
      if (!this.signalRStarted) this.setupSignalR(buildId);
      if (this.selectedLogId) {
        const rec = this.records.find(r => r.id === this.selectedLogId);
        if (rec?.log?.id) {
          const logId = rec.log.id;
          const seen  = this.logCache.get(logId)?.length ?? 0;
          const data  = await fetchLogLines(this.ctx.org, this.ctx.project, buildId, logId, seen + 1, token);
          if (data?.value?.length) this.appendLines(logId, data.value, rec.name);
        }
      }
    } catch (e) {
      if (gen === this.pollGen)
        this.ctx.setStatus((e as Error).message.slice(0, 60), 5000);
    }
    if (gen === this.pollGen) setTimeout(() => this.poll(buildId, gen), 1000);
  }

  private selectedItem(): FlatRunItem | undefined {
    const idx = (this.treeWidget as any).selected as number ?? 0;
    return this.treeItems[idx];
  }

  private registerKeys(): void {
    this.treeWidget.key(["enter", "right"], () => {
      const item = this.selectedItem();
      if (!item) return;
      if (item.kind === "group") {
        if (this.expandedGroups.has(item.id)) this.expandedGroups.delete(item.id);
        else this.expandedGroups.add(item.id);
        this.refreshTree();
        return;
      }
      if (item.hasChildren) {
        if (this.collapsed.has(item.record.id)) this.collapsed.delete(item.record.id);
        else this.collapsed.add(item.record.id);
        this.refreshTree();
      } else {
        this.selectLog(item.record.id);
      }
    });

    this.treeWidget.key("left", () => {
      const item = this.selectedItem();
      if (!item) return;
      if (item.kind === "group") {
        if (this.expandedGroups.has(item.id)) { this.expandedGroups.delete(item.id); this.refreshTree(); }
        return;
      }
      if (item.hasChildren && !this.collapsed.has(item.record.id)) {
        this.collapsed.add(item.record.id);
        this.refreshTree();
      } else if (item.record.parentId) {
        const pIdx = this.treeItems.findIndex(
          t => t.kind === "regular" && (t as RegularItem).record.id === item.record.parentId
        );
        if (pIdx >= 0) { (this.treeWidget as any).select(pIdx); this.screen.render(); }
      }
    });

    this.treeWidget.key("escape", () => this.ctx.goBack());

    this.treeWidget.key("r", async () => {
      const item = this.selectedItem();
      if (!item || item.kind !== "regular" || item.record.type !== "Stage") return;
      if (item.record.state !== "completed") {
        this.ctx.setStatus(`Stage "${item.record.name}" is not completed`, 3000);
        return;
      }
      const stageRef = item.record.identifier ?? item.record.name;
      const base = `https://dev.azure.com/${enc(this.ctx.org)}/${enc(this.ctx.project)}/_apis/build/builds/${this.buildId}`;
      this.ctx.setStatus(`Restarting "${item.record.name}"…`, 0);
      try {
        const token = await this.ctx.getToken();
        await httpPatch<unknown>(
          `${base}/stages/${encodeURIComponent(stageRef)}?${API_VER}`, token,
          { forceRetryAllJobs: true, state: 1, retryDependencies: true }
        );
        this.ctx.setStatus(`Stage "${item.record.name}" restarted`, 3000);
        if (this.buildId) this.poll(this.buildId, this.pollGen);
      } catch (e) {
        const raw = (e as Error).message;
        const match = raw.match(/^HTTP \d+: ([\s\S]+)/);
        let msg = raw;
        if (match) {
          try { msg = (JSON.parse(match[1]) as { message?: string }).message ?? match[1]; }
          catch { msg = match[1]; }
        }
        this.ctx.setStatus(`Restart failed: ${msg}`, 8000);
      }
    });

    this.logWidget.key(["escape", "backspace", "left"], () => {
      this.treeWidget.focus();
      this.screen.render();
    });

    this.logWidget.key(["f", "end"], () => {
      this.followLog = true;
      (this.logWidget as any).setScrollPerc(100);
      this.screen.render();
    });

    this.logWidget.on("scroll", () => {
      const lb = this.logWidget as unknown as { getScrollPerc(): number };
      if (lb.getScrollPerc() < 98) this.followLog = false;
    });
  }
}
