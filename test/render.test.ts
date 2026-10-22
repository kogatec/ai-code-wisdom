import assert from "node:assert/strict";
import { test } from "node:test";
import { check, type Finding } from "../src/core/checker.ts";
import { listPacks } from "../src/core/packs.ts";
import { BUNDLED_PACKS_DIR } from "../src/core/paths.ts";
import {
  findPrincipleForExplain,
  guessLayers,
  levelLabel,
  renderCheckReport,
  renderExplain,
  renderFileContext,
  renderFindingsFeedback,
  renderSessionContext,
  renderStyles,
} from "../src/core/render.ts";
import { setupProject, SQL_VIOLATION, write } from "./helpers.ts";

test("levelLabel", () => {
  assert.deepEqual([levelLabel("mandatory"), levelLabel("default"), levelLabel("advisory")], ["必須", "既定", "推奨"]);
});

test("guessLayers：パスから層を推測する", () => {
  assert.deepEqual(guessLayers("src/routes/user.ts"), ["api_handler"]);
  assert.deepEqual(guessLayers("src/UserRepository.ts"), ["data_access"]);
  assert.ok(guessLayers("src/db/user_repo.py").includes("data_access"));
  assert.ok(guessLayers("src/clients/payment.ts").includes("external_call"));
  assert.deepEqual(guessLayers("src/services/billing.ts"), ["service"]);
  assert.ok(guessLayers("src/domain/order.ts").includes("domain"));
  assert.ok(guessLayers("test/a.test.ts").includes("test"));
  assert.ok(guessLayers("pkg/test_users.py").includes("test"));
  assert.ok(guessLayers("scripts/build.ts").includes("cli_entry"));
  assert.ok(guessLayers("src/main.py").includes("cli_entry"));
  assert.deepEqual(guessLayers("src/util.ts"), []);
});

test("renderSessionContext：L0 の構成と長さ", () => {
  const { compiled } = setupProject({ primary: "security-resilience", secondary: [{ pack: "simple-readable", weight: 0.7 }] });
  const text = renderSessionContext(compiled);
  assert.ok(text.startsWith("# AI Code Wisdom：このプロジェクトの設計方針\n"));
  assert.ok(text.includes("主スタイル：セキュリティ・障害耐性重視型 ／ 副スタイル：シンプル・可読性重視型（重み 0.7） ／ 段階：本番（production）"));
  assert.ok(text.includes("## 必須（どのスタイルでも外せない）\n- [SEC-IV-001]"));
  assert.ok(text.includes("依頼がこれらに反する場合は、実装せずに理由と安全な代替案を示し、ユーザーの判断を仰ぐ。"));
  assert.ok(text.includes("## 優先して守る原則（上ほど優先）"));
  assert.match(text, /- ほか \d+ 件（wisdom_principles ツールか `wisdom principles` で確認）/);
  assert.ok(text.includes("## 原則がぶつかったとき\n- 抽象化の量：「増やす」を優先（"));
  assert.ok(text.includes("## 進め方\n- ファイルを書くたびに自動で検査される。"));
  const listed = text.split("\n").filter((l) => l.startsWith("- [")).length;
  assert.equal(listed, compiled.principles.filter((p) => p.level === "mandatory").length + 12);
  assert.ok(text.length <= 2500, `長さ ${text.length}`);
});

test("renderSessionContext：必須がない・軸の衝突がない・試作", () => {
  const { compiled } = setupProject({ primary: "maintainable", secondary: [], phase: "prototype" });
  const text = renderSessionContext(compiled);
  assert.ok(text.includes("副スタイル：なし ／ 段階：試作（prototype）"));
  assert.ok(!text.includes("## 必須"));
  assert.ok(!text.includes("## 原則がぶつかったとき"));
});

test("renderFileContext：層に合う review のある原則を最大5件", () => {
  const { compiled } = setupProject();
  const db = renderFileContext(compiled, "src/db/users.ts")!;
  assert.ok(db.startsWith("[AI Code Wisdom] src/db/users.ts を書くときに確かめること（機械では検査できない部分）：\n"));
  assert.ok(db.includes("- [SEC-INJ-002] 動的に変わる部分"));
  assert.ok(db.split("\n").length - 1 <= 5);
  const plain = renderFileContext(compiled, "src/util.ts")!;
  assert.ok(!plain.includes("SEC-INJ-002"));
  assert.equal(renderFileContext(compiled, "README.md"), null);
});

