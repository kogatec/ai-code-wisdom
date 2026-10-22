import fs from "node:fs";
import path from "node:path";
import { git } from "./git.ts";
import { languageOf, writeFileAtomic } from "./paths.ts";

/** これがあれば TypeScript / Python のプロジェクトとみなす */
const PROJECT_MARKERS = ["package.json", "tsconfig.json", "pyproject.toml", "setup.py", "requirements.txt"];
/** 依存や生成物の置き場は、ソースを探すときに見ない（. で始まるものも見ない） */
const SKIPPED_DIRS = new Set(["node_modules", "dist", "build", "venv", "__pycache__"]);

const FIRST_RUN_OFFER = [
  "[AI Code Wisdom] このプロジェクトは、まだ設計スタイルが設定されていません。このプロジェクトで聞くのは今回だけです。",
  "依頼に取りかかる前に、次の順で進めてください。",
  "1. Skill ツールで ai-code-wisdom:init を呼び、その手順で主スタイル・副スタイル・段階を AskUserQuestion で聞く。最初の質問（主スタイル）の選択肢に「今は設定しない」を加える",
  "2. 「今は設定しない」が選ばれたら、何も設定しない。あとから設定するときは /ai-code-wisdom:init を使えることを一言伝える",
  "3. 設定が済んだら（または設定しなかったら）、元の依頼を進める。設定はあとから /ai-code-wisdom:style で変えられる",
].join("\n");

interface FirstRunState {
  /** プロジェクトの実パス → 初回設定を案内した時刻 */
  projects: Record<string, string>;
}

/** リポジトリを汚さないよう、記録はホームに置く */
function stateFile(home: string): string {
  return path.join(home, ".ai-code-wisdom", "first-run.json");
}

function isPlainObject(v: unknown): v is Record<string, string> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readState(home: string): FirstRunState {
  try {
    const projects = JSON.parse(fs.readFileSync(stateFile(home), "utf8"))?.projects;
    if (isPlainObject(projects)) return { projects };
  } catch {
    // ない・壊れている場合は、まだどこでも聞いていないものとして扱う
  }
  return { projects: {} };
}

function entriesOf(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function hasSource(entries: fs.Dirent[]): boolean {
  return entries.some((e) => e.isFile() && languageOf(e.name) !== null);
}

/** 直下か1つ下のディレクトリ（src/ など）に、検査できるソースがあるか */
function hasShallowSource(dir: string, entries: fs.Dirent[]): boolean {
  if (hasSource(entries)) return true;
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIPPED_DIRS.has(e.name))
    .some((e) => hasSource(entriesOf(path.join(dir, e.name))));
}

function realpathOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/** git リポジトリか、プロジェクトのファイルか、浅い場所に TS / Python があるフォルダ。ホームとルートは除く */
export function looksLikeCodeProject(dir: string, home: string): boolean {
  const real = realpathOrNull(dir);
  if (real === null || real === realpathOrNull(home) || real === path.parse(real).root) return false;
  if (git(real, ["rev-parse", "--is-inside-work-tree"]).status === 0) return true;
  const entries = entriesOf(real);
  return entries.some((e) => PROJECT_MARKERS.includes(e.name)) || hasShallowSource(real, entries);
}

/**
 * まだ聞いていないコードのフォルダなら、聞いたことを記録してから初回設定の案内を返す。聞かないなら null。
 * 断られても二度と聞かないよう、案内する前に記録する
 */
export function takeFirstRunOffer(dir: string, home: string): string | null {
  const key = realpathOrNull(dir);
  if (key === null) return null;
  const state = readState(home);
  if (state.projects[key] || !looksLikeCodeProject(key, home)) return null;
  state.projects[key] = new Date().toISOString();
  writeFileAtomic(stateFile(home), JSON.stringify(state, null, 2) + "\n");
  return FIRST_RUN_OFFER;
}
