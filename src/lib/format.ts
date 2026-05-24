// Formatting, tree building, and helper functions

import type {
  EnvRow, EnvTreeNode, FlatEnvItem, PipelineDefinition, PipeTreeNode, FlatPipeItem,
  PipelineRun, StageInfo, RunStageEntry, StageBranchSummary, TimelineRecord, FlatRunItem, RegularItem,
} from "./types.js";

// ── Basic formatting ──────────────────────────────────────────────────────────

export function padEnd(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

export function timeAgo(dateStr?: string): string {
  if (!dateStr) return "-";
  const utc = /Z|[+-]\d\d:\d\d$/.test(dateStr) ? dateStr : dateStr + "Z";
  const diff = Date.now() - new Date(utc).getTime();
  if (diff < 0) return "now";
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function shortBranch(branch?: string): string {
  if (!branch) return "-";
  return branch.replace(/^refs\/heads\//, "").replace(/^refs\/tags\//, "");
}

const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z /;
const ADO_CMD_RE = /^##\[(\w+)\]/;

export function formatLogLine(raw: string, keepTimestamps = false): string {
  const line = keepTimestamps ? raw : raw.replace(TIMESTAMP_RE, "");
  const m = ADO_CMD_RE.exec(line);
  if (!m) return line;
  const rest = line.slice(m[0].length);
  switch (m[1]) {
    case "error":    return `{red-fg}✗ ${rest}{/}`;
    case "warning":  return `{yellow-fg}⚠ ${rest}{/}`;
    case "section":  return `{cyan-fg}{bold}── ${rest} ──{/}`;
    case "command":  return `{blue-fg}$ ${rest}{/}`;
    case "group":    return `{magenta-fg}▼ ${rest}{/}`;
    case "endgroup": return `{gray-fg}── end ──{/}`;
    default:         return `{gray-fg}[${m[1]}]{/} ${rest}`;
  }
}

// ── Environment tree ──────────────────────────────────────────────────────────

export const LEFT_COL = 36;

export function buildEnvTree(rows: EnvRow[]): EnvTreeNode {
  const root: EnvTreeNode = { key: "", label: "", children: new Map() };
  for (const row of rows) {
    const segs = row.env.name.split("-");
    let node = root;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      const key = segs.slice(0, i + 1).join("-");
      if (!node.children.has(seg))
        node.children.set(seg, { key, label: seg, children: new Map() });
      node = node.children.get(seg)!;
    }
    node.row = row;
  }
  return root;
}

export function countDescendantStats(node: EnvTreeNode): { total: number; ok: number; fail: number } {
  let total = 0, ok = 0, fail = 0;
  for (const child of node.children.values()) {
    if (child.children.size === 0 && child.row) {
      total++;
      const r = child.row.deploy?.result;
      if (r === "succeeded") ok++;
      else if (r === "failed") fail++;
    } else {
      const s = countDescendantStats(child);
      total += s.total; ok += s.ok; fail += s.fail;
    }
  }
  return { total, ok, fail };
}

export function flattenEnvTree(
  node: EnvTreeNode, collapsed: Set<string>, depth: number, items: FlatEnvItem[]
): void {
  const children = [...node.children.values()].sort((a, b) => a.label.localeCompare(b.label));
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const isLast = i === children.length - 1;
    if (child.children.size === 0) {
      if (child.row) items.push({ kind: "leaf", key: child.key, label: child.label, depth, row: child.row, isLast });
    } else {
      const stats = countDescendantStats(child);
      const isExpanded = !collapsed.has(child.key);
      items.push({ kind: "group", key: child.key, label: child.label, depth, isExpanded, ...stats, ownRow: child.row });
      if (isExpanded) flattenEnvTree(child, collapsed, depth + 1, items);
    }
  }
}

export function envColHeaderStr(): string {
  return padEnd("  Environments", LEFT_COL) + " " + padEnd("Pipeline", 36) + " " +
    padEnd("Status", 12) + " " + padEnd("Branch", 20) + " Age";
}

function rowColumns(row: EnvRow): string {
  let pipLine: string; let pipColor: string;
  if (row.mapping) {
    pipLine = padEnd(`${row.mapping.pipelineName} [cfg]`, 36); pipColor = "cyan";
  } else if (row.deploy) {
    pipLine = padEnd(`${row.deploy.definition.name} [auto]`, 36); pipColor = "gray";
  } else {
    pipLine = padEnd("- [none]", 36); pipColor = "gray";
  }
  let stText: string; let stColor: string;
  if (row.loading) {
    stText = padEnd("loading…", 12); stColor = "gray";
  } else if (!row.deploy) {
    stText = padEnd("no deploys", 12); stColor = "gray";
  } else {
    switch (row.deploy.result) {
      case "succeeded":          stText = padEnd("✓ ok", 12);       stColor = "green";  break;
      case "failed":             stText = padEnd("✗ failed", 12);   stColor = "red";    break;
      case "canceled":           stText = padEnd("⊘ canceled", 12); stColor = "gray";   break;
      case "partiallySucceeded": stText = padEnd("⚠ partial", 12);  stColor = "yellow"; break;
      default:                   stText = padEnd(row.deploy.result ?? "?", 12); stColor = "white";
    }
  }
  const branch = padEnd(shortBranch(row.build?.sourceBranch), 20);
  const age = timeAgo(row.deploy?.finishTime ?? row.deploy?.startTime);
  return ` {${pipColor}-fg}${pipLine}{/} {${stColor}-fg}${stText}{/} {gray-fg}${branch}{/} ${age}`;
}

export function formatEnvItem(item: FlatEnvItem): string {
  const indent = "  ".repeat(item.depth);
  if (item.kind === "group") {
    const pfx = indent + (item.isExpanded ? "▼ " : "▶ ");
    const label = padEnd(item.label, Math.max(1, LEFT_COL - 1 - pfx.length));
    const left = " " + pfx + label;
    if (item.ownRow) {
      const childBadge = item.total > 0 ? `  {gray-fg}(+${item.total}){/}` : "";
      return `{bold}${left}{/}${rowColumns(item.ownRow)}${childBadge}`;
    }
    let stats = "";
    if (item.ok > 0)   stats += `{green-fg}${item.ok}✓{/} `;
    if (item.fail > 0) stats += `{red-fg}${item.fail}✗{/} `;
    const other = item.total - item.ok - item.fail;
    if (other > 0)     stats += `{gray-fg}${other}…{/}`;
    if (!stats && item.total === 0) stats = `{gray-fg}empty{/}`;
    const pipeBlank = " " + " ".repeat(36);
    return `{bold}${left}{/}${pipeBlank} ${stats.trim()}`;
  }
  const pfx = indent + (item.isLast ? "└─ " : "├─ ");
  const label = padEnd(item.label, Math.max(1, LEFT_COL - 1 - pfx.length));
  return " " + pfx + label + rowColumns(item.row);
}

// ── Pipeline tree ─────────────────────────────────────────────────────────────

export const PIPE_LEFT_COL = 52;

export function buildPipeTree(defs: PipelineDefinition[]): PipeTreeNode {
  const root: PipeTreeNode = { key: "", label: "", children: new Map() };
  for (const p of defs) {
    const segs = p.path.split("\\").filter(Boolean);
    let node = root;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      const key = "\\" + segs.slice(0, i + 1).join("\\");
      if (!node.children.has(seg))
        node.children.set(seg, { key, label: seg, children: new Map() });
      node = node.children.get(seg)!;
    }
    const leafKey = (node.key || "") + "\\" + p.id;
    node.children.set(String(p.id), { key: leafKey, label: p.name, children: new Map(), pipeline: p });
  }
  return root;
}

