import fs from "node:fs";
import path from "node:path";
import { git } from "./git.ts";
import { PLUGIN_ROOT, relativeToRoot, writeFileAtomic, type ProjectPaths } from "./paths.ts";
import { renderSessionContext } from "./render.ts";
import type { Compiled } from "./resolve.ts";

const BEGIN = "<!-- torus-code:begin -->";
const END = "<!-- torus-code:end -->";
const AUTO_CHECK_LINE = "- ファイルを書くたびに自動で検査される。[必須] の違反は直すまで先に進めない";
const MANUAL_CHECK_LINE = "- ファイルを書いたら `torus check --changed` を実行し、[必須] の違反を直す";

/** フックのない環境向けの文章（自動検査の代わりに、自分で検査コマンドを実行させる） */
function renderPortableContext(compiled: Compiled): string {
  return renderSessionContext(compiled).replace(AUTO_CHECK_LINE, MANUAL_CHECK_LINE);
}

export function exportAgentsMd(paths: ProjectPaths, compiled: Compiled): string {
  const file = path.join(paths.root, "AGENTS.md");
  const block = `${BEGIN}\n${renderPortableContext(compiled)}\n${END}`;
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const begin = current.indexOf(BEGIN);
  const end = begin >= 0 ? current.indexOf(END, begin) : -1;
  let next: string;
  if (begin >= 0 && end >= 0) {
    next = current.slice(0, begin) + block + current.slice(end + END.length);
  } else if (current.trim() === "") {
    next = block + "\n";
  } else {
    next = current.replace(/\s*$/, "") + "\n\n" + block + "\n";
  }
  writeFileAtomic(file, next);
  return file;
}

export function exportCursorRules(paths: ProjectPaths, compiled: Compiled): string {
  const file = path.join(paths.root, ".cursor", "rules", "torus-code.mdc");
  const header = "---\ndescription: Torus Code の設計方針\nalwaysApply: true\n---\n";
  writeFileAtomic(file, header + renderPortableContext(compiled) + "\n");
  return file;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * pre-commit の中で使うパス。リポジトリの中なら最上位からの相対で書き、リポジトリを別の場所に移しても動くようにする。
 * 外なら絶対パスのまま書く
 */
function hookPathArg(topLevel: string, target: string): string {
  const real = fs.realpathSync(target);
  const rel = relativeToRoot(topLevel, real);
  if (rel === null) return shellQuote(real);
  return `"$(git rev-parse --show-toplevel)"${rel ? `/${shellQuote(rel)}` : ""}`;
}

/** 設定がリポジトリのサブディレクトリや既定以外の場所（--torus-dir）にあっても、そこを検査する引数 */
function hookCheckArgs(paths: ProjectPaths, topLevel: string): string {
  const args = [`--project ${hookPathArg(topLevel, paths.root)}`];
  if (paths.torusDir !== path.join(paths.root, ".torus")) args.push(`--torus-dir ${hookPathArg(topLevel, paths.torusDir)}`);
  return args.join(" ");
}

/** 必須原則の違反があるコミットを止める pre-commit フックを書く。Torus Code が作ったものでなければ上書きしない */
export function exportGitHook(paths: ProjectPaths): string {
  const gitPath = git(paths.root, ["rev-parse", "--git-path", "hooks/pre-commit"]);
  const topLevel = git(paths.root, ["rev-parse", "--show-toplevel"]);
  if (gitPath.status !== 0 || topLevel.status !== 0) {
    throw new Error("git リポジトリではないため、pre-commit フックを作れません");
  }
  const file = path.resolve(paths.root, gitPath.stdout.trim());
  if (fs.existsSync(file) && !fs.readFileSync(file, "utf8").includes("torus-code")) {
    throw new Error(`${file} が既にあります（Torus Code が作ったものではないため、上書きしません）`);
  }
  const script = [
    "#!/bin/sh",
    "# torus-code: コミット前に必須原則の違反を検査する",
    `${shellQuote(path.join(PLUGIN_ROOT, "bin", "torus"))} check ${hookCheckArgs(paths, topLevel.stdout.trim())} --diff HEAD --fail-on blocking`,
    "status=$?",
    "# 2 は検査そのものを実行できなかったとき（設定のあるディレクトリを移した・消したなど）",
    'if [ "$status" -eq 2 ]; then',
    '  echo "torus-code: 検査を実行できませんでした。設定の場所を変えた場合は torus export git-hook をやり直してください" >&2',
    "fi",
    'exit "$status"',
    "",
  ].join("\n");
  writeFileAtomic(file, script);
  fs.chmodSync(file, 0o755);
  return file;
}
