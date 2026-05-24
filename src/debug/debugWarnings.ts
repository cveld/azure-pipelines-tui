#!/usr/bin/env node
/**
 * debugWarnings.ts — report warning counts per stage/job/task for a build
 *
 * Usage:
 *   npx tsx debugWarnings.ts <org>/<project> <buildId> [--logs]
 *
 * Without --logs: prints a tree of stages/jobs/tasks with warning counts.
 * With    --logs: also fetches log content and prints each ##[warning] line.
 */

import https from "https";
import { execSync } from "child_process";

const ADO_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798";
const API_VER = "api-version=7.1";

const rawArgs = process.argv.slice(2);
const [orgProject, buildId] = rawArgs.filter(a => !a.startsWith("--"));
const showLogs = rawArgs.includes("--logs");

if (!orgProject || !buildId) {
  console.error("Usage: npx tsx debugWarnings.ts <org>/<project> <buildId> [--logs]");
  process.exit(1);
}

const [org, ...rest] = orgProject.split("/");
const project = rest.join("/");
const enc = encodeURIComponent;
const ADO_BASE = `https://dev.azure.com/${enc(org)}/${enc(project)}/_apis/build/builds/${buildId}`;

function getToken(): string {
  const raw = execSync(
    `az account get-access-token --resource ${ADO_RESOURCE} --output json`,
    { encoding: "utf8", env: { ...process.env, AZURE_CONFIG_DIR: process.env["AZURE_CONFIG_DIR"] } }
  );
  return (JSON.parse(raw) as { accessToken: string }).accessToken;
}

function httpGet<T>(url: string, token: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    https.get(
      { hostname: u.hostname, path: u.pathname + u.search,
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } },
      res => {
        let data = "";
        res.on("data", (c: string) => (data += c));
        res.on("end", () => {
          if ((res.statusCode ?? 0) >= 400)
            return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
          resolve(JSON.parse(data) as T);
        });
      }
    ).on("error", reject);
  });
}

function httpGetText(url: string, token: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    https.get(
      { hostname: u.hostname, path: u.pathname + u.search,
        headers: { Authorization: `Bearer ${token}`, Accept: "text/plain" } },
      res => {
        let data = "";
        res.on("data", (c: string) => (data += c));
        res.on("end", () => {
          if ((res.statusCode ?? 0) >= 400)
            return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
          resolve(data);
        });
      }
    ).on("error", reject);
  });
}

interface TimelineRecord {
  id: string;
  parentId?: string | null;
  type: string;
  name: string;
  state: string;
  result?: string;
  order?: number;
  warningCount?: number;
  errorCount?: number;
  log?: { id: number; url: string };
}

function badge(warnings: number, errors: number): string {
  const parts: string[] = [];
  if (warnings > 0) parts.push(`⚠ ${warnings}w`);
  if (errors   > 0) parts.push(`✗ ${errors}e`);
  return parts.length ? `  [${parts.join("  ")}]` : "";
}

async function main() {
  console.log(`\nOrg: ${org}  Project: ${project}  BuildId: ${buildId}`);
  console.log("Fetching token…");
  const token = getToken();
  console.log("Token OK\n");

  const timeline = await httpGet<{ records: TimelineRecord[] }>(
    `${ADO_BASE}/timeline?${API_VER}`, token
  );
  const records = timeline.records ?? [];

  // Build parent → children index
  const children = new Map<string | null, TimelineRecord[]>();
  for (const r of records) {
    const p = r.parentId ?? null;
    if (!children.has(p)) children.set(p, []);
    children.get(p)!.push(r);
  }

  // Stages = top-level records of type Stage
  const stages = (children.get(null) ?? [])
    .filter(r => r.type === "Stage")
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  // Totals from leaf records only (Tasks have no children) to avoid double-counting.
  // Stage/Phase/Job warningCount is often 0 even when children have warnings.
  const hasChildren = new Set(records.map(r => r.parentId).filter(Boolean) as string[]);
  let totalWarnings = 0;
  let totalErrors   = 0;
  for (const r of records) {
    if (!hasChildren.has(r.id)) {
      totalWarnings += r.warningCount ?? 0;
      totalErrors   += r.errorCount   ?? 0;
    }
  }

  function sumDescendants(nodeId: string): { warnings: number; errors: number } {
    const kids = children.get(nodeId) ?? [];
    if (kids.length === 0) return { warnings: 0, errors: 0 };
    let w = 0, e = 0;
    for (const kid of kids) {
      if (!hasChildren.has(kid.id)) {
        w += kid.warningCount ?? 0;
        e += kid.errorCount   ?? 0;
      } else {
        const s = sumDescendants(kid.id);
        w += s.warnings; e += s.errors;
      }
    }
    return { warnings: w, errors: e };
  }

  // Collect tasks with logs that have warnings (for --logs mode)
  const warningTasks: Array<{ name: string; logUrl: string }> = [];

  function printTree(nodes: TimelineRecord[], indent: string) {
    const sorted = [...nodes].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    for (const node of sorted) {
      const w = node.warningCount ?? 0;
      const e = node.errorCount   ?? 0;
      const b = badge(w, e);
      console.log(`${indent}${node.type.padEnd(6)} ${node.name}${b}`);
      if (showLogs && w > 0 && node.log?.url) {
        warningTasks.push({ name: node.name, logUrl: node.log.url });
      }
      const kids = children.get(node.id) ?? [];
      if (kids.length) printTree(kids, indent + "  ");
    }
  }

  console.log("── Warning/Error tree ────────────────────────────────────────────");
  for (const stage of stages) {
    const { warnings: sw, errors: se } = sumDescendants(stage.id);
    console.log(`\nSTAGE  ${stage.name}  (state=${stage.state}  result=${stage.result ?? "—"})${badge(sw, se)}`);
    const kids = children.get(stage.id) ?? [];
    printTree(kids, "  ");
  }

  console.log(`\n── Totals ────────────────────────────────────────────────────────`);
  console.log(`  Warnings: ${totalWarnings}`);
  console.log(`  Errors  : ${totalErrors}`);

  if (!showLogs || warningTasks.length === 0) return;

  console.log(`\n── Warning log lines (${warningTasks.length} tasks) ──────────────────────────`);
  for (const task of warningTasks) {
    console.log(`\n  [${task.name}]`);
    try {
      const text = await httpGetText(
        `${task.logUrl}?${API_VER}`, token
      );
      const lines = text.split("\n").filter(l => /##\[warning\]/i.test(l));
      if (lines.length === 0) {
        console.log("    (no ##[warning] lines found in log)");
      } else {
        for (const line of lines) console.log(`    ${line.trim()}`);
      }
    } catch (e) {
      console.log(`    Error fetching log: ${(e as Error).message}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
