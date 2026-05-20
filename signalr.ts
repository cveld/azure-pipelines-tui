// Azure DevOps SignalR client (ASP.NET SignalR 1.x over WebSocket)

import https from "https";
import WebSocket from "ws";
import { URL } from "url";
import fs from "fs";

// ── SignalR protocol types ────────────────────────────────────────────────────
interface NegotiateResponse {
  Url?: string;
  ConnectionToken: string;
  ConnectionId: string;
  ContextToken?: string;
}

interface SignalRFrame {
  C?: string;                                           // cursor (message id)
  M?: Array<{ H: string; M: string; A: unknown[] }>;   // hub messages
  I?: string;                                           // invocation result id
  E?: string;                                           // error
}

export interface HubEvent {
  hub: string;
  method: string;
  args: unknown[];
}

export interface SignalRHandle {
  invoke(hub: string, method: string, ...args: unknown[]): void;
  close(): void;
}

// ── HTTP helper (standalone, no shared state with index.ts) ──────────────────
function getJson<T>(url: string, token: string, redirectsLeft = 5): Promise<T> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    https
      .get(
        { hostname: u.hostname, path: u.pathname + u.search,
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            const loc = res.headers["location"];
            res.resume();
            if (!loc || redirectsLeft <= 0)
              return reject(new Error(`HTTP ${status}: redirect limit reached (Location: ${loc ?? "none"})`));
            const next = loc.startsWith("http") ? loc : `https://${u.hostname}${loc}`;
            return resolve(getJson<T>(next, token, redirectsLeft - 1));
          }
          let data = "";
          res.on("data", (c: string) => (data += c));
          res.on("end", () => {
            if (status >= 400)
              return reject(new Error(`HTTP ${status}: ${data.slice(0, 200)}`));
            try { resolve(JSON.parse(data) as T); }
            catch (e) { reject(new Error(`JSON: ${(e as Error).message}`)); }
          });
        }
      )
      .on("error", reject);
  });
}

// ── Main export ───────────────────────────────────────────────────────────────
// projectId: the project GUID (e.g. from `az devops project show --query id`)
export async function connectSignalR(
  org: string,
  projectId: string,
  token: string,
  onEvent: (event: HubEvent) => void,
  onStatus: (msg: string) => void,
  onClose?: () => void,
): Promise<SignalRHandle> {
  const CONNECTION_DATA = JSON.stringify([
    { name: "builddetailhub" },
    { name: "taskagentpoolhub" },
  ]);
  const encodedData = encodeURIComponent(CONNECTION_DATA);
  const orgEncoded  = encodeURIComponent(org);

  // ── 1. Instance ID (org-level, used for negotiate + start) ────────────────
  onStatus("SignalR: fetching instance id…");
  const { instanceId } = await getJson<{ instanceId: string }>(
    `https://dev.azure.com/${orgEncoded}/_apis/connectionData` +
    `?connectOptions=0&lastChangeId=-1&lastChangeId64=-1`,
    token
  );

  // ── 2. Negotiate (uses instanceId → returns contextToken) ─────────────────
  onStatus("SignalR: negotiating…");
  const negotiated = await getJson<NegotiateResponse>(
    `https://dev.azure.com/_signalr/${orgEncoded}/_apis/${instanceId}/signalr/negotiate` +
    `?transport=webSockets&clientProtocol=1.5&connectionData=${encodedData}&_=${Date.now()}`,
    token
  );
  fs.writeFileSync("signalr-negotiate.json", JSON.stringify(negotiated, null, 2));

  // contextToken comes from the negotiate Url field: /_signalr/_apis/{guid}/signalr
  const contextToken =
    negotiated.ContextToken ??
    negotiated.Url?.match(/\/_apis\/([0-9a-f-]{36})\//i)?.[1];

  // ── 3. Connect WebSocket (uses projectId in path, contextToken as param) ──
  onStatus("SignalR: connecting…");
  const wsUrl =
    `wss://dev.azure.com/_signalr/${orgEncoded}/_apis/${projectId}/signalr/connect` +
    `?transport=webSockets&clientProtocol=1.5` +
    `&connectionToken=${encodeURIComponent(negotiated.ConnectionToken)}` +
    `&connectionData=${encodedData}` +
    (contextToken ? `&contextToken=${encodeURIComponent(contextToken)}` : "") +
    `&tid=${Math.floor(Math.random() * 20)}`;

  const ws = new WebSocket(wsUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Sec-WebSocket-Protocol": `Bearer, ${token}`,
    },
  });

  await new Promise<void>((resolve, reject) => {
    ws.once("open",  resolve);
    ws.once("error", reject);
  });

  // ── 4. Start (uses instanceId) ────────────────────────────────────────────
  try {
    await getJson<unknown>(
      `https://dev.azure.com/_signalr/${orgEncoded}/_apis/${instanceId}/signalr/start` +
      `?transport=webSockets&clientProtocol=1.5` +
      `&connectionToken=${encodeURIComponent(negotiated.ConnectionToken)}` +
      `&connectionData=${encodedData}&_=${Date.now()}`,
      token
    );
  } catch { /* start returns empty body, not JSON */ }

  onStatus("SignalR: connected ●");

  // ── Message handler ────────────────────────────────────────────────────────
  ws.on("message", (raw: Buffer) => {
    const text = raw.toString();
    fs.appendFileSync("signalr-messages.jsonl", text + "\n");
    if (text === "{}") return;
    try {
      const frame = JSON.parse(text) as SignalRFrame;
      for (const msg of frame.M ?? [])
        onEvent({ hub: msg.H ?? "", method: msg.M ?? "", args: msg.A ?? [] });
    } catch { /* malformed frame */ }
  });

  ws.on("close", () => { onStatus("SignalR: disconnected"); onClose?.(); });
  ws.on("error", (e) => onStatus(`SignalR error: ${e.message}`));

  // ── Handle ─────────────────────────────────────────────────────────────────
  let invId = 0;
  return {
    invoke(hub, method, ...args) {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ H: hub, M: method, A: args, I: String(invId++) }));
    },
    close() { ws.close(); },
  };
}
