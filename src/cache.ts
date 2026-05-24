// cache.ts — File-based TTL cache for Azure Pipelines TUI

import fs from "fs";
import path from "path";
import os from "os";

const CACHE_DIR = path.join(os.homedir(), ".azure-pipelines-tui", "cache");

function sanitize(key: string): string {
  return key.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200);
}

function filePath(key: string): string {
  return path.join(CACHE_DIR, sanitize(key) + ".json");
}

export function readCache<T>(key: string): T | null {
  try {
    const raw = fs.readFileSync(filePath(key), "utf8");
    const { data, cachedAt, ttl } = JSON.parse(raw) as { data: T; cachedAt: number; ttl: number };
    if (Date.now() - cachedAt < ttl) return data;
  } catch {}
  return null;
}

export function writeCache<T>(key: string, data: T, ttlMs: number): void {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(
    filePath(key),
    JSON.stringify({ data, cachedAt: Date.now(), ttl: ttlMs }),
    "utf8"
  );
}

export function clearAllCache(): void {
  try { fs.rmSync(CACHE_DIR, { recursive: true, force: true }); } catch {}
}

export function clearByPrefix(prefix: string): void {
  const sp = sanitize(prefix);
  try {
    for (const f of fs.readdirSync(CACHE_DIR)) {
      if (f.startsWith(sp)) {
        try { fs.unlinkSync(path.join(CACHE_DIR, f)); } catch {}
      }
    }
  } catch {}
}
