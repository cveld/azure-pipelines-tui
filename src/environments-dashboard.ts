#!/usr/bin/env node
// environments-dashboard.ts — Azure Pipelines Environments Dashboard TUI

import https from "https";
import { execSync, spawn } from "child_process";
import { URL } from "url";
import fs from "fs";
import os from "os";
import type { IncomingMessage } from "http";
import * as blessed from "blessed";
import { readCache, writeCache, clearAllCache, clearByPrefix } from "./cache.js";

// ── Types ─────────────────────────────────────────────────────────────────────

interface AzTokenResponse { accessToken: string; expiresOn: string; }

interface AdoEnvironment { id: number; name: string; description?: string; }

interface DeploymentRecord {
  id: number;
  definition: { id: number; name: string };
  owner: { id: number | string; name: string };
  result: string;
  startTime?: string;
  finishTime?: string;
  requestedFor?: { displayName: string };
}

interface BuildInfo {
  id: number;
  buildNumber: string;
  status: string;
  result?: string;
  sourceVersion?: string;
  sourceBranch?: string;
  startTime?: string;
  finishTime?: string;
}

interface PipelineDefinition { id: number; name: string; path: string; }

interface EnvMapping {
  environmentId: number;
  environmentName: string;
  pipelineId: number;
  pipelineName: string;
}

interface DashboardConfig {
  org?: string;
  project?: string;
  azConfigDir?: string;
  mappings: EnvMapping[];
}

interface EnvRow {
  env: AdoEnvironment;
  deploy?: DeploymentRecord;
  build?: BuildInfo;
  mapping?: EnvMapping;
  loading: boolean;
}

interface TreeNode {
  key: string;
  label: string;
  children: Map<string, TreeNode>;
  row?: EnvRow;
}

type FlatEnvItem =
  | { kind: "group"; key: string; label: string; depth: number; isExpanded: boolean; total: number; ok: number; fail: number; ownRow?: EnvRow }
  | { kind: "leaf";  key: string; label: string; depth: number; row: EnvRow; isLast: boolean };

interface PipeTreeNode {
  key: string;
  label: string;
  children: Map<string, PipeTreeNode>;
  pipeline?: PipelineDefinition;
}

type FlatPipeItem =
  | { kind: "folder";   key: string; label: string; depth: number; isExpanded: boolean; count: number }
  | { kind: "pipeline"; key: string; label: string; depth: number; pipeline: PipelineDefinition; isLast: boolean };

interface PipelineRun {
  id: number;
  buildNumber: string;
  status: string;
  result?: string;
  startTime?: string;
  finishTime?: string;
  sourceBranch?: string;
}

interface StageInfo { id: string; name: string; state: string; result?: string; order?: number; finishTime?: string; warningCount?: number; }
interface RunStageEntry { runId: number; result?: string; state: string; finishTime?: string; warningCount?: number; }
interface StageBranchSummary {
  branch: string;
  planLatest?: RunStageEntry;
  planPrevActive?: RunStageEntry;  // most recent non-skipped/canceled run (when planLatest is skipped/canceled)
  planPrevOk?: RunStageEntry;      // most recent succeeded run (fallback when planPrevActive failed)
  applyLatest?: RunStageEntry;
  applyPrevActive?: RunStageEntry;
  applyPrevOk?: RunStageEntry;
}
type StageMeta =
  | { kind: "base"; displayName: string }
  | { kind: "branch"; branch: string; latestRunId?: number }
  | { kind: "separator" };

// ── CLI args ──────────────────────────────────────────────────────────────────

function showHelp(): never {
  console.log(`
Azure Pipelines Environments Dashboard

Usage:
  npx tsx environments-dashboard.ts [org/project] [--config <file>]

Options:
  org/project       Override org and project from config
  --config <file>   Path to config file (default: environments-config.json)
  --stages <id>     Open stages dashboard directly for a pipeline ID or name
  --help            Show this help

Config file (environments-config.json):
  {
    "org": "MyOrg",
    "project": "MyProject",
    "azConfigDir": "C:/path/to/.azure",
    "mappings": []
  }

Keys (dashboard):
  ↑↓       Navigate environments
  Enter    Open latest build in browser
  m        Mapping editor (link environments to pipelines)
  p        Pipeline definitions list
  r        Refresh (clears environment and deployment caches)
  c        Clear all caches
  q        Quit

Keys (mapping editor):
  Tab      Switch between environments and pipelines panels
  Space    Link selected environment to selected pipeline
  d        Delete mapping for selected environment
  s        Save config and return to dashboard
  Esc      Return without saving

Cache location: ${os.homedir()}/.azure-pipelines-tui/cache/
`);
  process.exit(0);
}

const rawArgs = process.argv.slice(2);
if (rawArgs.includes("--help")) showHelp();

const configIdx = rawArgs.indexOf("--config");
const CONFIG_FILE = configIdx >= 0 ? rawArgs[configIdx + 1] : "environments-config.json";
const stagesIdx = rawArgs.indexOf("--stages");
const STAGES_ARG = stagesIdx >= 0 ? rawArgs[stagesIdx + 1] : undefined;
const orgProjectArg = rawArgs.find(a => !a.startsWith("--") && a.includes("/"));

// ── Config ────────────────────────────────────────────────────────────────────