export function countPipeDescendants(node: PipeTreeNode): number {
  let n = 0;
  for (const child of node.children.values())
    n += child.pipeline ? 1 : countPipeDescendants(child);
  return n;
}

export function flattenPipeTree(
  node: PipeTreeNode, collapsed: Set<string>, depth: number, items: FlatPipeItem[]
): void {
  const children = [...node.children.values()].sort((a, b) => {
    const af = !a.pipeline, bf = !b.pipeline;
    if (af !== bf) return af ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child.pipeline) {
      items.push({ kind: "pipeline", key: child.key, label: child.label, depth, pipeline: child.pipeline, isLast: i === children.length - 1 });
    } else {
      const isExpanded = !collapsed.has(child.key);
      items.push({ kind: "folder", key: child.key, label: child.label, depth, isExpanded, count: countPipeDescendants(child) });
      if (isExpanded) flattenPipeTree(child, collapsed, depth + 1, items);
    }
  }
}

export function formatPipeItem(item: FlatPipeItem): string {
  const indent = "  ".repeat(item.depth);
  if (item.kind === "folder") {
    const pfx = indent + (item.isExpanded ? "▼ " : "▶ ");
    return `{bold} ${pfx}${item.label}{/}  {gray-fg}(${item.count}){/}`;
  }
  const pfx = indent + (item.isLast ? "└─ " : "├─ ");
  const label = padEnd(item.label, Math.max(1, PIPE_LEFT_COL - pfx.length));
  return ` ${pfx}${label}  {gray-fg}${item.pipeline.id}{/}`;
}

