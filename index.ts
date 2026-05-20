#!/usr/bin/env node

import https from "https";
import { execSync } from "child_process";
import { URL } from "url";
import * as blessed from "blessed";
import { connectSignalR, type HubEvent, type SignalRHandle } from "./signalr.js";

// ── ADO API types ─────────────────────────────────────────────────────────────
type BuildStatus = "notStarted" | "inProgress" | "completed" | "cancelling" | "postponed";
type BuildResult = "succeeded" | "failed" | "canceled" | "partiallySucceeded";

interface Build {
  status: BuildStatus;
  result: BuildResult | null;
  startTime?: string;
  finishTime?: string;
  plans?: Array<{ planId: string }>;
}

interface LogRef { id: number; url: string; }

interface TimelineRecord {
  id: string;
  parentId?: string | null;
  type: string;
  name: string;
  state: "pending" | "inProgress" | "completed";
  result?: string;
  order?: number;
  log?: LogRef;
}

interface Timeline { records: TimelineRecord[]; }
interface LogContent { value: string[]; count: number; }
interface AzTokenResponse { accessToken: string; expiresOn: string; }

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);

interface AdoUrlParsed { org: string; project: string; buildId?: string; }

function parseAdoUrl(raw: string): AdoUrlParsed | null {
  try {
    const u = new URL(raw);
    if (u.hostname !== "dev.azure.com") return null;
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    const buildId = u.searchParams.get("buildId") ?? undefined;
    return { org: parts[0], project: parts[1], buildId };
  } catch { return null; }
}

function showHelp(exitCode: number): never {
  console.log(`
Azure Pipeline TUI

Usage:
  npx tsx index.ts <build-url>
  npx tsx index.ts https://dev.azure.com/<org>/<project> <buildId>
  npx tsx index.ts <org>/<project> <buildId>
  npx tsx index.ts <org> <project> <buildId>

Keys:
  ↑↓      Navigate tree / scroll logs
  Enter→  Expand/select
  ←Esc    Collapse / back to tree
  Tab     Switch focus between panels
  f       Follow mode (tail logs)
  q       Quit
`);
  process.exit(exitCode);
}

if (args.includes("--help")) showHelp(0);

const flags      = args.filter(a => a.startsWith("--"));
const positional = args.filter(a => !a.startsWith("--"));

let ORG: string, PROJECT: string, BUILD_ID: string;

const parsedUrl = positional.length >= 1 ? parseAdoUrl(positional[0]) : null;
if (parsedUrl && parsedUrl.buildId) {
  // Full build URL: https://dev.azure.com/org/project/_build/results?buildId=123
  ({ org: ORG, project: PROJECT, buildId: BUILD_ID } = parsedUrl as Required<AdoUrlParsed>);
} else if (parsedUrl && !parsedUrl.buildId && positional.length >= 2) {
  // Org/project URL + separate buildId: https://dev.azure.com/org/project 123
  ({ org: ORG, project: PROJECT } = parsedUrl);
  BUILD_ID = positional[1];
} else if (!parsedUrl && positional.length === 2 && positional[0].includes("/")) {
  // "org/project" + buildId
  const [org, ...rest] = positional[0].split("/");
  ORG = org;
  PROJECT = rest.join("/");
  BUILD_ID = positional[1];
} else if (positional.length >= 3) {
  [ORG, PROJECT, BUILD_ID] = positional;
} else {
  showHelp(1);
}

const KEEP_TIMESTAMPS = flags.includes("--keep-timestamps");
const ADO_RESOURCE    = "499b84ac-1321-427f-aa17-267ca6975798";
const ADO_BASE        = `https://dev.azure.com/${encodeURIComponent(ORG)}/${encodeURIComponent(PROJECT)}/_apis/build/builds/${BUILD_ID}`;
const API_VER         = "api-version=7.1";
const TIMESTAMP_RE    = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z /;
const ADO_CMD_RE      = /^##\[(\w+)\]/;

// ── Token management ──────────────────────────────────────────────────────────
let cachedToken: string | null = null;
let tokenExpiry = 0;

async function getToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiry - 60_000) return cachedToken;
  const raw = execSync(
    `az account get-access-token --resource ${ADO_RESOURCE} --output json`,
    { encoding: "utf8" }
  );
  const { accessToken, expiresOn } = JSON.parse(raw) as AzTokenResponse;
  cachedToken = accessToken;
  tokenExpiry  = new Date(expiresOn).getTime();
  return cachedToken;
}

