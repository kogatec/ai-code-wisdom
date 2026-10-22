import fs from "node:fs";
import path from "node:path";
import type { ProjectPaths } from "./paths.ts";

export function appendLedger(paths: ProjectPaths, event: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(paths.ledger), { recursive: true });
  fs.appendFileSync(paths.ledger, JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n");
}

export function readLedger(paths: ProjectPaths): Record<string, unknown>[] {
  if (!fs.existsSync(paths.ledger)) return [];
  const out: Record<string, unknown>[] = [];
  for (const line of fs.readFileSync(paths.ledger, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // 壊れた行は読み飛ばす
    }
  }
  return out;
}
