import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** このパッケージ（＝ Claude Code プラグイン）のルート。src/core/ から2つ上 */
export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const BUNDLED_PACKS_DIR = path.join(PLUGIN_ROOT, "packs");

/** 検査できる拡張子と、ast-grep の言語名 */
export const LANGUAGE_BY_EXT: Record<string, "typescript" | "python"> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "typescript",
  ".py": "python",
  ".pyi": "python",
};

export function languageOf(file: string): "typescript" | "python" | null {
  return LANGUAGE_BY_EXT[path.extname(file).toLowerCase()] ?? null;
}

export interface ProjectPaths {
  root: string;
  wisdomDir: string;
  profile: string;
  lock: string;
  packsDir: string;
  cacheDir: string;
  sessionsDir: string;
  ledger: string;
  decisions: string;
  auditHistory: string;
}

/** wisdomDir を指定すると、プロジェクトの外に設定を置ける（評価で使う） */
export function projectPaths(root: string, wisdomDir = path.join(root, ".wisdom")): ProjectPaths {
  const absRoot = path.resolve(root);
  const absWisdom = path.resolve(wisdomDir);
  return {
    root: absRoot,
    wisdomDir: absWisdom,
    profile: path.join(absWisdom, "profile.yaml"),
    lock: path.join(absWisdom, "lock.json"),
    packsDir: path.join(absWisdom, "packs"),
    cacheDir: path.join(absWisdom, "cache"),
    sessionsDir: path.join(absWisdom, "cache", "sessions"),
    ledger: path.join(absWisdom, "ledger.jsonl"),
    decisions: path.join(absWisdom, "decisions.md"),
    auditHistory: path.join(absWisdom, "audit-history.jsonl"),
  };
}

/** start から親へたどり、.wisdom/profile.yaml がある場所を探す */
export function findProjectRoot(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".wisdom", "profile.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** プロジェクトルートからの相対パス（区切りは常に /）。外側なら null */
export function relativeToRoot(root: string, file: string): string | null {
  const rel = path.relative(root, path.resolve(root, file));
  // "..foo" のように .. で始まる名前は中にある
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

/** 書き込みが途中で途切れても壊れたファイルが残らないように、一時ファイル経由で置き換える */
export function writeFileAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}