// ── HTTP helper ───────────────────────────────────────────────────────────────
function httpGet<T>(reqUrl: string, token: string, accept = "application/json"): Promise<T> {
  return new Promise((resolve, reject) => {
    const u = new URL(reqUrl);
    https
      .get(
        { hostname: u.hostname, path: u.pathname + u.search,
          headers: { Authorization: `Bearer ${token}`, Accept: accept } },
        res => {
          let data = "";
          res.on("data", (c: string) => (data += c));
          res.on("end", () => {
            if ((res.statusCode ?? 0) >= 400)
              return reject(new Error(`HTTP ${res.statusCode}: ${data}`));
            resolve((accept === "application/json" ? JSON.parse(data) : data) as T);
          });
        }
      )
      .on("error", reject);
  });
}

// ── Tree helpers ──────────────────────────────────────────────────────────────
interface RegularItem {
  kind: "regular";
  record: TimelineRecord;
  depth: number;
  hasChildren: boolean;
  isExpanded: boolean;
}

interface GroupItem {
  kind: "group";
  id: string;           // synthetic id used in `collapsed`
  depth: number;
  count: number;
  label: string;        // e.g. "20 stages skipped"
  isExpanded: boolean;
}

type FlatItem = RegularItem | GroupItem;

// Returns true when a record and all its descendants are skipped/canceled
function isEntirelySkipped(r: TimelineRecord, byParent: Map<string | undefined, TimelineRecord[]>): boolean {
  if (r.result !== "skipped" && r.result !== "canceled") return false;
  return (byParent.get(r.id) ?? []).every(c => isEntirelySkipped(c, byParent));
}

function buildFlatTree(records: TimelineRecord[], collapsed: Set<string>): FlatItem[] {
  const knownIds = new Set(records.map(r => r.id));
  const byParent = new Map<string | undefined, TimelineRecord[]>();

  for (const r of records) {
    const key = r.parentId && knownIds.has(r.parentId) ? r.parentId : undefined;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(r);
  }
  for (const kids of byParent.values())
    kids.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  const result: FlatItem[] = [];

  function walk(parentId: string | undefined, depth: number) {
    const siblings = byParent.get(parentId) ?? [];
    let i = 0;
    while (i < siblings.length) {
      const r = siblings[i];

      // At any depth, group 2+ consecutive entirely-skipped siblings
      if (isEntirelySkipped(r, byParent)) {
        const groupStart = i;
        while (i < siblings.length && isEntirelySkipped(siblings[i], byParent)) i++;
        const groupRecords = siblings.slice(groupStart, i);

        if (groupRecords.length >= 2) {
          const typeName = depth === 0 ? "stages" : "steps";
          const groupId  = `__grp_${groupRecords[0].id}`;
          const isExpanded = !collapsed.has(groupId);
          result.push({ kind: "group", id: groupId, depth,
            count: groupRecords.length,
            label: `${groupRecords.length} ${typeName} skipped`,
            isExpanded });
          if (isExpanded) {
            for (const gr of groupRecords) {
              const hasChildren = (byParent.get(gr.id) ?? []).length > 0;
              result.push({ kind: "regular", record: gr, depth, hasChildren, isExpanded: !collapsed.has(gr.id) });
              if (hasChildren && !collapsed.has(gr.id)) walk(gr.id, depth + 1);
            }
          }
        } else {
          // Single skipped item – show normally
          const gr = groupRecords[0];
          const hasChildren = (byParent.get(gr.id) ?? []).length > 0;
          result.push({ kind: "regular", record: gr, depth, hasChildren, isExpanded: !collapsed.has(gr.id) });
          if (hasChildren && !collapsed.has(gr.id)) walk(gr.id, depth + 1);
        }
      } else {
        const kids = byParent.get(r.id) ?? [];
        const hasChildren = kids.length > 0;
        const isExpanded  = !collapsed.has(r.id);
        result.push({ kind: "regular", record: r, depth, hasChildren, isExpanded });
        if (hasChildren && isExpanded) walk(r.id, depth + 1);
        i++;
      }
    }
  }
  walk(undefined, 0);
  return result;
}