// ── Pipeline runs list ────────────────────────────────────────────────────────

export function formatRunItem(run: PipelineRun): string {
  let resultStr: string;
  if (run.status === "completed") {
    switch (run.result) {
      case "succeeded":          resultStr = "{green-fg}✓ succeeded{/}";  break;
      case "failed":             resultStr = "{red-fg}✗ failed{/}";       break;
      case "canceled":           resultStr = "{gray-fg}⊘ canceled{/}";    break;
      case "partiallySucceeded": resultStr = "{yellow-fg}⚠ partial{/}";   break;
      default:                   resultStr = `{gray-fg}${run.result ?? "?"}{/}`;
    }
  } else if (run.status === "inProgress") {
    resultStr = "{yellow-fg}▶ running{/}";
  } else {
    resultStr = `{gray-fg}${run.status}{/}`;
  }
  const num    = padEnd(`#${run.buildNumber}`, 10);
  const branch = padEnd(shortBranch(run.sourceBranch), 30);
  const age    = timeAgo(run.startTime);
  return ` ${num}  {gray-fg}${branch}{/}  ${padEnd(resultStr, 30)}  {gray-fg}${age}{/}`;
}

// ── Stage helpers ─────────────────────────────────────────────────────────────

export const BRANCH_COL = 30;
export const PLAN_COL   = 22;
export const APPLY_COL  = 22;

export function parseStageKind(name: string, planBases?: Set<string>): { kind: "plan" | "apply" | "other"; base: string } {
  const pm = name.match(/^plan(.*)$/i);
  if (pm) return { kind: "plan", base: pm[1].replace(/^[_\-\s]+/, "") };
  const am = name.match(/^(?:apply|deploy)(.*)$/i);
  if (am) return { kind: "apply", base: am[1].replace(/^[_\-\s]+/, "") };
  if (planBases?.has(name.toLowerCase())) return { kind: "plan", base: name };
  return { kind: "other", base: name };
}