function finding(over: Partial<Finding>): Finding {
  return {
    ruleId: "r",
    principle: "SEC-INJ-002",
    severity: "error",
    blocking: true,
    file: "src/a.ts",
    line: 3,
    endLine: 3,
    column: 1,
    message: "SQL を連結しています",
    note: "プレースホルダを使ってください",
    snippet: "db.query(`...${x}`)",
    fingerprint: "f",
    ...over,
  };
}

test("renderFindingsFeedback：blocking と advisory を分ける", () => {
  const fb = renderFindingsFeedback("src/a.ts", [
    finding({}),
    finding({ principle: "MNT-TYPE-006", severity: "warning", blocking: false, line: 1, message: "any です", note: "unknown を使う" }),
    ...Array.from({ length: 7 }, (_, i) =>
      finding({ principle: "MNT-DOC-014", severity: "info", blocking: false, line: 10 + i, message: "説明なし", note: "書く" }),
    ),
  ]);
  assert.equal(
    fb.blocking,
    [
      "[AI Code Wisdom] src/a.ts に必須原則の違反が入りました。直してから先に進んでください。",
      "- L3 [SEC-INJ-002] SQL を連結しています（db.query(`...${x}`)）",
      "  → プレースホルダを使ってください",
      "本当に例外が必要なら、その行に `wisdom-allow SEC-INJ-002: 理由` を書き、ユーザーに説明してください。",
    ].join("\n"),
  );
  const lines = fb.advisory!.split("\n");
  assert.equal(lines[0], "[AI Code Wisdom] src/a.ts の検査結果（止めはしませんが、直せるなら直してください）：");
  assert.equal(lines[1], "- L1 [MNT-TYPE-006] any です");
  assert.equal(lines[2], "  → unknown を使う");
  assert.equal(lines.filter((l) => l.includes("[MNT-DOC-014]")).length, 5);
  assert.ok(!lines.some((l) => l.includes("→ 書く")), "info には note を付けない");
  assert.equal(lines[lines.length - 1], "- ほか 2 件");
  assert.deepEqual(renderFindingsFeedback("a.ts", []), { blocking: null, advisory: null });
});

test("renderCheckReport：一覧と集計、指摘なし、注意", () => {
  const { root, paths, compiled } = setupProject();
  write(root, "src/a.ts", SQL_VIOLATION);
  const result = check(paths, compiled);
  const text = renderCheckReport(result);
  assert.match(text, /^src\/a\.ts:2:\d+ error 必須 \[SEC-INJ-002\] /m);
  assert.match(text, /^必須の違反 1 ／ error 1 ／ warning \d+ ／ info \d+ ／ 例外 0 ／ 理由のない例外 0$/m);
  assert.equal(
    renderCheckReport({ findings: [], waived: [], invalidAllows: [], filesScanned: 3, errors: ["問題があります"] }),
    "指摘はありません（3 ファイル）\n注意：問題があります",
  );
});

test("renderExplain：原則の説明を Markdown で返す", () => {
  const found = findPrincipleForExplain(null, null, "sec-inj-002")!;
  const text = renderExplain(found);
  assert.ok(text.startsWith("## [SEC-INJ-002] SQL は文字列で組み立てず"));
  assert.ok(text.includes("レベル：必須"));
  assert.ok(text.includes("セキュリティ・障害耐性重視型（security-resilience）"));
  for (const h of ["### 理由", "### 検査", "### 例"]) assert.ok(text.includes(h), h);
  assert.ok(text.includes("悪い例：") && text.includes("良い例："));
  const tension = renderExplain(findPrincipleForExplain(null, null, "SEC-IV-001")!);
  assert.ok(tension.includes("### 衝突しやすい軸\n- 抽象化の量：増やす"));
  assert.equal(findPrincipleForExplain(null, null, "NOPE-1"), null);
});

test("renderStyles：パックごとの案内", () => {
  const text = renderStyles(listPacks(BUNDLED_PACKS_DIR));
  assert.ok(text.includes("### セキュリティ・障害耐性重視型（security-resilience）"));
  assert.ok(text.includes("重視する価値：入力の検証、"));
  assert.match(text, /原則の数：15（うち必須 9）/);
  assert.ok(text.includes("向いているプロジェクト：") && text.includes("トレードオフ："));
  assert.ok(text.includes("- rule_tests："));
});