function itemLabel(item: FlatItem): string {
  const indent = "  ".repeat(item.depth);

  if (item.kind === "group") {
    const caret = item.isExpanded ? "{gray-fg}▼{/} " : "{gray-fg}▶{/} ";
    return `${indent}${caret}{gray-fg}⊘ ${item.label}{/}`;
  }

  const { record: r, hasChildren, isExpanded } = item;
  const caret = hasChildren ? (isExpanded ? "{gray-fg}▼{/} " : "{gray-fg}▶{/} ") : "  ";

  let icon: string, color: string;
  if (r.type === "Checkpoint.Approval") {
    icon  = r.state === "completed" ? "✓" : "⏸";
    color = r.state === "inProgress" ? "yellow" : r.result === "succeeded" ? "green" : "gray";
  } else if (r.type === "Checkpoint") {
    icon = "⬡"; color = "gray";
  } else if (r.state === "pending")         { icon = "○"; color = "gray";   }
  else if (r.state === "inProgress")        { icon = "▶"; color = "yellow"; }
  else if (r.result === "succeeded")        { icon = "✓"; color = "green";  }
  else if (r.result === "failed")           { icon = "✗"; color = "red";    }
  else if (r.result === "skipped")          { icon = "⊘"; color = "gray";   }
  else if (r.result === "canceled")         { icon = "⊘"; color = "gray";   }
  else                                      { icon = "?"; color = "white";  }

  return `${indent}${caret}{${color}-fg}${icon}{/} ${r.name}`;
}

// ── Log line formatting ───────────────────────────────────────────────────────
function formatLogLine(raw: string): string {
  const line = KEEP_TIMESTAMPS ? raw : raw.replace(TIMESTAMP_RE, "");
  const m = ADO_CMD_RE.exec(line);
  if (!m) return line;
  const rest = line.slice(m[0].length);
  switch (m[1]) {
    case "error":   return `{red-fg}✗ ${rest}{/}`;
    case "warning": return `{yellow-fg}⚠ ${rest}{/}`;
    case "section": return `{cyan-fg}{bold}── ${rest} ──{/}`;
    case "command": return `{blue-fg}$ ${rest}{/}`;
    case "group":   return `{magenta-fg}▼ ${rest}{/}`;
    case "endgroup":return `{gray-fg}── end ──{/}`;
    default:        return `{gray-fg}[${m[1]}]{/} ${rest}`;
  }
}

