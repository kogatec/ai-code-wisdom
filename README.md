# AI Code Wisdom

ユーザーが選んだ設計スタイル（セキュリティ重視・読みやすさ重視・長期保守重視など）を、AI が**開発から保守まで守り続ける**ための原則パック・自動検査・Claude Code プラグイン。

- 方針はプロンプトではなく、**毎回動く仕組み**で守らせる（セッション開始・依頼・ファイル編集・作業終了のたびにフックが動く）
- 原則は「検査方法を持つデータ」。検査できない標語は採用しない
- 設定はリポジトリ内の `.wisdom/` に置き、パックはプロジェクトに複製して版を固定する（プラグインを更新しても勝手に挙動が変わらない）

設計の考え方は [AI-Code-Wisdom-設計書.md](AI-Code-Wisdom-設計書.md)、実装の契約は [docs/実装仕様.md](docs/実装仕様.md) を参照。

## 必要なもの

- Node.js 23.6 以上（`.ts` をビルドせずに直接実行する。Node 26 で確認）
- Claude Code（プラグインとして使う場合）

```bash
npm install
```

## Claude Code で使う

このディレクトリがそのままプラグインです。

```bash
claude --plugin-dir /path/to/ai-code-wisdom
```

まだ設定していないコードのフォルダ（git リポジトリか、TypeScript / Python のプロジェクト）で最初にメッセージを送ると、依頼に取りかかる前に一度だけ、設計スタイル（主・副・段階）を聞かれます。「今は設定しない」を選んでも、そのプロジェクトでは二度と聞きません。聞いた記録はリポジトリではなく `~/.ai-code-wisdom/first-run.json` に残ります。ホームディレクトリそのものや、コードのないフォルダでは聞きません。

あとから設定・変更するときは、次のコマンドを使います。

| コマンド | 内容 |
|---|---|
| `/ai-code-wisdom:init` | 主スタイル・副スタイル・段階（本番／試作）を選んで設定する |
| `/ai-code-wisdom:style` | 設定を確認・変更する |
| `/ai-code-wisdom:check` | 変更した部分を検査して直す |
| `/ai-code-wisdom:audit` | プロジェクト全体を監査する |
| `/ai-code-wisdom:explain <ID>` | 原則の理由・検査方法・例を見る |

設定したあとは、次のことが自動で起きます。

| 層 | いつ | 何をするか |
|---|---|---|
| L0 | セッション開始時（会話の圧縮後も） | 必須の原則・優先して守る原則・衝突時の優先・進め方を渡す |
| L1 | 依頼を送ったとき／ファイルを初めて書くとき | 依頼の種類（バグ修正・リファクタ・新規・機能追加・テスト）ごとの手順と、そのファイルで機械では検査できない確認事項を渡す。必須原則に反しそうな依頼には注意を出す |
| L2 | ファイルを書いた直後 | 静的検査。**この編集で新しく入った**違反だけを返す。必須原則の違反は直すまで先へ進ませない（同じ違反は3回まで） |
| L3 | 作業を終えるとき | この作業で入った必須違反が残っていれば止める。変更が 120 行以上なら、レビュー役（`wisdom-reviewer`）に1回レビューさせる |
| L4 | いつでも | `wisdom audit`、`wisdom check --changed`、git の pre-commit |

ほかに、MCP ツール（`wisdom_principles`・`wisdom_check`・`wisdom_explain`・`wisdom_record_decision`・`wisdom_styles`）と、作業手順のスキル（`wisdom-apply`）が入っています。

## コマンドラインで使う

```bash
bin/wisdom init --primary security-resilience --secondary maintainable
bin/wisdom check --changed
bin/wisdom audit
bin/wisdom explain SEC-INJ-002
```

`bin/wisdom help` で全コマンドを確認できます。Claude Code の中では、プラグインの `bin/` が PATH に入るので `wisdom` だけで動きます。

| 区分 | コマンド |
|---|---|
| 設定 | `init`・`styles`・`style`／`style set`・`status`・`principles`・`explain`・`update`・`lock` |
| 検査 | `check`（既定は必須の違反があれば終了コード 1）・`audit`・`review-context` |
| 連携 | `export agents-md`（AGENTS.md）・`export cursor`（.cursor/rules）・`export git-hook`（pre-commit） |

## 設計スタイル（原則パック）

| パック | 原則 | 静的ルール | 必須 |
|---|---|---|---|
| `security-resilience`（セキュリティ・障害耐性重視型） | 15 | 42 | 9 |
| `simple-readable`（シンプル・可読性重視型） | 15 | 30 | 0 |
| `maintainable`（保守性・長期運用重視型） | 15 | 32 | 0 |

- 必須（mandatory）の原則は、どのスタイルを選んでも外せません。ほかのパックを主スタイルにしても、`security-resilience` を副スタイルに入れれば適用されます。
- 検査は ast-grep で行い、TypeScript（`.ts`・`.tsx`）と Python に対応しています。JavaScript には未対応です。
- 各ルールには「検出すべき例・検出してはいけない例」のテストがあります（`npm run test:rules`）。

## 設定ファイル（`.wisdom/`）

| ファイル | 内容 | コミット |
|---|---|---|
| `profile.yaml` | 主・副スタイル、段階、レビュー、無効にする原則、除外パス | する |
| `lock.json` | 使っているパックの版とハッシュ | する |
| `packs/` | プロジェクトに複製したパック（必要なら編集して `wisdom lock`） | する |
| `decisions.md` | 原則の衝突や設計判断の記録 | する |
| `cache/`・`ledger.jsonl`・`audit-history.jsonl` | キャッシュ・作業の記録・監査の履歴 | しない（自動で除外） |

本当に例外が必要な箇所だけ、その行か直前の行に理由付きで書きます。理由がない例外は無効です。

```ts
// wisdom-allow SEC-INJ-003: 固定の文字列だけを渡しており、外部入力は入らない
execSync(`git rev-parse ${FIXED_REF}`);
```

## 評価

同じ依頼を、プラグインなし（baseline）とあり（wisdom）の Claude Code に実行させて比べます。課題は6つ（TypeScript 3・Python 3）で、それぞれ2段階の依頼、依頼どおりに動くかの隠しテスト、原則が守られていれば通る堅牢さの隠しテスト、模範解答があります。

```bash
node eval/run.ts --dry-run                      # claude を呼ばずに、模範解答で隠しテストが正しいかを確かめる
node eval/run.ts --tasks ts-user-search --reps 1 # 実際に claude を動かす（ログイン済みの端末で）
```

結果は `eval/results/<日時>/summary.md` に出ます。完了条件は「違反点が半分以下・機能テストの通過率が下がらない・費用の増加 20% 以内」です。最新の結果は [docs/評価結果.md](docs/評価結果.md) を参照。

## 開発

```bash
npm run typecheck   # 型チェック
npm test            # 単体・結合テスト（約3分）
npm run test:rules  # パックのルールテスト
sh scripts/smoke-plugin.sh  # 実際の Claude Code でフックが動くかの確認（ログイン済みの端末で）
```

## 制約

- 静的検査は、問題が1つの式に直接書かれている場合しか見つけられません（変数を経由すると見逃すことがある）。その分はレビュー役と L1 の確認事項で補います。
- しきい値（関数 60 行など）はルールに直接書かれています。変えるときは `.wisdom/packs/` のルールを編集して `wisdom lock` を実行します。
- 原則の根拠は、今は CWE や既存ツールのルールへの参照だけです。公開リポジトリからの抽出（設計書の Phase 3）は未実装です。
