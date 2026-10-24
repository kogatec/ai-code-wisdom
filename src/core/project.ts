import fs from "node:fs";
import path from "node:path";
import { BUNDLED_PACKS_DIR, writeFileAtomic, type ProjectPaths } from "./paths.ts";
import { copyPack, diffPacks, hashPackDir, listPacks, loadPack, type PackDiff } from "./packs.ts";
import { defaultProfile, readProfile, writeProfile, type Phase, type Profile, type ReviewMode } from "./profile.ts";
import { compile, type Compiled } from "./resolve.ts";

export const TOOL_VERSION = "0.3.0";

export interface StyleChoice {
  primary: string;
  secondary: { pack: string; weight: number }[];
  phase?: Phase;
  review?: ReviewMode;
}

function assertBundled(ids: string[]): void {
  const available = new Set(listPacks(BUNDLED_PACKS_DIR).map((p) => p.id));
  for (const id of ids) {
    if (!available.has(id)) {
      throw new Error(`パック ${id} はありません。選べるのは ${[...available].join(" / ")} です`);
    }
  }
}

/**
 * 主と同じ副スタイルは外す。副スタイルの重複は、何かを書く前にエラーにする
 * （設定を書いてから compile で失敗すると、壊れた設定が残ってフックが黙って止まるため）
 */
function normalizeSecondary(primary: string, secondary: Profile["secondary"]): Profile["secondary"] {
  const seen = new Set<string>();
  for (const s of secondary) {
    if (seen.has(s.pack)) {
      throw new Error(`副スタイル ${s.pack} が重複して選ばれています（--secondary の指定か、profile.yaml の secondary を直してください）`);
    }
    seen.add(s.pack);
  }
  return secondary.filter((s) => s.pack !== primary);
}

function selectedIds(profile: Pick<Profile, "primary" | "secondary">): string[] {
  return [profile.primary, ...profile.secondary.map((s) => s.pack)];
}

/** 選んだパックをプロジェクトに複製する。プラグインを更新しても、torus update するまで挙動が変わらない */
function vendorPacks(paths: ProjectPaths, ids: string[]): void {
  for (const id of ids) {
    const dest = path.join(paths.packsDir, id);
    if (!fs.existsSync(path.join(dest, "pack.yaml"))) copyPack(path.join(BUNDLED_PACKS_DIR, id), dest);
  }
  if (!fs.existsSync(paths.packsDir)) return;
  for (const e of fs.readdirSync(paths.packsDir)) {
    if (!ids.includes(e)) fs.rmSync(path.join(paths.packsDir, e), { recursive: true, force: true });
  }
}

export function writeLock(paths: ProjectPaths, compiled: Compiled): void {
  const lock = {
    generated_by: `torus-code ${TOOL_VERSION}`,
    packs: Object.fromEntries(compiled.packs.map((p) => [p.id, { version: p.version, hash: p.hash }])),
    principles: Object.fromEntries(compiled.principles.map((p) => [p.id, p.version])),
  };
  writeFileAtomic(paths.lock, JSON.stringify(lock, null, 2) + "\n");
}

/** .torus/ を作り、選んだパックの複製・設定・lock.json を書く。設定済みなら force のときだけ上書きする */
export function initProject(paths: ProjectPaths, choice: StyleChoice, opts: { force?: boolean } = {}): Compiled {
  if (fs.existsSync(paths.profile) && !opts.force) {
    throw new Error("既に設定されています。変更は torus style set で行ってください");
  }
  const secondary = normalizeSecondary(choice.primary, choice.secondary);
  const ids = selectedIds({ primary: choice.primary, secondary });
  assertBundled(ids);
  fs.mkdirSync(paths.torusDir, { recursive: true });
  vendorPacks(paths, ids);
  const profile = defaultProfile(choice.primary, secondary);
  if (choice.phase) profile.phase = choice.phase;
  if (choice.review) profile.review = choice.review;
  writeProfile(paths.profile, profile);
  writeFileAtomic(path.join(paths.torusDir, ".gitignore"), "cache/\nledger.jsonl\naudit-history.jsonl\n");
  if (!fs.existsSync(paths.decisions)) {
    writeFileAtomic(
      paths.decisions,
      "# 設計判断の記録\n\n原則どうしが衝突したときや、設計を変える判断をしたときに、1行ずつ追記します。\n\n",
    );
  }
  const compiled = compile(paths);
  writeLock(paths, compiled);
  return compiled;
}