export function buildStageBranchSummaries(
  runs: PipelineRun[],
  stagesMap: Map<number, StageInfo[]>
): Array<{ displayName: string; branches: Map<string, StageBranchSummary> }> {
  const planBases = new Set<string>();
  for (const run of runs)
    for (const stage of (stagesMap.get(run.id) ?? [])) {
      const m = stage.name.match(/^(?:apply|deploy)\s+(.+)$/i);
      if (m) planBases.add(m[1].trim().toLowerCase());
    }
  const baseOrder: string[] = [];
  const basePlanName  = new Map<string, string>();
  const baseApplyName = new Map<string, string>();
  const summaries = new Map<string, Map<string, StageBranchSummary>>();
  for (const run of runs) {
    const branch = shortBranch(run.sourceBranch);
    for (const stage of (stagesMap.get(run.id) ?? [])) {
      const { kind, base } = parseStageKind(stage.name, planBases);
      const key = kind === "other" ? `\x00${base}` : base;
      if (!summaries.has(key)) { summaries.set(key, new Map()); baseOrder.push(key); }
      if (kind === "plan"  && !basePlanName.has(key))  basePlanName.set(key,  stage.name);
      if (kind === "apply" && !baseApplyName.has(key)) baseApplyName.set(key, stage.name);
      const branchMap = summaries.get(key)!;
      if (!branchMap.has(branch)) branchMap.set(branch, { branch });
      const s = branchMap.get(branch)!;
      const entry: RunStageEntry = { runId: run.id, result: stage.result, state: stage.state, finishTime: stage.finishTime, warningCount: stage.warningCount };
      const isPassive = (r?: string) => r === "skipped" || r === "canceled";
      const isActive  = (r?: string) => !!r && !isPassive(r);
      if (kind === "apply") {
        if (!s.applyLatest) { s.applyLatest = entry; }
        else if (!isActive(s.applyLatest.result) && !s.applyPrevActive && isActive(entry.result))
          s.applyPrevActive = entry;
        else if (!s.applyPrevOk) {
          const eff = s.applyPrevActive ?? s.applyLatest;
          if (eff.result !== "succeeded" && entry.result === "succeeded") s.applyPrevOk = entry;
        }
      } else {
        if (!s.planLatest) { s.planLatest = entry; }
        else if (!isActive(s.planLatest.result) && !s.planPrevActive && isActive(entry.result))
          s.planPrevActive = entry;
        else if (!s.planPrevOk) {
          const eff = s.planPrevActive ?? s.planLatest;
          if (eff.result !== "succeeded" && entry.result === "succeeded") s.planPrevOk = entry;
        }
      }
    }
  }
  return baseOrder
    .map(key => {
      const isOther = key.startsWith("\x00");
      const base    = isOther ? key.slice(1) : key;
      const plan    = basePlanName.get(key);
      const apply   = baseApplyName.get(key);
      const displayName = base || (plan && apply ? `${plan} / ${apply}` : (plan ?? apply ?? key));
      return { displayName, branches: summaries.get(key)! };
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export function branchHasRun(summary: StageBranchSummary): boolean {
  const eff = (e?: RunStageEntry) => !!e && e.result !== "skipped" && e.result !== "canceled";
  return eff(summary.planLatest) || eff(summary.applyLatest)
    || !!summary.planPrevActive || !!summary.applyPrevActive
    || !!summary.planPrevOk    || !!summary.applyPrevOk;
}

export function statusCell(entry?: RunStageEntry, prevOk?: RunStageEntry, W = PLAN_COL, dim = false, prevActive?: RunStageEntry): string {
  if (!entry) return padEnd("-", W);
  if (entry.result === "skipped" || entry.result === "canceled") {
    const display = prevActive ?? prevOk;
    if (display) {
      const age = timeAgo(display.finishTime);
      const warnings = (display.warningCount ?? 0) > 0;
      let icon: string; let color: string;
      if (display.result === "failed")  { icon = "✗"; color = "red";      }
      else if (warnings)               { icon = "⚠"; color = "#ff8700";  }
      else                             { icon = "✓"; color = "green";     }
      const mainStr = `${icon} ${age}`;
      const fallback = (prevActive && display.result !== "succeeded" && prevOk)
        ? `(✓${timeAgo(prevOk.finishTime)})` : "";
      const starFull = ` *${fallback}`;
      const pad = Math.max(0, W - mainStr.length - starFull.length);
      return `{${color}-fg}${mainStr}{/}{gray-fg}${starFull}{/}${" ".repeat(pad)}`;
    }
  }
  let icon: string; let color: string;
  if (entry.state === "inProgress")                                         { icon = "▶"; color = "yellow";   }
  else if (entry.result === "succeeded" && (entry.warningCount ?? 0) > 0)  { icon = "⚠"; color = "#ff8700"; }
  else if (entry.result === "succeeded")                                    { icon = "✓"; color = "green";    }
  else if (entry.result === "failed")                                       { icon = "✗"; color = "red";      }
  else if (entry.result === "skipped" || entry.result === "canceled")      { icon = "⊘"; color = "gray";     }
  else if (entry.state === "pending")                                       { icon = "○"; color = "gray";     }
  else                                                                      { icon = "?"; color = "white";    }
  const age = timeAgo(entry.finishTime);
  const mainStr = `${icon} ${age}`;
  const dimColor: Record<string, string> = { green: "#005f00", red: "#5f0000", yellow: "#5f5f00", "#ff8700": "#5f3000", gray: "#3a3a3a", white: "#3a3a3a" };
  const wrap = (s: string, c: string) => dim ? `{${dimColor[c] ?? "#3a3a3a"}-fg}${s}{/}` : `{${c}-fg}${s}{/}`;
  if ((entry.state === "inProgress" || entry.state === "pending") && prevActive) {
    const pAge = timeAgo(prevActive.finishTime);
    const pWarn = (prevActive.warningCount ?? 0) > 0;
    let pIcon: string; let pColor: string;
    if (prevActive.result === "failed")  { pIcon = "✗"; pColor = "red";     }
    else if (pWarn)                      { pIcon = "⚠"; pColor = "#ff8700"; }
    else                                 { pIcon = "✓"; pColor = "green";   }
    const prevPart = `(${pIcon}${pAge})`;
    const pad = Math.max(0, W - mainStr.length - 1 - prevPart.length);
    return `${wrap(mainStr, color)} ${wrap(prevPart, pColor)}${" ".repeat(pad)}`;
  }
  let prevStr = "";
  if (prevOk && entry.result !== "succeeded")
    prevStr = ` (✓${timeAgo(prevOk.finishTime)})`;
  const pad = Math.max(0, W - mainStr.length - prevStr.length);
  return `${wrap(mainStr, color)}${prevStr ? wrap(prevStr, "gray") : ""}${" ".repeat(pad)}`;
}

// ── Run tree helpers ──────────────────────────────────────────────────────────

export function isEntirelySkipped(r: TimelineRecord, byParent: Map<string | undefined, TimelineRecord[]>): boolean {
  if (r.result !== "skipped" && r.result !== "canceled") return false;
  return (byParent.get(r.id) ?? []).every(c => isEntirelySkipped(c, byParent));
}

export function buildFlatRunTree(
  records: TimelineRecord[],
  collapsed: Set<string>,
  expandedGroups: Set<string>,
): FlatRunItem[] {
  const knownIds = new Set(records.map(r => r.id));
  const byParent = new Map<string | undefined, TimelineRecord[]>();
  for (const r of records) {
    const key = r.parentId && knownIds.has(r.parentId) ? r.parentId : undefined;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(r);
  }
  for (const kids of byParent.values()) kids.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const result: FlatRunItem[] = [];
  function walk(parentId: string | undefined, depth: number) {
    const siblings   = byParent.get(parentId) ?? [];
    const allSkipped = siblings.filter(r => isEntirelySkipped(r, byParent));
    let groupEmitted = false;
    for (const r of siblings) {
      if (isEntirelySkipped(r, byParent)) {
        if (allSkipped.length < 2) {
          const hasChildren = (byParent.get(r.id) ?? []).length > 0;
          result.push({ kind: "regular", record: r, depth, hasChildren, isExpanded: !collapsed.has(r.id) });
          if (hasChildren && !collapsed.has(r.id)) walk(r.id, depth + 1);
        } else if (!groupEmitted) {
          const typeName  = depth === 0 ? "stages" : "steps";
          const groupId   = `__grp_${allSkipped[0].id}`;
          const isExpanded = expandedGroups.has(groupId);
          result.push({ kind: "group", id: groupId, depth, count: allSkipped.length, label: `${allSkipped.length} ${typeName} skipped`, isExpanded });
          if (isExpanded) {
            for (const gr of allSkipped) {
              const hasChildren = (byParent.get(gr.id) ?? []).length > 0;
              result.push({ kind: "regular", record: gr, depth, hasChildren, isExpanded: !collapsed.has(gr.id) });
              if (hasChildren && !collapsed.has(gr.id)) walk(gr.id, depth + 1);
            }
          }
          groupEmitted = true;
        }
      } else {
        const kids = byParent.get(r.id) ?? [];
        const hasChildren = kids.length > 0;
        const isExpanded  = !collapsed.has(r.id);
        result.push({ kind: "regular", record: r, depth, hasChildren, isExpanded });
        if (hasChildren && isExpanded) walk(r.id, depth + 1);
      }
    }
  }
  walk(undefined, 0);
  return result;
}

export function runItemLabel(item: FlatRunItem): string {
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
  } else if (r.type === "Checkpoint")   { icon = "⬡"; color = "gray";   }
  else if (r.state === "pending")       { icon = "○"; color = "gray";   }
  else if (r.state === "inProgress")    { icon = "▶"; color = "yellow"; }
  else if (r.result === "succeeded")    { icon = "✓"; color = "green";  }
  else if (r.result === "failed")       { icon = "✗"; color = "red";    }
  else if (r.result === "skipped")      { icon = "⊘"; color = "gray";   }
  else if (r.result === "canceled")     { icon = "⊘"; color = "gray";   }
  else                                  { icon = "?"; color = "white";  }
  return `${indent}${caret}{${color}-fg}${icon}{/} ${r.name}`;
}