// ── TUI ───────────────────────────────────────────────────────────────────────
async function main() {
  // App state
  let build: Build | null = null;
  let records: TimelineRecord[] = [];
  const logCache   = new Map<number, string[]>();  // logId → all lines seen
  const collapsed  = new Set<string>();
  let treeItems: FlatItem[] = [];
  let selectedId: string | null = null;
  let followLog = true;
  let spinnerTimer: ReturnType<typeof setInterval> | null = null;
  let spinnerFrame = 0;
  const SPINNER_FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
  let signalRHandle: SignalRHandle | null = null;
  let signalRStarted = false;
  let reconnectDelay = 3_000;
  // Lines received from SignalR before rec.log.id is known; flushed to logCache on next poll
  const pendingLines = new Map<string, string[]>();

  // ── Screen ────────────────────────────────────────────────────────────────
  const screen = blessed.screen({
    smartCSR: true,
    title: `Azure Pipelines #${BUILD_ID}`,
    fullUnicode: true,
    forceUnicode: true,
  });

  // Hide the terminal cursor for the duration of the TUI
  process.stdout.write("\x1b[?25l");
  const restoreCursor = () => process.stdout.write("\x1b[?25h");
  screen.on("destroy", restoreCursor);
  process.on("exit", restoreCursor);
  process.on("SIGINT", () => { restoreCursor(); process.exit(0); });

  // ── Header ────────────────────────────────────────────────────────────────
  const header = blessed.box({
    parent: screen,
    top: 0, left: 0,
    width: "100%", height: 1,
    tags: true,
    style: { bg: "blue", fg: "white", bold: true },
    content: ` {bold}Azure Pipelines{/bold}  ${ORG} / ${PROJECT}  #${BUILD_ID}  {yellow-fg}loading…{/}`,
  });

  // ── Tree list ─────────────────────────────────────────────────────────────
  const treeList = blessed.list({
    parent: screen,
    top: 1, left: 0,
    width: "34%", height: "100%-3",
    border: { type: "line" },
    label: " Pipeline ",
    tags: true,
    keys: true,
    vi: true,
    scrollable: true,
    scrollbar: { ch: "│", style: { fg: "blue" } },
    style: {
      border:   { fg: "cyan" },
      selected: { bg: "blue", fg: "white", bold: true },
      item:     { fg: "white" },
      focus:    { border: { fg: "white" } },
    },
    items: [],
  });

  // ── Log box ───────────────────────────────────────────────────────────────
  const logBox = blessed.log({
    parent: screen,
    top: 1, left: "34%",
    width: "66%", height: "100%-3",
    border: { type: "line" },
    label: " Logs — select a task in the tree ",
    tags: true,
    keys: true,
    vi: true,
    scrollable: true,
    alwaysScroll: true,
    scrollbar: { ch: "│", style: { fg: "blue" } },
    style: {
      border: { fg: "gray" },
      focus:  { border: { fg: "white" } },
    },
  });

  // ── Footer ────────────────────────────────────────────────────────────────
  const footer = blessed.box({
    parent: screen,
    bottom: 0, left: 0,
    width: "100%", height: 1,
    tags: true,
    style: { bg: "black", fg: "gray" },
    content:
      " {cyan-fg}↑↓{/} Navigate  {cyan-fg}Enter/→{/} Select  {cyan-fg}←/Esc{/} Back  " +
      "{cyan-fg}Tab{/} Switch panel  {cyan-fg}f{/} Follow  {cyan-fg}q{/} Quit",
  });

  screen.render();

  // ── Helpers ───────────────────────────────────────────────────────────────
  function itemId(item: FlatItem): string {
    return item.kind === "group" ? item.id : item.record.id;
  }

  function refreshTree() {
    const sel    = (treeList as blessed.Widgets.ListElement & { selected: number }).selected ?? 0;
    const prevId = treeItems[sel] ? itemId(treeItems[sel]) : undefined;

    treeItems = buildFlatTree(records, collapsed);
    (treeList as blessed.Widgets.ListElement).setItems(treeItems.map(itemLabel) as unknown as string[]);

    if (prevId) {
      const idx = treeItems.findIndex(t => itemId(t) === prevId);
      if (idx >= 0) (treeList as blessed.Widgets.ListElement).select(idx);
    }
    screen.render();
  }

  function updateHeader() {
    if (!build) return;
    const statusTag =
      build.status === "completed"
        ? build.result === "succeeded"   ? "{green-fg}succeeded{/}"
        : build.result === "failed"      ? "{red-fg}failed{/}"
        : build.result === "canceled"    ? "{gray-fg}canceled{/}"
        :                                  (build.result ?? "completed")
      : build.status === "inProgress"   ? "{yellow-fg}▶ running{/}"
      : build.status === "notStarted"   ? "{gray-fg}waiting…{/}"
      :                                    build.status;

    header.setContent(
      ` {bold}Azure Pipelines{/bold}  ${ORG} / ${PROJECT}  #{bold}${BUILD_ID}{/bold}  ${statusTag}`
    );
    screen.render();
  }

  function updateFooter(msg?: string) {
    const live  = followLog && selectedId ? "  {green-fg}● LIVE{/}" : "";
    const base  =
      " {cyan-fg}↑↓{/} Navigate  {cyan-fg}Enter/→{/} Select  {cyan-fg}←/Esc{/} Back  " +
      "{cyan-fg}Tab{/} Switch  {cyan-fg}f{/} Follow  {cyan-fg}q{/} Quit";
    footer.setContent(base + live + (msg ? `  {red-fg}${msg}{/}` : ""));
    screen.render();
  }

  function startSpinner(label: string) {
    if (spinnerTimer) clearInterval(spinnerTimer);
    spinnerFrame = 0;
    spinnerTimer = setInterval(() => {
      const ch = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length];
      spinnerFrame++;
      logBox.setLabel(` ${label}  {yellow-fg}${ch}{/} `);
      screen.render();
    }, 80);
  }

  function stopSpinner(label: string) {
    if (spinnerTimer) { clearInterval(spinnerTimer); spinnerTimer = null; }
    logBox.setLabel(` ${label} `);
    screen.render();
  }

  function selectRecord(id: string) {
    selectedId = id;
    const rec = records.find(r => r.id === id);
    const name = rec?.name ?? "Logs";
    (logBox as blessed.Widgets.Log).setContent("");

    const restLines = rec?.log?.id ? (logCache.get(rec.log.id) ?? []) : [];
    const srLines   = pendingLines.get(id) ?? [];
    const allLines  = [...srLines, ...restLines];

    if (allLines.length > 0) {
      stopSpinner(name);
      for (const l of allLines)
        (logBox as blessed.Widgets.Log).log(formatLogLine(l));
      followLog = true;
      (logBox as blessed.Widgets.Log & { setScrollPerc(n: number): void }).setScrollPerc(100);
    } else {
      startSpinner(name);
    }
    updateFooter();
    screen.render();
  }

  // ── Keyboard: global ──────────────────────────────────────────────────────
  screen.key(["q", "C-c"], () => { screen.destroy(); process.exit(0); });

  screen.key("tab", () => {
    if (screen.focused === treeList) {
      logBox.focus();
    } else {
      treeList.focus();
    }
    screen.render();
  });

  // ── Keyboard: tree ────────────────────────────────────────────────────────
  treeList.key(["enter", "right"], () => {
    const sel  = (treeList as blessed.Widgets.ListElement & { selected: number }).selected ?? 0;
    const item = treeItems[sel];
    if (!item) return;

    if (item.kind === "group") {
      // Toggle the skipped group
      if (collapsed.has(item.id)) collapsed.delete(item.id);
      else collapsed.add(item.id);
      refreshTree();
      return;
    }

    if (item.hasChildren) {
      if (collapsed.has(item.record.id)) collapsed.delete(item.record.id);
      else collapsed.add(item.record.id);
      refreshTree();
    } else {
      selectRecord(item.record.id);
    }
  });

  treeList.key("left", () => {
    const sel  = (treeList as blessed.Widgets.ListElement & { selected: number }).selected ?? 0;
    const item = treeItems[sel];
    if (!item) return;

    if (item.kind === "group") {
      if (!collapsed.has(item.id)) { collapsed.add(item.id); refreshTree(); }
      return;
    }

    if (item.hasChildren && !collapsed.has(item.record.id)) {
      collapsed.add(item.record.id);
      refreshTree();
    } else if (item.record.parentId) {
      const pIdx = treeItems.findIndex(
        t => t.kind === "regular" && t.record.id === item.record.parentId
      );
      if (pIdx >= 0) {
        (treeList as blessed.Widgets.ListElement).select(pIdx);
        screen.render();
      }
    }
  });

  // ── Keyboard: log ─────────────────────────────────────────────────────────
  logBox.key(["escape", "backspace", "left"], () => {
    treeList.focus();
    screen.render();
  });

  logBox.key(["f", "end"], () => {
    followLog = true;
    (logBox as blessed.Widgets.Log & { setScrollPerc(n: number): void }).setScrollPerc(100);
    updateFooter();
    screen.render();
  });

  // Detect manual scroll-up to disable follow mode
  logBox.on("scroll", () => {
    const lb = logBox as unknown as { getScrollPerc(): number };
    if (lb.getScrollPerc() < 98) {
      followLog = false;
      updateFooter();
    }
  });

  treeList.focus();

  // ── SignalR ───────────────────────────────────────────────────────────────
  function appendLogLines(logId: number, lines: string[], recordName: string) {
    const existing = logCache.get(logId) ?? [];
    logCache.set(logId, [...existing, ...lines]);
    if (selectedId) {
      const rec = records.find(r => r.id === selectedId);
      if (rec?.log?.id === logId) {
        if (spinnerTimer) stopSpinner(recordName);
        for (const l of lines)
          (logBox as blessed.Widgets.Log).log(formatLogLine(l));
        if (followLog)
          (logBox as blessed.Widgets.Log & { setScrollPerc(n: number): void }).setScrollPerc(100);
        screen.render();
      }
    }
  }

  function handleSignalREvent(event: HubEvent) {
    const { method, args } = event;

    if (["BuildUpdated", "TimelineUpdated", "TimelineRecordsUpdated", "timelineRecordsUpdated",
         "JobAssigned", "JobStarted", "JobCompleted"].includes(method)) {
      poll();
      return;
    }

    // Confirmed SignalR method: logConsoleLines
    // args[0] = { lines: string[], stepRecordId: string, timelineRecordId: string, buildId: number }
    if (method === "logConsoleLines") {
      const payload = args[0] as { lines?: string[]; stepRecordId?: string } | undefined;
      const lines    = payload?.lines;
      const recordId = payload?.stepRecordId;
      if (!lines?.length || !recordId) return;
      const rec = records.find(r => r.id === recordId);
      if (rec?.log?.id != null) {
        appendLogLines(rec.log.id, lines, rec.name);
      } else {
        // log.id not yet assigned in timeline — buffer until next poll
        const prev = pendingLines.get(recordId) ?? [];
        pendingLines.set(recordId, [...prev, ...lines]);
        if (selectedId === recordId) {
          const name = rec?.name ?? recordId;
          if (spinnerTimer) stopSpinner(name);
          for (const l of lines)
            (logBox as blessed.Widgets.Log).log(formatLogLine(l));
          if (followLog)
            (logBox as blessed.Widgets.Log & { setScrollPerc(n: number): void }).setScrollPerc(100);
          screen.render();
        }
      }
    }
  }

  async function setupSignalR() {
    if (signalRStarted) return;
    signalRStarted = true;
    try {
      const token = await getToken();
      const { id: projectId } = await httpGet<{ id: string }>(
        `https://dev.azure.com/${encodeURIComponent(ORG)}/_apis/projects/${encodeURIComponent(PROJECT)}?${API_VER}`,
        token
      );
      signalRHandle = await connectSignalR(
        ORG, projectId, token,
        handleSignalREvent,
        (msg) => updateFooter(msg),
        () => {
          signalRHandle = null;
          signalRStarted = false;
          updateFooter(`SignalR: reconnecting in ${reconnectDelay / 1000}s…`);
          setTimeout(setupSignalR, reconnectDelay);
          reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
        },
      );
      reconnectDelay = 3_000;
      // Signature confirmed: WatchBuild(projectId: Guid, buildId: Int32)
      signalRHandle.invoke("builddetailhub", "WatchBuild", projectId, Number(BUILD_ID));
    } catch (e) {
      signalRStarted = false;
      updateFooter(`SignalR: ${(e as Error).message.slice(0, 50)} — retry in ${reconnectDelay / 1000}s`);
      setTimeout(setupSignalR, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
    }
  }

  // ── Polling ───────────────────────────────────────────────────────────────
  async function poll() {
    try {
      const token = await getToken();

      const [newBuild, timeline] = await Promise.all([
        httpGet<Build>(`${ADO_BASE}?${API_VER}`, token),
        httpGet<Timeline>(`${ADO_BASE}/timeline?${API_VER}`, token).catch(() => null),
      ]);

      const statusChanged = newBuild.status !== build?.status || newBuild.result !== build?.result;
      build = newBuild;
      if (statusChanged) updateHeader();

      if (timeline?.records) {
        records = timeline.records;
        refreshTree();

        // Flush SignalR lines buffered before rec.log.id was known
        for (const [stepRecordId, lines] of [...pendingLines.entries()]) {
          const rec = records.find(r => r.id === stepRecordId);
          if (rec?.log?.id != null) {
            const existing = logCache.get(rec.log.id) ?? [];
            logCache.set(rec.log.id, [...existing, ...lines]);
            pendingLines.delete(stepRecordId);
            // If this record is selected, lines are already on screen from when they arrived
          }
        }
      }

      // Start SignalR once we have a successful poll (so build.plans is available)
      if (!signalRStarted) setupSignalR();

      // Fetch log lines via REST — still needed until we know SignalR delivers them
      if (selectedId) {
        const rec = records.find(r => r.id === selectedId);
        if (rec?.log?.id) {
          const logId = rec.log.id;
          const seen  = logCache.get(logId)?.length ?? 0;
          const data  = await httpGet<LogContent>(
            `${ADO_BASE}/logs/${logId}?startLine=${seen + 1}&${API_VER}`,
            token
          ).catch(() => null);

          if (data?.value?.length)
            appendLogLines(logId, data.value, rec.name);
        }
      }

    } catch (e) {
      updateFooter((e as Error).message.slice(0, 60));
    }

    setTimeout(poll, 500);
  }

  poll();
}

main().catch(err => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