/** 指定した項目だけ設定を変え、パックの複製と lock.json を合わせ直す */
export function setStyle(paths: ProjectPaths, change: Partial<StyleChoice>): Compiled {
  const profile = readProfile(paths.profile);
  if (change.primary) profile.primary = change.primary;
  if (change.secondary) profile.secondary = change.secondary;
  if (change.phase) profile.phase = change.phase;
  if (change.review) profile.review = change.review;
  profile.secondary = normalizeSecondary(profile.primary, profile.secondary);
  const ids = selectedIds(profile);
  assertBundled(ids.filter((id) => !fs.existsSync(path.join(paths.packsDir, id, "pack.yaml"))));
  vendorPacks(paths, ids);
  writeProfile(paths.profile, profile);
  const compiled = compile(paths);
  writeLock(paths, compiled);
  return compiled;
}

export interface LockStatus {
  ok: boolean;
  problems: string[];
}

/** lock.json と、プロジェクト内のパックが食い違っていないか */
export function checkLock(paths: ProjectPaths): LockStatus {
  const problems: string[] = [];
  if (!fs.existsSync(paths.lock)) return { ok: false, problems: ["lock.json がありません（torus init をやり直してください）"] };
  let lock: { packs: Record<string, { version: string; hash: string }> };
  try {
    lock = JSON.parse(fs.readFileSync(paths.lock, "utf8"));
    if (typeof lock?.packs !== "object" || lock.packs === null) throw new Error("packs がありません");
  } catch (err) {
    // 壊れていても、ほかの表示（session-start の L0 や status）は止めない
    return { ok: false, problems: [`lock.json を読めません（${(err as Error).message}）。torus lock で記録し直してください`] };
  }
  for (const [id, info] of Object.entries(lock.packs)) {
    const dir = path.join(paths.packsDir, id);
    if (!fs.existsSync(dir)) problems.push(`${id}: パックがありません`);
    else if (hashPackDir(dir) !== info.hash) problems.push(`${id}: lock.json の記録から中身が変わっています（手で編集した場合は torus lock で記録し直してください）`);
  }
  return { ok: problems.length === 0, problems };
}

export interface UpdatePlan {
  pack: string;
  from: string;
  to: string;
  diff: PackDiff;
}

/** プラグイン同梱の新しい版と、プロジェクトのパックを比べる */
export function planUpdate(paths: ProjectPaths): UpdatePlan[] {
  const profile = readProfile(paths.profile);
  const plans: UpdatePlan[] = [];
  for (const id of selectedIds(profile)) {
    const bundledDir = path.join(BUNDLED_PACKS_DIR, id);
    const localDir = path.join(paths.packsDir, id);
    if (!fs.existsSync(bundledDir) || !fs.existsSync(localDir)) continue;
    if (hashPackDir(bundledDir) === hashPackDir(localDir)) continue;
    const bundled = loadPack(bundledDir);
    const local = loadPack(localDir);
    plans.push({ pack: id, from: local.version, to: bundled.version, diff: diffPacks(local, bundled) });
  }
  return plans;
}

export function applyUpdate(paths: ProjectPaths, ids: string[]): Compiled {
  for (const id of ids) copyPack(path.join(BUNDLED_PACKS_DIR, id), path.join(paths.packsDir, id));
  const compiled = compile(paths);
  writeLock(paths, compiled);
  return compiled;
}

/** 手で編集したパックを、今の中身で lock.json に記録し直す */
export function relock(paths: ProjectPaths): Compiled {
  const compiled = compile(paths);
  writeLock(paths, compiled);
  return compiled;
}
