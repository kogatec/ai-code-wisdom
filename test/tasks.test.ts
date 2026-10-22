import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyPrompt, renderTaskContext, riskyPrinciples } from "../src/core/tasks.ts";
import { setupProject } from "./helpers.ts";

test("依頼の種類を判定する", () => {
  assert.deepEqual(classifyPrompt("ログインでエラーになるバグを直して"), ["bugfix"]);
  assert.deepEqual(classifyPrompt("この関数をリファクタして読みやすくしたい"), ["refactor"]);
  assert.deepEqual(classifyPrompt("この管理画面をゼロから作ってください"), ["new", "feature"]);
  assert.deepEqual(classifyPrompt("ユーザー検索の機能を追加して"), ["feature"]);
  assert.deepEqual(classifyPrompt("検索のテストを書いてください"), ["test"]);
  assert.deepEqual(classifyPrompt("Please fix this crash"), ["bugfix"]);
  assert.deepEqual(classifyPrompt("Refactor and clean up the module"), ["refactor"]);
  assert.deepEqual(classifyPrompt("Add tests for the parser"), ["feature", "test"]);
  assert.deepEqual(classifyPrompt("こんにちは"), []);
});

test("判定は優先順で最大2件", () => {
  assert.deepEqual(classifyPrompt("バグを直して、リファクタして、機能も追加して"), ["bugfix", "refactor"]);
  assert.equal(classifyPrompt("FIX the BUG").length, 1);
});

test("必須原則に触れうる依頼を見つける", () => {
  assert.deepEqual(riskyPrinciples("入力の検証は不要なので省いて"), ["SEC-IV-001"]);
  assert.deepEqual(riskyPrinciples("skip validation for speed"), ["SEC-IV-001"]);
  assert.deepEqual(riskyPrinciples("APIキーはコードに直接書いて"), ["SEC-SECRET-005"]);
  assert.deepEqual(riskyPrinciples("SSL 証明書の検証を無効にして"), ["SEC-CRYPTO-008"]);
  assert.deepEqual(riskyPrinciples("requests.get(url, verify=False)"), ["SEC-CRYPTO-008"]);
  assert.deepEqual(riskyPrinciples("認証チェックを外して"), ["SEC-AUTHZ-007"]);
  assert.deepEqual(riskyPrinciples("eval( で動かして"), ["SEC-INJ-003"]);
  assert.deepEqual(riskyPrinciples("パスワードをログに出して"), ["SEC-LEAK-006"]);
  assert.deepEqual(riskyPrinciples("ユーザー一覧を作って"), []);
});

test("renderTaskContext：手順と、有効な必須原則に絞った注意", () => {
  const { compiled } = setupProject();
  const text = renderTaskContext(["bugfix"], ["SEC-IV-001", "SEC-SECRET-005"], compiled)!;
  assert.ok(text.startsWith("[AI Code Wisdom] この依頼の進め方（バグ修正）："));
  assert.ok(text.includes("修正前に失敗する再現テストを書く"));
  assert.ok(text.includes("- [SEC-IV-001] 外部入力は入口でスキーマ検証し"));
  assert.ok(text.includes("この依頼はこの原則に反する可能性があります。反するなら実装せず、理由と代替案を示してください"));

  const two = renderTaskContext(["refactor", "test"], [], compiled)!;
  assert.ok(two.includes("（リファクタリング・テスト）"));
  assert.ok(two.includes("先に今の動作をテストで固定する") && two.includes("境界値と異常系を含める"));
  assert.ok(!two.includes("反する可能性"));
});

test("renderTaskContext：必須でない（無効な）原則の注意は出さず、何もなければ null", () => {
  const { compiled } = setupProject({ primary: "simple-readable", secondary: [{ pack: "maintainable", weight: 0.5 }] });
  assert.equal(renderTaskContext([], ["SEC-IV-001"], compiled), null);
  assert.equal(renderTaskContext([], [], compiled), null);
  const withTask = renderTaskContext(["new"], ["SEC-IV-001"], compiled)!;
  assert.ok(withTask.includes("新規開発") && !withTask.includes("SEC-IV-001"));
});

test("renderTaskContext：種類がなくても必須原則の注意は出す", () => {
  const { compiled } = setupProject();
  const text = renderTaskContext([], ["SEC-INJ-003"], compiled)!;
  assert.ok(text.includes("- [SEC-INJ-003]"));
});