function loadConfig(): DashboardConfig {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) as DashboardConfig; }
  catch { return { mappings: [] }; }
}

function saveConfig(cfg: DashboardConfig): void {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf8");
}

// ── Token management ──────────────────────────────────────────────────────────

let cachedToken: string | null = null;
let tokenExpiry = 0;

async function getToken(azConfigDir?: string): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiry - 60_000) return cachedToken;
  const env = azConfigDir ? { ...process.env, AZURE_CONFIG_DIR: azConfigDir } : process.env;
  const raw = execSync(
    "az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --output json",
    { encoding: "utf8", env }
  );
  const { accessToken, expiresOn } = JSON.parse(raw) as AzTokenResponse;
  cachedToken = accessToken;
  tokenExpiry = new Date(expiresOn).getTime();
  return cachedToken;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function httpGet<T>(reqUrl: string, token: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const u = new URL(reqUrl);
    https.get(
      { hostname: u.hostname, path: u.pathname + u.search,
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } },
      (res: IncomingMessage) => {
        let data = "";
        res.on("data", (c: string) => (data += c));
        res.on("end", () => {
          if ((res.statusCode ?? 0) >= 400)
            return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          try { resolve(JSON.parse(data) as T); } catch (e) { reject(e); }
        });
      }
    ).on("error", reject);
  });
}

function httpGetPaged<T>(reqUrl: string, token: string): Promise<{ data: T; ct?: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(reqUrl);
    https.get(
      { hostname: u.hostname, path: u.pathname + u.search,
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } },
      (res: IncomingMessage) => {
        let data = "";
        res.on("data", (c: string) => (data += c));
        res.on("end", () => {
          if ((res.statusCode ?? 0) >= 400)
            return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          try {
            const ct = res.headers["x-ms-continuationtoken"] as string | undefined;
            resolve({ data: JSON.parse(data) as T, ct });
          } catch (e) { reject(e); }
        });
      }
    ).on("error", reject);
  });
}

// ── ADO API ───────────────────────────────────────────────────────────────────

const API_VER = "api-version=7.1";
const enc = encodeURIComponent;

async function fetchAllEnvironments(org: string, project: string, token: string): Promise<AdoEnvironment[]> {
  const ckey = `envs_${org}_${project}`;
  const cached = readCache<AdoEnvironment[]>(ckey);
  if (cached) return cached;

  const all: AdoEnvironment[] = [];
  let ct: string | undefined;
  do {
    const url = `https://dev.azure.com/${enc(org)}/${enc(project)}/_apis/distributedtask/environments?$top=100` +
      (ct ? `&continuationToken=${ct}` : "") + `&${API_VER}`;
    const { data, ct: next } = await httpGetPaged<{ value: AdoEnvironment[] }>(url, token);
    all.push(...(data.value ?? []));
    ct = next;
  } while (ct);

  all.sort((a, b) => a.name.localeCompare(b.name));
  writeCache(ckey, all, 5 * 60_000);
  return all;
}

async function fetchLatestDeployment(
  org: string, project: string, envId: number, token: string
): Promise<DeploymentRecord | null> {
  const ckey = `deploy_${org}_${project}_${envId}`;
  const cached = readCache<DeploymentRecord | null>(ckey);
  if (cached !== null) return cached;

  try {
    const url = `https://dev.azure.com/${enc(org)}/${enc(project)}/_apis/distributedtask/environments/${envId}/environmentdeploymentrecords?top=1&${API_VER}`;
    const data = await httpGet<{ value: DeploymentRecord[] }>(url, token);
    const record = data.value?.[0] ?? null;
    writeCache(ckey, record, 2 * 60_000);
    return record;
  } catch { return null; }
}

async function fetchBuildInfo(
  org: string, project: string, buildId: number | string, token: string
): Promise<BuildInfo | null> {
  const id = Number(buildId);
  if (!id) return null;
  const ckey = `build_${org}_${project}_${id}`;
  const cached = readCache<BuildInfo>(ckey);
  if (cached) return cached;

  try {
    const url = `https://dev.azure.com/${enc(org)}/${enc(project)}/_apis/build/builds/${id}?${API_VER}`;
    const data = await httpGet<BuildInfo>(url, token);
    const ttl = data.status === "completed" ? 60 * 60_000 : 2 * 60_000;
    writeCache(ckey, data, ttl);
    return data;
  } catch { return null; }
}

async function fetchPipelineDefinitions(org: string, project: string, token: string): Promise<PipelineDefinition[]> {
  const ckey = `pipelines_${org}_${project}`;
  const cached = readCache<PipelineDefinition[]>(ckey);
  if (cached) return cached;

  const url = `https://dev.azure.com/${enc(org)}/${enc(project)}/_apis/build/definitions?$top=1000&${API_VER}`;
  const data = await httpGet<{ value: PipelineDefinition[] }>(url, token);
  const defs = (data.value ?? []).sort((a, b) => a.name.localeCompare(b.name));
  writeCache(ckey, defs, 10 * 60_000);
  return defs;
}

