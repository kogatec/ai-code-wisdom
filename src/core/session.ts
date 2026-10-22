import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic, type ProjectPaths } from "./paths.ts";

export interface FileState {
  file: string;
  existedAtStart: boolean;
  /** このセッションで最初に触る前の指紋 */
  firstBaseline: string[];
  /** 直前の編集の前の指紋 */
  lastBaseline: string[];
  blockedCounts: Record<string, number>;
  changedLines: number;
  contextShown: boolean;
}
export interface SessionMeta {
  reviewRequested: boolean;
  createdAt: string;
}

function sessionDir(paths: ProjectPaths, sessionId: string): string {
  return path.join(paths.sessionsDir, sessionId.replace(/[^A-Za-z0-9_-]/g, "_"));
}

function stateFile(paths: ProjectPaths, sessionId: string, relFile: string): string {
  const key = crypto.createHash("sha1").update(relFile).digest("hex").slice(0, 16);
  return path.join(sessionDir(paths, sessionId), "files", `${key}.json`);
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export function readFileState(paths: ProjectPaths, sessionId: string, relFile: string): FileState | null {
  return readJson<FileState>(stateFile(paths, sessionId, relFile));
}

export function writeFileState(paths: ProjectPaths, sessionId: string, state: FileState): void {
  writeFileAtomic(stateFile(paths, sessionId, state.file), JSON.stringify(state));
}

export function listFileStates(paths: ProjectPaths, sessionId: string): FileState[] {
  const dir = path.join(sessionDir(paths, sessionId), "files");
  if (!fs.existsSync(dir)) return [];
  const states: FileState[] = [];
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
    const state = readJson<FileState>(path.join(dir, name));
    if (state) states.push(state);
  }
  return states;
}

export function readMeta(paths: ProjectPaths, sessionId: string): SessionMeta {
  const meta = readJson<SessionMeta>(path.join(sessionDir(paths, sessionId), "meta.json"));
  return meta ?? { reviewRequested: false, createdAt: new Date().toISOString() };
}

export function writeMeta(paths: ProjectPaths, sessionId: string, meta: SessionMeta): void {
  writeFileAtomic(path.join(sessionDir(paths, sessionId), "meta.json"), JSON.stringify(meta));
}

/** セッションのフォルダの中で最後に更新された時刻 */
function lastTouched(dir: string): number {
  let latest = fs.statSync(dir).mtimeMs;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    latest = Math.max(latest, e.isDirectory() ? lastTouched(full) : fs.statSync(full).mtimeMs);
  }
  return latest;
}

export function cleanupOldSessions(paths: ProjectPaths, maxAgeDays = 7): void {
  if (!fs.existsSync(paths.sessionsDir)) return;
  const limit = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  for (const e of fs.readdirSync(paths.sessionsDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const dir = path.join(paths.sessionsDir, e.name);
    try {
      if (lastTouched(dir) < limit) fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // 別のフックが同時に消した場合などは無視する
    }
  }
}
