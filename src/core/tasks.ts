import type { Compiled } from "./resolve.ts";

export type TaskType = "bugfix" | "refactor" | "new" | "feature" | "test";

/** 判定の優先順 */
const TASK_PATTERNS: [TaskType, RegExp][] = [
  ["bugfix", /バグ|不具合|直して|修正|エラー|落ちる|動かない|壊れ|\bfix|\bbug|\berror|crash|broken|regression/i],
  ["refactor", /リファクタ|整理|きれいに|綺麗に|読みやすく|分割|共通化|refactor|clean ?up|restructure|simplif/i],
  ["new", /新しく作|新規|ゼロから|一から|scaffold|from scratch|new (project|app|service)/i],
  ["feature", /追加|実装|作って|作成|対応して|機能|できるように|\badd\b|implement|feature|support|create|build/i],
  ["test", /テストを?(書|追加|作)|tests? for|write tests|add tests/i],
];

const TASK_NAMES: Record<TaskType, string> = {
  bugfix: "バグ修正",
  refactor: "リファクタリング",
  new: "新規開発",
  feature: "機能追加",
  test: "テスト",
};

const TASK_STEPS: Record<TaskType, string[]> = {
  bugfix: [
    "再現条件を特定する",
    "修正前に失敗する再現テストを書く",
    "根本原因を直す（症状だけを隠さない）",
    "同じ原因の箇所がほかにないか探す",
  ],
  refactor: [
    "先に今の動作をテストで固定する",
    "振る舞いを変えない",
    "依頼と関係のない変更を混ぜない",
    "変更を小さく分ける",
  ],
  new: [
    "先に構造と責務の分け方を決める",
    "選んだスタイルの原則に沿って実装する",
    "正常系と異常系のテストを書く",
    "設計判断を decisions.md に記録する",
  ],
  feature: [
    "既存の設計・命名・書き方を確認して合わせる",
    "変更の影響範囲を調べる",
    "新しい振る舞いのテストを書く",
    "既存のテストが通ることを確かめる",
  ],
  test: ["振る舞い（入力と結果）を確かめる", "境界値と異常系を含める", "時刻・乱数・通信に頼らない"],
};

/** 必須原則に触れうる依頼の言い回し */
const RISKY_PATTERNS: [string, RegExp][] = [
  [
    "SEC-IV-001",
    /(検証|バリデーション|チェック)(は)?(不要|いらない|なし|しない|省略|飛ばし)|skip (input )?validation|without validation|no validation/i,
  ],
  ["SEC-SECRET-005", /(キー|鍵|パスワード|トークン|token|api ?key|password|secret).{0,12}(直接|ハードコード|hard-?code|埋め込)/i],
  [
    "SEC-CRYPTO-008",
    /(証明書|certificate|ssl|tls).{0,12}(無視|無効|検証しない|skip|disable|ignore)|verify\s*=\s*false|rejectunauthorized/i,
  ],
  ["SEC-AUTHZ-007", /(権限|認可|認証|auth).{0,10}(チェック)?(不要|なし|外し|省略|skip|bypass|disable)/i],
  ["SEC-INJ-003", /eval\(|shell\s*=\s*true/i],
  ["SEC-LEAK-006", /(パスワード|トークン|token|password).{0,10}(ログ|log|出力|print)/i],
];

/** 依頼の種類を優先順に最大2件 */
export function classifyPrompt(prompt: string): TaskType[] {
  return TASK_PATTERNS.filter(([, re]) => re.test(prompt))
    .map(([type]) => type)
    .slice(0, 2);
}

export function riskyPrinciples(prompt: string): string[] {
  return RISKY_PATTERNS.filter(([, re]) => re.test(prompt)).map(([id]) => id);
}

export function renderTaskContext(types: TaskType[], risky: string[], compiled: Compiled): string | null {
  const lines: string[] = [];
  if (types.length === 1) {
    lines.push(...TASK_STEPS[types[0]].map((s) => `- ${s}`));
  } else {
    for (const t of types) lines.push(`${TASK_NAMES[t]}：`, ...TASK_STEPS[t].map((s) => `- ${s}`));
  }
  const activeMandatory = new Map(
    compiled.principles.filter((p) => p.level === "mandatory").map((p) => [p.id, p] as const),
  );
  const warnings = risky
    .filter((id) => activeMandatory.has(id))
    .map(
      (id) =>
        `- [${id}] ${activeMandatory.get(id)!.summary} — この依頼はこの原則に反する可能性があります。反するなら実装せず、理由と代替案を示してください`,
    );
  if (lines.length === 0 && warnings.length === 0) return null;
  const heading =
    types.length > 0
      ? `[Torus Code] この依頼の進め方（${types.map((t) => TASK_NAMES[t]).join("・")}）：`
      : "[Torus Code] この依頼についての注意：";
  const out = [heading, ...lines];
  if (warnings.length) out.push(...(lines.length ? [""] : []), ...warnings);
  return out.join("\n");
}