async function fetchPipelineRuns(
  org: string, project: string, pipelineId: number, token: string, top = 50
): Promise<PipelineRun[]> {
  const ckey = `runs_${org}_${project}_${pipelineId}`;
  const cached = readCache<PipelineRun[]>(ckey);
  if (cached) return cached;
  const url = `https://dev.azure.com/${enc(org)}/${enc(project)}/_apis/build/builds?definitions=${pipelineId}&$top=${top}&${API_VER}`;
  const data = await httpGet<{ value: PipelineRun[] }>(url, token);
  // Sort by ID descending (IDs are assigned at queue time, so higher = more recently started).
  // The API sorts by finishTime which misorders concurrent runs.
  const runs = (data.value ?? []).sort((a, b) => b.id - a.id);
  writeCache(ckey, runs, 2 * 60_000);
  return runs;
}

async function fetchRunStages(
  org: string, project: string, runId: number, token: string
): Promise<StageInfo[]> {
  const ckey = `stages_${org}_${project}_${runId}`;
  const cached = readCache<StageInfo[]>(ckey);
  if (cached) {
    const hasSucceeded = cached.some(s => s.result === "succeeded" || s.result === "failed");
    const hasFinishTime = cached.some(s => s.finishTime);
    const hasWarningCount = cached.every(s => s.warningCount !== undefined);
    if ((!hasSucceeded || hasFinishTime) && hasWarningCount) return cached;
  }
  try {
    const url = `https://dev.azure.com/${enc(org)}/${enc(project)}/_apis/build/builds/${runId}/timeline?${API_VER}`;
    const data = await httpGet<{ records: Array<{ id: string; parentId?: string | null; type: string; name: string; state: string; result?: string; order?: number; finishTime?: string; warningCount?: number }> }>(url, token);
    const allRecords = data.records ?? [];
    // Build parent→children index to sum leaf warningCounts per stage
    const childIds = new Set(allRecords.map(r => r.parentId).filter(Boolean) as string[]);
    const childrenOf = new Map<string, typeof allRecords>();
    for (const r of allRecords) {
      if (r.parentId) {
        if (!childrenOf.has(r.parentId)) childrenOf.set(r.parentId, []);
        childrenOf.get(r.parentId)!.push(r);
      }
    }
    function sumWarnings(id: string): number {
      const kids = childrenOf.get(id) ?? [];
      if (kids.length === 0) return 0;
      let total = 0;
      for (const kid of kids)
        total += childIds.has(kid.id) ? sumWarnings(kid.id) : (kid.warningCount ?? 0);
      return total;
    }
    const stages = allRecords
      .filter(r => r.type === "Stage")
      .map(r => ({ id: r.id, name: r.name, state: r.state, result: r.result, order: r.order, finishTime: r.finishTime, warningCount: sumWarnings(r.id) }));
    const allDone = stages.length > 0 && stages.every(s => s.state === "completed");
    writeCache(ckey, stages, allDone ? 60 * 60_000 : 2 * 60_000);
    return stages;
  } catch { return []; }
}

// ── Tree building ─────────────────────────────────────────────────────────────

function buildTree(rows: EnvRow[]): TreeNode {
  const root: TreeNode = { key: "", label: "", children: new Map() };
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

function countDescendantStats(node: TreeNode): { total: number; ok: number; fail: number } {
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

function flattenTree(
  node: TreeNode, collapsed: Set<string>, depth: number, items: FlatEnvItem[]
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
      if (isExpanded) flattenTree(child, collapsed, depth + 1, items);
    }
  }
}

// ── Pipeline tree helpers ─────────────────────────────────────────────────────

