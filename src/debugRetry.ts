#!/usr/bin/env node
/**
 * debugRetry.ts — standalone debug script for stage retry
 *
 * Usage:
 *   npx tsx debugRetry.ts <org>/<project> <buildId> [stageRef]
 *   npx tsx debugRetry.ts IGH-Solution/IGH-Platform-Azure 12345
 *   npx tsx debugRetry.ts IGH-Solution/IGH-Platform-Azure 12345 MyStage
 *
 * Without stageRef: lists all stages with state/result.
 * With stageRef: tries all state values (1 and 2) and forceRetryAllJobs combos.
 */

import https from "https";
import { execSync } from "child_process";

const ADO_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798";
const API_VER = "api-version=7.1";

const [orgProject, buildId, stageRef] = process.argv.slice(2);
if (!orgProject || !buildId) {
  console.error("Usage: npx tsx debugRetry.ts <org>/<project> <buildId> [stageRef]");
  process.exit(1);
}
const [org, ...rest] = orgProject.split("/");
const project = rest.join("/");
const ADO_BASE = `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/build/builds/${buildId}`;

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
          console.log(`  GET ${url} → ${res.statusCode}`);
          if ((res.statusCode ?? 0) >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          resolve(JSON.parse(data) as T);
        });
      }
    ).on("error", reject);
  });
}

function httpPatch<T>(url: string, token: string, body: unknown): Promise<{ status: number; body: string; parsed?: T }> {
  return new Promise((resolve) => {
    const u = new URL(url);
    const payload = JSON.stringify(body);
    console.log(`  PATCH ${url}`);
    console.log(`  Body: ${payload}`);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      res => {
        let data = "";
        res.on("data", (c: string) => (data += c));
        res.on("end", () => {
          let parsed: T | undefined;
          try { parsed = JSON.parse(data) as T; } catch { /* raw */ }
          resolve({ status: res.statusCode ?? 0, body: data, parsed });
        });
      }
    );
    req.on("error", (e) => resolve({ status: 0, body: String(e) }));
    req.write(payload);
    req.end();
  });
}

interface TimelineRecord {
  id: string;
  name: string;
  identifier?: string;
  type: string;
  state: string;
  result?: string;
  order?: number;
}

async function main() {
  console.log(`\nOrg: ${org}  Project: ${project}  BuildId: ${buildId}`);
  console.log("Fetching token…");
  const token = getToken();
  console.log("Token OK\n");

  // Fetch timeline
  const timeline = await httpGet<{ records: TimelineRecord[] }>(
    `${ADO_BASE}/timeline?${API_VER}`, token
  );

  const stages = timeline.records
    .filter(r => r.type === "Stage")
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  console.log("\n── Stages ────────────────────────────────────────────────────────");
  for (const s of stages) {
    const ref = s.identifier ?? s.name;
    console.log(`  [order=${s.order ?? "?"}] ${s.name.padEnd(40)} state=${s.state.padEnd(12)} result=${s.result ?? "(none)".padEnd(20)} ref="${ref}"`);
  }
  console.log("");

  if (!stageRef) {
    console.log("Pass a stageRef as third argument to test retry.");
    return;
  }

  const target = stages.find(s => (s.identifier ?? s.name) === stageRef);
  if (!target) {
    console.warn(`Stage "${stageRef}" not found. Check spelling against the list above.`);
    return;
  }

  console.log(`\n── Testing retry on stage "${target.name}" (ref: ${stageRef}) ────`);
  console.log(`   Current state: ${target.state}, result: ${target.result ?? "(none)"}\n`);

  const url = `${ADO_BASE}/stages/${encodeURIComponent(stageRef)}?${API_VER}`;

  const combos: Array<{ state: number; forceRetryAllJobs: boolean; retryDependencies?: boolean }> = [
    { state: 1, forceRetryAllJobs: true,  retryDependencies: true },
    { state: 1, forceRetryAllJobs: true,  retryDependencies: false },
    { state: 1, forceRetryAllJobs: false, retryDependencies: true },
    { state: 1, forceRetryAllJobs: false, retryDependencies: false },
    { state: 2, forceRetryAllJobs: true,  retryDependencies: true },
    { state: 2, forceRetryAllJobs: true,  retryDependencies: false },
    { state: 2, forceRetryAllJobs: false, retryDependencies: true },
    { state: 2, forceRetryAllJobs: false, retryDependencies: false },
  ];

  for (const combo of combos) {
    console.log(`\n[state=${combo.state}, forceRetryAllJobs=${combo.forceRetryAllJobs}, retryDependencies=${combo.retryDependencies}]`);
    const result = await httpPatch(url, token, combo);
    console.log(`  Response ${result.status}: ${result.body.slice(0, 300)}`);
    if (result.status < 400) {
      console.log("  ✓ SUCCESS — this combo works!");
      await pollStageState(token, stageRef);
      break;
    }
  }
}

async function pollStageState(token: string, ref: string, timeoutMs = 60_000, intervalMs = 2_000) {
  console.log(`\n── Polling stage state (timeout ${timeoutMs / 1000}s) ────────────────`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const timeline = await httpGet<{ records: Array<{ name: string; identifier?: string; type: string; state: string; result?: string }> }>(
      `${ADO_BASE}/timeline?${API_VER}`, token
    );
    const stage = timeline.records.find(
      r => r.type === "Stage" && (r.identifier ?? r.name) === ref
    );
    if (!stage) { console.log("  Stage not found in timeline"); break; }
    const ts = new Date().toISOString().slice(11, 19);
    console.log(`  [${ts}] state=${stage.state}  result=${stage.result ?? "(none)"}`);
    if (stage.state === "inProgress" || stage.state === "pending") {
      console.log("  ✓ Stage transitioned — retry confirmed working.");
      break;
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
