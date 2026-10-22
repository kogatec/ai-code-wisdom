import fs from "node:fs";
import YAML from "yaml";
import { writeFileAtomic } from "./paths.ts";

export type Phase = "production" | "prototype";
export type ReviewMode = "auto" | "off" | "always";

export interface Profile {
  version: 1;
  primary: string;
  secondary: { pack: string; weight: number }[];
  phase: Phase;
  review: ReviewMode;
  overrides: {
    /** default / advisory の原則だけ無効にできる */
    disable: string[];
    /** パスごとに無効にする原則 */
    paths: Record<string, { disable: string[] }>;
  };
  /** すべての検査から外すパス */
  exclude_paths: string[];
}

export function defaultProfile(primary: string, secondary: { pack: string; weight: number }[] = []): Profile {
  return {
    version: 1,
    primary,
    secondary,
    phase: "production",
    review: "auto",
    overrides: { disable: [], paths: {} },
    exclude_paths: [],
  };
}

function fail(msg: string): never {
  throw new Error(`profile.yaml: ${msg}`);
}

export function parseProfile(text: string): Profile {
  const raw = (YAML.parse(text) ?? {}) as Record<string, any>;
  if (typeof raw.primary !== "string" || !raw.primary) fail("primary（主スタイル）がありません");
  const secondary = (Array.isArray(raw.secondary) ? raw.secondary : []).map((s: any) => {
    if (typeof s === "string") return { pack: s, weight: 0.5 };
    if (!s || typeof s.pack !== "string") fail("secondary の各項目には pack が必要です");
    const weight = s.weight === undefined ? 0.5 : Number(s.weight);
    if (!(weight > 0 && weight < 1)) fail(`secondary ${s.pack} の weight は 0 より大きく 1 より小さい値にしてください`);
    return { pack: s.pack, weight };
  });
  const phase = raw.phase ?? "production";
  if (phase !== "production" && phase !== "prototype") fail(`phase は production か prototype です（${phase}）`);
  const review = raw.review ?? "auto";
  if (!["auto", "off", "always"].includes(review)) fail(`review は auto / off / always のどれかです（${review}）`);
  const overrides = raw.overrides ?? {};
  const paths: Record<string, { disable: string[] }> = {};
  for (const [glob, v] of Object.entries((overrides.paths ?? {}) as Record<string, any>)) {
    paths[glob] = { disable: Array.isArray(v?.disable) ? v.disable.map(String) : [] };
  }
  return {
    version: 1,
    primary: raw.primary,
    secondary,
    phase,
    review,
    overrides: {
      disable: Array.isArray(overrides.disable) ? overrides.disable.map(String) : [],
      paths,
    },
    exclude_paths: Array.isArray(raw.exclude_paths) ? raw.exclude_paths.map(String) : [],
  };
}

export function readProfile(file: string): Profile {
  return parseProfile(fs.readFileSync(file, "utf8"));
}

const HEADER = `# AI Code Wisdom の設定（チームで共有するため、コミットしてください）
#   primary   : 主スタイル（最も優先する設計スタイル）
#   secondary : 副スタイルと重み（0〜1。大きいほど優先）
#   phase     : production（本番）/ prototype（試作。advisory の原則と info の検査を外す）
#   review    : auto（大きな変更の後だけレビュー役を呼ぶ）/ always / off
#   overrides.disable : 無効にする原則 ID（mandatory は無効にできません）
#   overrides.paths   : パスごとに無効にする原則 ID
#   exclude_paths     : 検査から外すパス（glob）
`;

export function writeProfile(file: string, profile: Profile): void {
  writeFileAtomic(file, HEADER + YAML.stringify(profile));
}
