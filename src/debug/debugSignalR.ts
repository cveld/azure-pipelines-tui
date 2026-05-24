#!/usr/bin/env node
// Debug script: connect to Azure DevOps SignalR and dump all messages
//
// Usage:
//   tsx debugSignalR.ts https://dev.azure.com/ORG/PROJECT <buildId>
//   tsx debugSignalR.ts https://dev.azure.com/ORG/PROJECT/_build/results?buildId=<id>
//   tsx debugSignalR.ts https://dev.azure.com/ORG PROJECT <buildId>
//   tsx debugSignalR.ts ORG/PROJECT <buildId>

import https from "https";
import WebSocket from "ws";
import { execSync } from "child_process";
import { URL } from "url";

// ── Arg parsing ───────────────────────────────────────────────────────────────
function showUsage(): never {
  console.error(
    "Usage:\n" +
    "  tsx debugSignalR.ts https://dev.azure.com/ORG/PROJECT <buildId>\n" +
    "  tsx debugSignalR.ts https://dev.azure.com/ORG/PROJECT/_build/results?buildId=<id>\n" +
    "  tsx debugSignalR.ts https://dev.azure.com/ORG PROJECT <buildId>\n" +
    "  tsx debugSignalR.ts ORG/PROJECT <buildId>"
  );
  process.exit(1);
}

const positional = process.argv.slice(2).filter(a => !a.startsWith("--"));

let ORG: string, PROJECT: string, BUILD_ID: number;

const first = positional[0] ?? "";
if (first.startsWith("http")) {
  const u = new URL(first);
  const parts = u.pathname.split("/").filter(Boolean);
  ORG = parts[0] ?? "";
  const bidParam = u.searchParams.get("buildId");
  if (parts.length >= 2 && !parts[1].startsWith("_")) {
    // https://dev.azure.com/ORG/PROJECT[/...][?buildId=N]
    PROJECT  = parts[1];
    BUILD_ID = bidParam ? Number(bidParam) : Number(positional[1] ?? "0");
  } else {
    // https://dev.azure.com/ORG  PROJECT  buildId
    PROJECT  = positional[1] ?? "";
    BUILD_ID = Number(positional[2] ?? "0");
  }
} else if (first.includes("/")) {
  // ORG/PROJECT  buildId
  const slash = first.indexOf("/");
  ORG      = first.slice(0, slash);
  PROJECT  = first.slice(slash + 1);
  BUILD_ID = Number(positional[1] ?? "0");
} else {
  showUsage();
}

if (!ORG || !PROJECT || !BUILD_ID) showUsage();

const ADO_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798";

function getToken(): string {
  const raw = execSync(
    `az account get-access-token --resource ${ADO_RESOURCE} --output json`,
    { encoding: "utf8" }
  );
  return (JSON.parse(raw) as { accessToken: string }).accessToken;
}

function getProjectId(org: string, project: string): string {
  const raw = execSync(
    `az devops project show --project "${project}" --organization https://dev.azure.com/${org} --query id -o tsv`,
    { encoding: "utf8" }
  );
  return raw.trim();
}

function httpGet(url: string, token: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.get(
      { hostname: u.hostname, path: u.pathname + u.search,
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } },
      res => {
        // Follow redirects
        if ((res.statusCode ?? 0) >= 300 && (res.statusCode ?? 0) < 400) {
          const loc = res.headers["location"]!;
          res.resume();
          return resolve(httpGet(loc.startsWith("http") ? loc : `https://${u.hostname}${loc}`, token));
        }
        let data = "";
        res.on("data", (c: string) => (data += c));
        res.on("end", () => resolve(data));
      }
    );
    req.on("error", reject);
  });
}

async function main() {
  const token     = getToken();
  const projectId = getProjectId(ORG, PROJECT);
  console.log("projectId:", projectId);
  const orgEncoded = encodeURIComponent(ORG);

  // 1. Get instanceId (org-level, used for negotiate)
  const connData = JSON.parse(await httpGet(
    `https://dev.azure.com/${orgEncoded}/_apis/connectionData?connectOptions=0&lastChangeId=-1&lastChangeId64=-1`,
    token
  )) as { instanceId: string };
  console.log("instanceId (for negotiate):", connData.instanceId);

  // 2. Negotiate with instanceId → returns contextToken
  const CONNECTION_DATA = encodeURIComponent(JSON.stringify([
    { name: "builddetailhub" },
    { name: "taskagentpoolhub" },
  ]));
  const negotiateUrl =
    `https://dev.azure.com/_signalr/${orgEncoded}/_apis/${connData.instanceId}/signalr/negotiate` +
    `?transport=webSockets&clientProtocol=1.5&connectionData=${CONNECTION_DATA}&_=${Date.now()}`;
  console.log("negotiate URL:", negotiateUrl);

  const negotiated = JSON.parse(await httpGet(negotiateUrl, token)) as {
    Url?: string; ConnectionToken: string; ConnectionId: string;
  };
  console.log("negotiate response:", JSON.stringify(negotiated, null, 2));

  // Extract contextToken from Url field
  const contextToken = negotiated.Url?.match(/\/_apis\/([0-9a-f-]{36})\//i)?.[1];
  console.log("contextToken:", contextToken);

  // 3. Connect WebSocket — projectId in path, contextToken (from negotiate) as query param
  const wsUrl =
    `wss://dev.azure.com/_signalr/${orgEncoded}/_apis/${projectId}/signalr/connect` +
    `?transport=webSockets&clientProtocol=1.5` +
    `&connectionToken=${encodeURIComponent(negotiated.ConnectionToken)}` +
    `&connectionData=${CONNECTION_DATA}` +
    (contextToken ? `&contextToken=${encodeURIComponent(contextToken)}` : "") +
    `&tid=0`;
  console.log("WebSocket URL:", wsUrl);

  const ws = new WebSocket(wsUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Sec-WebSocket-Protocol": `Bearer, ${token}`,
    },
  });

  ws.on("open", async () => {
    console.log("WebSocket open");

    // Start
    try {
      const startResp = await httpGet(
        `https://dev.azure.com/_signalr/${orgEncoded}/_apis/${connData.instanceId}/signalr/start` +
        `?transport=webSockets&clientProtocol=1.5` +
        `&connectionToken=${encodeURIComponent(negotiated.ConnectionToken)}` +
        `&connectionData=${CONNECTION_DATA}&_=${Date.now()}`,
        token
      );
      console.log("start response:", startResp);
    } catch (e) {
      console.log("start error:", (e as Error).message);
    }

    // WatchBuild(projectId: Guid, buildId: Int32) — confirmed signature
    const msg = JSON.stringify({ H: "builddetailhub", M: "WatchBuild", A: [projectId, BUILD_ID], I: "1" });
    console.log("→ sending:", msg);
    ws.send(msg);
  });

  ws.on("message", (raw: Buffer) => {
    const text = raw.toString();
    if (text === "{}") { process.stdout.write("."); return; }
    console.log("\n← received:", text);
  });

  ws.on("close",  ()  => { console.log("\nWebSocket closed"); process.exit(0); });
  ws.on("error",  (e) => { console.log("WebSocket error:", e.message); });

  // Run for 2 minutes
  setTimeout(() => { console.log("\nTimeout — closing"); ws.close(); }, 120_000);
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
