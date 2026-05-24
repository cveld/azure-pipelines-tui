import https from "https";
import { execSync } from "child_process";
import { URL } from "url";
import fs from "fs";
import type { IncomingMessage } from "http";
import { readCache, writeCache } from "../cache.js";
import type {
  AzTokenResponse, AdoEnvironment, DeploymentRecord, BuildInfo,
  PipelineDefinition, PipelineRun, StageInfo, Build, Timeline, LogContent,
  DashboardConfig, AdoOrg, AdoProject,
} from "./types.js";

// ── Config ────────────────────────────────────────────────────────────────────

export function loadConfig(configFile: string): DashboardConfig {
  try { return JSON.parse(fs.readFileSync(configFile, "utf8")) as DashboardConfig; }
  catch { return { mappings: [] }; }
}

export function saveConfig(configFile: string, cfg: DashboardConfig): void {
  fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2), "utf8");
}

// ── Token management ──────────────────────────────────────────────────────────

const ADO_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798";
let cachedToken: string | null = null;
let tokenExpiry = 0;

export async function getToken(azConfigDir?: string): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiry - 60_000) return cachedToken;
  const env = azConfigDir ? { ...process.env, AZURE_CONFIG_DIR: azConfigDir } : process.env;
  const raw = execSync(
    `az account get-access-token --resource ${ADO_RESOURCE} --output json`,
    { encoding: "utf8", env }
  );
  const { accessToken, expiresOn } = JSON.parse(raw) as AzTokenResponse;
  cachedToken = accessToken;
  tokenExpiry = new Date(expiresOn).getTime();
  return cachedToken;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

export function httpGet<T>(reqUrl: string, token: string, accept = "application/json"): Promise<T> {
  return new Promise((resolve, reject) => {
    const u = new URL(reqUrl);
    https.get(
      { hostname: u.hostname, path: u.pathname + u.search,
        headers: { Authorization: `Bearer ${token}`, Accept: accept } },
      (res: IncomingMessage) => {
        let data = "";
        res.on("data", (c: string) => (data += c));
        res.on("end", () => {
          if ((res.statusCode ?? 0) >= 400)
            return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          try { resolve((accept === "application/json" ? JSON.parse(data) : data) as T); }
          catch (e) { reject(e); }
        });
      }
    ).on("error", reject);
  });
}

export function httpGetPaged<T>(reqUrl: string, token: string): Promise<{ data: T; ct?: string }> {
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

export function httpPatch<T>(reqUrl: string, token: string, body: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const u = new URL(reqUrl);
    const payload = JSON.stringify(body);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        } },
      res => {
        let data = "";
        res.on("data", (c: string) => (data += c));
        res.on("end", () => {
          if ((res.statusCode ?? 0) >= 400)
            return reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          resolve((data ? JSON.parse(data) : {}) as T);
        });
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ── ADO API ───────────────────────────────────────────────────────────────────

export const API_VER = "api-version=7.1";
export const enc = encodeURIComponent;

export async function fetchAllEnvironments(org: string, project: string, token: string): Promise<AdoEnvironment[]> {
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

export async function fetchLatestDeployment(
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

export async function fetchBuildInfo(
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

export async function fetchPipelineDefinitions(org: string, project: string, token: string): Promise<PipelineDefinition[]> {
  const ckey = `pipelines_${org}_${project}`;
  const cached = readCache<PipelineDefinition[]>(ckey);
  if (cached) return cached;
  const url = `https://dev.azure.com/${enc(org)}/${enc(project)}/_apis/build/definitions?$top=1000&${API_VER}`;
  const data = await httpGet<{ value: PipelineDefinition[] }>(url, token);
  const defs = (data.value ?? []).sort((a, b) => a.name.localeCompare(b.name));
  writeCache(ckey, defs, 10 * 60_000);
  return defs;
}

export async function fetchPipelineRuns(
  org: string, project: string, pipelineId: number, token: string, top = 50
): Promise<PipelineRun[]> {
  const ckey = `runs_${org}_${project}_${pipelineId}`;
  const cached = readCache<PipelineRun[]>(ckey);
  if (cached) return cached;
  const url = `https://dev.azure.com/${enc(org)}/${enc(project)}/_apis/build/builds?definitions=${pipelineId}&$top=${top}&${API_VER}`;
  const data = await httpGet<{ value: PipelineRun[] }>(url, token);
  const runs = (data.value ?? []).sort((a, b) => b.id - a.id);
  writeCache(ckey, runs, 2 * 60_000);
  return runs;
}

export async function fetchRunStages(
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
    type RawRecord = { id: string; parentId?: string | null; type: string; name: string; state: string; result?: string; order?: number; finishTime?: string; warningCount?: number };
    const data = await httpGet<{ records: RawRecord[] }>(url, token);
    const allRecords = data.records ?? [];
    const childIds = new Set(allRecords.map(r => r.parentId).filter(Boolean) as string[]);
    const childrenOf = new Map<string, RawRecord[]>();
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

export async function fetchProjectId(org: string, project: string, token: string): Promise<string> {
  const { id } = await httpGet<{ id: string }>(
    `https://dev.azure.com/${enc(org)}/_apis/projects/${enc(project)}?${API_VER}`, token
  );
  return id;
}

export function buildBase(org: string, project: string, buildId: string): string {
  return `https://dev.azure.com/${enc(org)}/${enc(project)}/_apis/build/builds/${buildId}`;
}

export async function fetchBuild(org: string, project: string, buildId: string, token: string): Promise<Build> {
  return httpGet<Build>(`${buildBase(org, project, buildId)}?${API_VER}`, token);
}

export async function fetchTimeline(org: string, project: string, buildId: string, token: string): Promise<Timeline | null> {
  return httpGet<Timeline>(`${buildBase(org, project, buildId)}/timeline?${API_VER}`, token).catch(() => null);
}

export async function fetchLogLines(
  org: string, project: string, buildId: string, logId: number, startLine: number, token: string
): Promise<LogContent | null> {
  return httpGet<LogContent>(
    `${buildBase(org, project, buildId)}/logs/${logId}?startLine=${startLine}&${API_VER}`, token
  ).catch(() => null);
}

export async function fetchOrgs(token: string): Promise<AdoOrg[]> {
  const conn = await httpGet<{ authenticatedUser: { id: string } }>(
    `https://app.vssps.visualstudio.com/_apis/connectionData`, token
  );
  const memberId = conn.authenticatedUser.id;
  const data = await httpGet<{ value: AdoOrg[] }>(
    `https://app.vssps.visualstudio.com/_apis/accounts?memberId=${memberId}&api-version=7.1-preview.1`, token
  );
  return (data.value ?? []).sort((a, b) => a.accountName.localeCompare(b.accountName));
}

export async function fetchProjects(org: string, token: string): Promise<AdoProject[]> {
  const data = await httpGet<{ value: AdoProject[] }>(
    `https://dev.azure.com/${enc(org)}/_apis/projects?$top=200&stateFilter=wellFormed&${API_VER}`, token
  );
  return (data.value ?? []).sort((a, b) => a.name.localeCompare(b.name));
}