function buildPipeTree(defs: PipelineDefinition[]): PipeTreeNode {
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

function countPipeDescendants(node: PipeTreeNode): number {
  let n = 0;
  for (const child of node.children.values())
    n += child.pipeline ? 1 : countPipeDescendants(child);
  return n;
}

function flattenPipeTree(
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

const PIPE_LEFT_COL = 52;

function formatPipeItem(item: FlatPipeItem): string {
  const indent = "  ".repeat(item.depth);
  if (item.kind === "folder") {
    const pfx = indent + (item.isExpanded ? "▼ " : "▶ ");
    return `{bold} ${pfx}${item.label}{/}  {gray-fg}(${item.count}){/}`;
  }
  const pfx = indent + (item.isLast ? "└─ " : "├─ ");
  const label = padEnd(item.label, Math.max(1, PIPE_LEFT_COL - pfx.length));
  return ` ${pfx}${label}  {gray-fg}${item.pipeline.id}{/}`;
}

// ── Stage helpers ─────────────────────────────────────────────────────────────

const BRANCH_COL = 30;  // padEnd width for branch column in list items
const PLAN_COL   = 22;  // visible width of Plan cell
const APPLY_COL  = 22;  // visible width of Apply cell

function parseStageKind(name: string, planBases?: Set<string>): { kind: "plan" | "apply" | "other"; base: string } {
  const pm = name.match(/^plan(.*)$/i);
  if (pm) return { kind: "plan", base: pm[1].replace(/^[_\-\s]+/, "") };
  const am = name.match(/^(?:apply|deploy)(.*)$/i);
  if (am) return { kind: "apply", base: am[1].replace(/^[_\-\s]+/, "") };
  // Bare name paired with a "Deploy <name>" counterpart → plan
  if (planBases?.has(name.toLowerCase())) return { kind: "plan", base: name };
  return { kind: "other", base: name };
}

function buildStageBranchSummaries(
  runs: PipelineRun[],
  stagesMap: Map<number, StageInfo[]>
): Array<{ displayName: string; branches: Map<string, StageBranchSummary> }> {
  // Pre-pass: collect bases from "Deploy X" / "Apply X" stages so bare names like "lrn" can be recognised as plan
  const planBases = new Set<string>();
  for (const run of runs) {
    for (const stage of (stagesMap.get(run.id) ?? [])) {
      const m = stage.name.match(/^(?:apply|deploy)\s+(.+)$/i);
      if (m) planBases.add(m[1].trim().toLowerCase());
    }
  }

  const baseOrder: string[] = [];
  const basePlanName  = new Map<string, string>();
  const baseApplyName = new Map<string, string>();
  const summaries = new Map<string, Map<string, StageBranchSummary>>();

  for (const run of runs) {
    const branch = shortBranch(run.sourceBranch);
    for (const stage of (stagesMap.get(run.id) ?? [])) {
      const { kind, base } = parseStageKind(stage.name, planBases);
      // Use null-byte prefix to avoid collisions between "other" stages and plan/apply bases
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
        else if (!isActive(s.applyLatest.result) && !s.applyPrevActive && isActive(entry.result)) {
          s.applyPrevActive = entry;
        } else if (!s.applyPrevOk) {
          const effective = s.applyPrevActive ?? s.applyLatest;
          if (effective.result !== "succeeded" && entry.result === "succeeded") s.applyPrevOk = entry;
        }
      } else {
        if (!s.planLatest) { s.planLatest = entry; }
        else if (!isActive(s.planLatest.result) && !s.planPrevActive && isActive(entry.result)) {
          s.planPrevActive = entry;
        } else if (!s.planPrevOk) {
          const effective = s.planPrevActive ?? s.planLatest;
          if (effective.result !== "succeeded" && entry.result === "succeeded") s.planPrevOk = entry;
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

function branchHasRun(summary: StageBranchSummary): boolean {
  const effective = (e?: RunStageEntry) =>
    !!e && e.result !== "skipped" && e.result !== "canceled";
  return effective(summary.planLatest) || effective(summary.applyLatest)
    || !!summary.planPrevActive || !!summary.applyPrevActive
    || !!summary.planPrevOk    || !!summary.applyPrevOk;
}

function statusCell(entry?: RunStageEntry, prevOk?: RunStageEntry, W = PLAN_COL, dim = false, prevActive?: RunStageEntry): string {
  if (!entry) return padEnd("-", W);
  // Skipped/canceled: show the most recent active (non-skipped/canceled) run instead.
  // prevActive = most recent non-skipped run; prevOk = most recent success (fallback when prevActive failed).
  // Always full color — the * already signals this is not from the most recent run.
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
      // Show prev-success fallback only when prevActive is a failed run
      const fallback = (prevActive && display.result !== "succeeded" && prevOk)
        ? `(✓${timeAgo(prevOk.finishTime)})` : "";
      const starFull = ` *${fallback}`;
      const pad = Math.max(0, W - mainStr.length - starFull.length);
      return `{${color}-fg}${mainStr}{/}{gray-fg}${starFull}{/}${" ".repeat(pad)}`;
    }
    // No active run at all — fall through to ⊘ display
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
  // For running/pending: show previous finished result alongside ▶/○
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

// ── Formatting ────────────────────────────────────────────────────────────────

function padEnd(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function timeAgo(dateStr?: string): string {
  if (!dateStr) return "-";
  // Ensure strings without explicit timezone offset are treated as UTC
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

function shortBranch(branch?: string): string {
  if (!branch) return "-";
  return branch.replace(/^refs\/heads\//, "").replace(/^refs\/tags\//, "");
}

const LEFT_COL = 36; // visible width of the tree + env-name column

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

function formatTreeItem(item: FlatEnvItem): string {
  const indent = "  ".repeat(item.depth);

  if (item.kind === "group") {
    const pfx = indent + (item.isExpanded ? "▼ " : "▶ ");
    const label = padEnd(item.label, Math.max(1, LEFT_COL - 1 - pfx.length));
    const left = " " + pfx + label;
    if (item.ownRow) {
      // Group is also an environment itself — show its status + child count
      const childBadge = item.total > 0 ? `  {gray-fg}(+${item.total}){/}` : "";
      return `{bold}${left}{/}${rowColumns(item.ownRow)}${childBadge}`;
    }
    // Pure grouping: show aggregate status counts
    let stats = "";
    if (item.ok > 0)                          stats += ` {green-fg}${item.ok}✓{/}`;
    if (item.fail > 0)                        stats += ` {red-fg}${item.fail}✗{/}`;
    const other = item.total - item.ok - item.fail;
    if (other > 0)                            stats += ` {gray-fg}${other}…{/}`;
    if (!stats && item.total === 0)           stats =  ` {gray-fg}empty{/}`;
    return `{bold}${left}{/}${stats}`;
  }

  // Leaf
  const pfx = indent + (item.isLast ? "└─ " : "├─ ");
  const label = padEnd(item.label, Math.max(1, LEFT_COL - 1 - pfx.length));
  return " " + pfx + label + rowColumns(item.row);
}

function colHeaderStr(): string {
  return padEnd("  Environments", LEFT_COL) + " " + padEnd("Pipeline", 36) + " " +
    padEnd("Status", 12) + " " + padEnd("Branch", 20) + " Age";
}

// ── TUI ───────────────────────────────────────────────────────────────────────

async function main() {
  const config = loadConfig();
  const [orgArg = "", projectArg = ""] = orgProjectArg ? orgProjectArg.split("/") : [];
  const ORG = orgArg || config.org || "";
  const PROJECT = projectArg || config.project || "";

  if (!ORG || !PROJECT) {
    console.error(
      "Error: org/project required. Pass as 'org/project' argument or set in environments-config.json.\n" +
      "Run with --help for usage."
    );
    process.exit(1);
  }

  config.org = ORG;
  config.project = PROJECT;

  let rows: EnvRow[] = [];
  let pipelines: PipelineDefinition[] = [];
  let mappingSnapshot: EnvMapping[] = [];
  let flatItems: FlatEnvItem[] = [];
  let collapsed = new Set<string>();
  let flatPipeItems: FlatPipeItem[] = [];
  let collapsedPipeFolders = new Set<string>();
  let selectedPipeline: PipelineDefinition | null = null;
  let pipelineRuns: PipelineRun[] = [];
  let runStagesMap = new Map<number, StageInfo[]>();
  let stageListMeta: StageMeta[] = [];
  type View = "dashboard" | "mapping" | "pipelines" | "stages";
  let view: View = STAGES_ARG ? "stages" : "dashboard";
  let statusMsg = "";
  let statusTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Screen ────────────────────────────────────────────────────────────────
  const screen = blessed.screen({
    smartCSR: true, title: "Azure Pipelines Environments",
    fullUnicode: true, forceUnicode: true,
  });
  process.stdout.write("\x1b[?25l");
  const restoreCursor = () => process.stdout.write("\x1b[?25h");
  screen.on("destroy", restoreCursor);
  process.on("exit", restoreCursor);
  process.on("SIGINT", () => { restoreCursor(); process.exit(0); });

  // ── Widgets ───────────────────────────────────────────────────────────────
  blessed.box({
    parent: screen, top: 0, left: 0, width: "100%", height: 1, tags: true,
    style: { bg: "blue", fg: "white", bold: true },
    content: ` {bold}Azure Pipelines Environments{/bold}  ${ORG} / ${PROJECT}`,
  });

  const colHeader = blessed.box({
    parent: screen, top: 1, left: 0, width: "100%", height: 1,
    style: { bg: "black", fg: "cyan", bold: true },
    content: colHeaderStr(),
  });

  const dashList = blessed.list({
    parent: screen, top: 2, left: 0, width: "100%", height: "100%-4",
    border: { type: "line" }, label: " Environments ",
    tags: true, keys: true, vi: true, scrollable: true,
    scrollbar: { ch: "│", style: { fg: "blue" } },
    style: {
      border: { fg: "cyan" }, selected: { bg: "blue", fg: "white", bold: true },
      item: { fg: "white" }, focus: { border: { fg: "white" } },
    },
    items: [],
  });

  const mapLeft = blessed.list({
    parent: screen, top: 1, left: 0, width: "50%", height: "100%-3",
    border: { type: "line" }, label: " Environments ",
    tags: true, keys: true, vi: true, scrollable: true,
    scrollbar: { ch: "│", style: { fg: "blue" } },
    style: {
      border: { fg: "gray" }, selected: { bg: "blue", fg: "white" },
      focus: { border: { fg: "white" } },
    },
    items: [], hidden: true,
  });

  const mapRight = blessed.list({
    parent: screen, top: 1, left: "50%", width: "50%", height: "100%-3",
    border: { type: "line" }, label: " Pipeline Definitions ",
    tags: true, keys: true, vi: true, scrollable: true,
    scrollbar: { ch: "│", style: { fg: "blue" } },
    style: {
      border: { fg: "gray" }, selected: { bg: "blue", fg: "white" },
      focus: { border: { fg: "white" } },
    },
    items: [], hidden: true,
  });

  const pipeList = blessed.list({
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

  const stagesColHeader = blessed.box({
    parent: screen, top: 1, left: 0, width: "100%", height: 1,
    style: { bg: "black", fg: "cyan", bold: true },
    hidden: true,
  });

  const stagesList = blessed.list({
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

  const footer = blessed.box({
    parent: screen, bottom: 0, left: 0, width: "100%", height: 1, tags: true,
    style: { bg: "black", fg: "gray" },
  });

  screen.render();

  // ── Status + footer ───────────────────────────────────────────────────────
  function setStatus(msg: string, ttlMs = 3000) {
    statusMsg = msg;
    if (statusTimer) clearTimeout(statusTimer);
    if (ttlMs > 0 && msg) statusTimer = setTimeout(() => { statusMsg = ""; renderFooter(); }, ttlMs);
    renderFooter();
  }

  function renderFooter() {
    const s = statusMsg ? `  {yellow-fg}${statusMsg}{/}` : "";
    const bases: Record<View, string> = {
      dashboard:
        " {cyan-fg}↑↓{/} Navigate  {cyan-fg}Enter{/} Expand/Open  {cyan-fg}←{/} Collapse  " +
        "{cyan-fg}m{/} Mapping  {cyan-fg}p{/} Pipelines  {cyan-fg}r{/} Refresh  {cyan-fg}c{/} Clear cache  {cyan-fg}q{/} Quit",
      mapping:
        " {cyan-fg}Tab{/} Switch panels  {cyan-fg}Space{/} Link env→pipeline  " +
        "{cyan-fg}d{/} Delete mapping  {cyan-fg}s{/} Save & back  {cyan-fg}Esc{/} Discard & back",
      pipelines: " {cyan-fg}↑↓{/} Navigate  {cyan-fg}Enter{/} Expand/Stages  {cyan-fg}←→{/} Collapse/Expand  {cyan-fg}b{/} Browser  {cyan-fg}Esc{/} Back  {cyan-fg}q{/} Quit",
      stages:
        " {cyan-fg}↑↓{/} Navigate  {cyan-fg}Enter{/} Open run  {cyan-fg}b{/} Browser  " +
        "{cyan-fg}r{/} Refresh  {cyan-fg}Esc{/} Back  {cyan-fg}q{/} Quit",
    };
    footer.setContent(bases[view] + s);
    screen.render();
  }

  // ── View switching ─────────────────────────────────────────────────────────
  function showDashboard() {
    view = "dashboard";
    colHeader.show(); dashList.show();
    mapLeft.hide(); mapRight.hide(); pipeList.hide(); stagesColHeader.hide(); stagesList.hide();
    renderFooter(); dashList.focus(); screen.render();
  }

  function populateMapLeft() {
    (mapLeft as any).setItems(rows.map(row => {
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

  function showMapping() {
    if (pipelines.length === 0) { setStatus("Pipeline definitions still loading…"); return; }
    // Snapshot for discard-on-Esc
    mappingSnapshot = config.mappings.map(m => ({ ...m }));
    view = "mapping";
    colHeader.hide(); dashList.hide(); pipeList.hide(); stagesColHeader.hide(); stagesList.hide();
    mapLeft.show(); mapRight.show();
    populateMapLeft();
    (mapRight as any).setItems(pipelines.map(p => {
      const nm = padEnd(p.name, 50);
      const pt = p.path !== "\\" ? `  {gray-fg}${p.path}{/}` : "";
      return ` ${padEnd(String(p.id), 6)} ${nm}${pt}`;
    }));
    renderFooter(); mapLeft.focus(); screen.render();
  }

  function refreshPipeList(scrollTo?: PipelineDefinition) {
    const tree = buildPipeTree(pipelines);
    flatPipeItems = [];
    flattenPipeTree(tree, collapsedPipeFolders, 0, flatPipeItems);
    (pipeList as any).setItems(flatPipeItems.map(formatPipeItem));
    if (scrollTo) {
      const idx = flatPipeItems.findIndex(i => i.kind === "pipeline" && i.pipeline.id === scrollTo.id);
      if (idx >= 0) {
        (pipeList as any).select(idx);
        const visibleHeight = ((pipeList as any).height as number) - 2;
        (pipeList as any).scrollTo(Math.max(0, idx - Math.floor(visibleHeight / 2)));
      }
    }
    screen.render();
  }

  function showPipelines() {
    if (pipelines.length === 0) { setStatus("Pipeline definitions still loading…"); return; }
    view = "pipelines";
    colHeader.hide(); dashList.hide(); mapLeft.hide(); mapRight.hide(); stagesColHeader.hide(); stagesList.hide();
    pipeList.show();
    refreshPipeList(selectedPipeline ?? undefined);
    renderFooter(); pipeList.focus(); screen.render();
  }

  function refreshDashList() {
    const prevKey = flatItems[(dashList as any).selected as number]?.key;
    const tree = buildTree(rows);
    flatItems = [];
    flattenTree(tree, collapsed, 0, flatItems);
    (dashList as any).setItems(flatItems.map(formatTreeItem));
    if (prevKey) {
      const idx = flatItems.findIndex(i => i.key === prevKey);
      if (idx >= 0) (dashList as any).select(idx);
    }
    screen.render();
  }

  // ── Stages view ───────────────────────────────────────────────────────────

  function refreshStagesView() {
    if (!selectedPipeline) return;
    const baseGroups = buildStageBranchSummaries(pipelineRuns, runStagesMap);

    stagesColHeader.setContent(
      padEnd("  Stage / Branch", BRANCH_COL + 2) +
      padEnd("Plan", PLAN_COL) +
      "Apply"
    );

    const items: string[] = [];
    const meta: StageMeta[] = [];

    for (let gi = 0; gi < baseGroups.length; gi++) {
      const { displayName, branches } = baseGroups[gi];
      items.push(`{bold} ${padEnd(displayName, BRANCH_COL)}{/}`);
      meta.push({ kind: "base", displayName });

      // Most recent branch = the one with the latest apply (or plan) finishTime
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

      if (gi < baseGroups.length - 1) {
        items.push("");
        meta.push({ kind: "separator" });
      }
    }

    stageListMeta = meta;
    (stagesList as any).setItems(items);
    stagesList.setLabel(` Stages: ${selectedPipeline.name}  (${pipelineRuns.length} runs) `);
    screen.render();
  }

  async function showStages(pipeline: PipelineDefinition) {
    selectedPipeline = pipeline;
    pipelineRuns = [];
    runStagesMap = new Map();
    stageListMeta = [];
    view = "stages";
    colHeader.hide(); dashList.hide(); mapLeft.hide(); mapRight.hide(); pipeList.hide();
    stagesColHeader.show(); stagesList.show();
    (stagesList as any).setItems([]);
    renderFooter(); stagesList.focus(); screen.render();
    await loadStagesData();
  }

  async function loadStagesData() {
    if (!selectedPipeline) return;
    setStatus("Loading pipeline runs…", 0);
    try {
      const token = await getToken(config.azConfigDir);
      pipelineRuns = await fetchPipelineRuns(ORG, PROJECT, selectedPipeline.id, token);
      setStatus(`${pipelineRuns.length} runs — loading timelines…`, 0);
      refreshStagesView();

      const BATCH = 10;
      for (let i = 0; i < pipelineRuns.length; i += BATCH) {
        await Promise.all(pipelineRuns.slice(i, i + BATCH).map(async run => {
          const stages = await fetchRunStages(ORG, PROJECT, run.id, token);
          runStagesMap.set(run.id, stages);
        }));
        refreshStagesView();
        setStatus(`Timelines ${Math.min(i + BATCH, pipelineRuns.length)}/${pipelineRuns.length}…`, 0);
      }
      setStatus("", 0);
    } catch (e) {
      setStatus(`Error: ${(e as Error).message.slice(0, 80)}`, 10_000);
    }
  }

  // ── Mapping actions ────────────────────────────────────────────────────────
  function link() {
    const envSel = (mapLeft as any).selected as number ?? 0;
    const pipSel = (mapRight as any).selected as number ?? 0;
    const row = rows[envSel];
    const pip = pipelines[pipSel];
    if (!row || !pip) return;
    const m: EnvMapping = {
      environmentId: row.env.id, environmentName: row.env.name,
      pipelineId: pip.id, pipelineName: pip.name,
    };
    config.mappings = config.mappings.filter(x => x.environmentId !== row.env.id);
    config.mappings.push(m);
    row.mapping = m;
    populateMapLeft();
    setStatus(`Linked "${row.env.name}" → "${pip.name}"`, 0);
    screen.render();
  }

  function discardMappingChanges() {
    config.mappings = mappingSnapshot;
    rows.forEach(row => {
      row.mapping = config.mappings.find(m => m.environmentId === row.env.id);
    });
  }

  // ── Keyboard ──────────────────────────────────────────────────────────────
  screen.key(["q", "C-c"], () => { screen.destroy(); process.exit(0); });

  dashList.key("m", () => showMapping());
  dashList.key("p", () => showPipelines());
  dashList.key("r", () => {
    clearByPrefix(`envs_${ORG}_${PROJECT}`);
    clearByPrefix(`deploy_${ORG}_${PROJECT}`);
    setStatus("Refreshing…", 0);
    loadData();
  });
  dashList.key("c", () => {
    clearAllCache();
    setStatus("All caches cleared");
  });
  dashList.key("enter", () => {
    const sel = (dashList as any).selected as number ?? 0;
    const item = flatItems[sel];
    if (!item) return;
    if (item.kind === "group") {
      if (collapsed.has(item.key)) collapsed.delete(item.key);
      else collapsed.add(item.key);
      refreshDashList();
    } else {
      const bid = item.row?.deploy?.owner?.id ? Number(item.row.deploy.owner.id) : 0;
      if (!bid) return;
      const url = `https://dev.azure.com/${ORG}/${PROJECT}/_build/results?buildId=${bid}`;
      try { spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref(); } catch {}
    }
  });

  dashList.key("left", () => {
    const sel = (dashList as any).selected as number ?? 0;
    const item = flatItems[sel];
    if (!item) return;
    if (item.kind === "group" && item.isExpanded) {
      collapsed.add(item.key);
      refreshDashList();
    } else {
      // Navigate to parent group
      const parentKey = item.key.split("-").slice(0, -1).join("-");
      if (parentKey) {
        const idx = flatItems.findIndex(i => i.kind === "group" && i.key === parentKey);
        if (idx >= 0) { (dashList as any).select(idx); screen.render(); }
      }
    }
  });

  mapLeft.key("tab", () => { mapRight.focus(); screen.render(); });
  mapRight.key("tab", () => { mapLeft.focus(); screen.render(); });
  mapLeft.key(["space", "enter"], link);
  mapRight.key(["space", "enter"], link);
  mapLeft.key("d", () => {
    const sel = (mapLeft as any).selected as number ?? 0;
    const row = rows[sel];
    if (!row) return;
    config.mappings = config.mappings.filter(x => x.environmentId !== row.env.id);
    row.mapping = undefined;
    populateMapLeft();
    setStatus(`Deleted mapping for "${row.env.name}"`, 0);
    screen.render();
  });
  mapLeft.key("s", () => { saveConfig(config); showDashboard(); setStatus("Config saved"); });
  mapRight.key("s", () => { saveConfig(config); showDashboard(); setStatus("Config saved"); });
  mapLeft.key("escape", () => { discardMappingChanges(); showDashboard(); });
  mapRight.key("escape", () => { discardMappingChanges(); showDashboard(); });
  pipeList.key("b", () => {
    const sel = (pipeList as any).selected as number ?? 0;
    const item = flatPipeItems[sel];
    if (!item || item.kind !== "pipeline") return;
    const url = `https://dev.azure.com/${ORG}/${PROJECT}/_build?definitionId=${item.pipeline.id}&_a=summary`;
    try { spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref(); } catch {}
  });
  pipeList.key("escape", showDashboard);
  pipeList.key("enter", () => {
    const sel = (pipeList as any).selected as number ?? 0;
    const item = flatPipeItems[sel];
    if (!item) return;
    if (item.kind === "folder") {
      if (collapsedPipeFolders.has(item.key)) collapsedPipeFolders.delete(item.key);
      else collapsedPipeFolders.add(item.key);
      refreshPipeList();
    } else {
      showStages(item.pipeline);
    }
  });
  pipeList.key("right", () => {
    const sel = (pipeList as any).selected as number ?? 0;
    const item = flatPipeItems[sel];
    if (!item || item.kind !== "folder" || item.isExpanded) return;
    collapsedPipeFolders.delete(item.key);
    refreshPipeList();
  });
  pipeList.key("left", () => {
    const sel = (pipeList as any).selected as number ?? 0;
    const item = flatPipeItems[sel];
    if (!item) return;
    if (item.kind === "folder" && item.isExpanded) {
      collapsedPipeFolders.add(item.key);
      refreshPipeList();
    } else {
      // navigate to parent folder
      const parentKey = item.key.slice(0, item.key.lastIndexOf("\\")) || "\\";
      const idx = flatPipeItems.findIndex(i => i.kind === "folder" && i.key === parentKey);
      if (idx >= 0) { (pipeList as any).select(idx); screen.render(); }
    }
  });

  stagesList.key(["escape"], () => showPipelines());
  stagesList.key("q", () => { screen.destroy(); process.exit(0); });
  stagesList.key("r", () => {
    if (selectedPipeline) {
      clearByPrefix(`runs_${ORG}_${PROJECT}_${selectedPipeline.id}`);
      clearByPrefix(`stages_${ORG}_${PROJECT}`);
      setStatus("Refreshing…", 0);
      loadStagesData();
    }
  });
  stagesList.key("b", () => {
    if (!selectedPipeline) return;
    const url = `https://dev.azure.com/${ORG}/${PROJECT}/_build?definitionId=${selectedPipeline.id}&_a=summary`;
    try { spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref(); } catch {}
  });
  stagesList.key("enter", () => {
    const sel = (stagesList as any).selected as number ?? 0;
    const m = stageListMeta[sel];
    if (!m || m.kind !== "branch" || !m.latestRunId) return;
    const url = `https://dev.azure.com/${ORG}/${PROJECT}/_build/results?buildId=${m.latestRunId}`;
    try { spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref(); } catch {}
  });

  // ── Data loading ──────────────────────────────────────────────────────────
  async function loadData() {
    setStatus("Loading environments…", 0);
    try {
      const token = await getToken(config.azConfigDir);

      // 1. Environment list
      const envs = await fetchAllEnvironments(ORG, PROJECT, token);
      rows = envs.map(env => ({
        env,
        mapping: config.mappings.find(m => m.environmentId === env.id),
        loading: true,
      }));
      refreshDashList();
      setStatus(`${envs.length} environments — loading deployments…`, 0);

      // 2. Pipeline definitions in background (needed for mapping view)
      fetchPipelineDefinitions(ORG, PROJECT, token)
        .then(defs => { pipelines = defs; })
        .catch(() => {});

      // 3. Deployment records, 10 at a time
      const BATCH = 10;
      for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH);
        await Promise.all(batch.map(async row => {
          row.deploy = (await fetchLatestDeployment(ORG, PROJECT, row.env.id, token)) ?? undefined;
          row.loading = false;
        }));
        refreshDashList();
        setStatus(`Deployments ${Math.min(i + BATCH, rows.length)}/${rows.length}…`, 0);
      }

      // 4. Build info (commit SHA) for environments that have deployments
      const withDeploy = rows.filter(r => r.deploy?.owner?.id);
      let done = 0;
      for (let i = 0; i < withDeploy.length; i += BATCH) {
        const batch = withDeploy.slice(i, i + BATCH);
        await Promise.all(batch.map(async row => {
          row.build = (await fetchBuildInfo(ORG, PROJECT, row.deploy!.owner.id, token)) ?? undefined;
          done++;
        }));
        refreshDashList();
        setStatus(`Build info ${done}/${withDeploy.length}…`, 0);
      }

      setStatus("", 0);
    } catch (e) {
      setStatus(`Error: ${(e as Error).message.slice(0, 80)}`, 10_000);
    }
  }

  if (STAGES_ARG) {
    // --stages mode: load pipeline definitions, then open the stages view directly
    showDashboard(); // show something while loading
    setStatus("Loading pipeline definitions…", 0);
    (async () => {
      try {
        const token = await getToken(config.azConfigDir);
        pipelines = await fetchPipelineDefinitions(ORG, PROJECT, token);
        const byId = Number(STAGES_ARG);
        const pip = byId
          ? pipelines.find(p => p.id === byId)
          : pipelines.find(p => p.name.toLowerCase() === STAGES_ARG!.toLowerCase());
        if (!pip) {
          setStatus(`Pipeline "${STAGES_ARG}" not found`, 10_000);
          return;
        }
        await showStages(pip);
      } catch (e) {
        setStatus(`Error: ${(e as Error).message.slice(0, 80)}`, 10_000);
      }
    })();
  } else {
    showDashboard();
    loadData();
  }
}

main().catch(err => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
