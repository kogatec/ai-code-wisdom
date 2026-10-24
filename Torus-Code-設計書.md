# Torus Code 設計書 v0.1

---

## 0. 結論（要点7つ）

1. **製品を2つに分ける。** 「原則をつくる側」（抽出・検証。オフライン）と「原則を守らせる側」（ユーザーの手元で動く）。MVPは**守らせる側＋手作りの原則**で作り、抽出エンジンは後にする。
2. **中心の単位は「原則」。** 原則は文章ではなく、適用条件・検査方法・根拠を持つデータとして扱う。**検査方法を持たない原則は採用しない。**
3. **方針はプロンプトではなく、毎回動く仕組みで守らせる。** hooks・静的検査・レビュー役のサブエージェント・CI の5層で守らせる。
4. **設定はリポジトリ内のファイル（`.torus/`）に置く。** 原則のバージョンは lock で固定し、パックが更新されても勝手に挙動が変わらないようにする。
5. **評価の仕組みを最初に作る。** 効果を測れないと、どの原則が効いているかを判断できない。
6. **最初の対応環境は Claude Code。** hooks・サブエージェント・MCP・スキルがそろっているため。他の環境には機能を減らして対応する。CI での検査は、どの環境を使っていても効く。
7. **抽出の材料は「コードの見た目」より「変更履歴とレビュー」。** コードから分かるのは「何を書いたか」まで。「なぜそう書くか」はレビューコメントやバグ修正に残っている。

---

## 1. 全体像

```
┌───────────── 原則をつくる側（オフライン・自分たちの環境） ─────────────┐
│ 対象選定 → 履歴・レビュー収集 → 原則候補の生成 → 統合 → 根拠の数え上げ │
│ → 検査ルール化 → 評価で検証 → 人が承認                                 │
│                              ↓ 出力                                    │
│                    原則パック（バージョン付き）                        │
└────────────────────────────────────────────────────────────────────────┘
                               ↓ 配布（npm / git タグ、ハッシュ付き）
┌───────────── 原則を守らせる側（ユーザーの手元・ローカル完結） ─────────┐
│ torus core : プロファイル解決 / 衝突解決 / ルール生成 / 検査実行       │
│   ├ CLI        : init / style / check / audit / explain / update        │
│   ├ MCP server : 原則の取得・差分の検査・判断の記録                     │
│   └ adapters   : Claude Code plugin / Cursor / AGENTS.md / CI           │
└────────────────────────────────────────────────────────────────────────┘
```

守らせる側は LLM を呼ばない。原則に従って考えるのはユーザーの AI 自身なので、追加の API 料金も鍵も要らない。

---

## 2. 中心データ：原則（Principle）

```yaml
id: SEC-IV-001
version: 1.2.0
title: 外部入力は境界で一度だけ検証し、内側では検証済みの型だけを扱う
level: mandatory          # mandatory（外せない） | default | advisory
styles:                   # どのスタイルにどれだけ効くか
  security_resilience: 1.0
  type_safety: 0.6
applies_when:
  languages: [typescript, python]
  layers: [api_handler, cli_entry, file_loader]
  paths: ["src/**/routes/**", "src/**/handlers/**"]
not_when:
  - 外部入力を受けない内部スクリプト
rationale: >
  検証が内側に散らばると、漏れと二重検証が同時に起きる。
  境界で型に変換すれば、内側のコードは不正な状態を考えなくてよい。
checks:                   # 1つ以上必須
  static:                 # 機械で検出できるもの
    - engine: ast-grep
      rule: rules/sec-iv-001-raw-request-body.yml
  review:                 # 機械では判定できないもの
    rubric: 新しい外部入力の入口に、スキーマ検証（Zod / Pydantic 等）があるか
  tests:
    require: 不正な入力で明確なエラーになることを確かめるテスト
examples:                 # 自作の例だけを置く
  bad: examples/sec-iv-001.bad.ts
  good: examples/sec-iv-001.good.ts
tensions:                 # 他の原則とぶつかりやすい方向
  - axis: abstraction
    direction: more
evidence:
  - repo: <org/repo>
    commit: <sha>
    kind: review_comment  # review_comment | bugfix_diff | design_doc | code_pattern
    url: <permalink>
  independent_sources: 7  # 別々の組織・プロジェクトの数
confidence: 0.82
validation:
  eval_suite: v3
  effect: { violations: -63%, regressions: -18% }
```

原則のルール：

- `checks` を1つも持たない原則は採用しない。「読みやすく書く」のような、検査できない標語は原則にしない。
- 他人のコードは複製しない。根拠は URL・コミット・行範囲への参照だけを持ち、例は自作する。
- スタイル名に個人名を使わない（「〇〇流」）。根拠のリポジトリは示すが、それを本人の思想とは言わない。

---

## 3. スタイル・プロファイル・衝突の解決

### 原則パック（＝スタイル）

```
packs/security-resilience/
  pack.yaml        # 名前・重視する価値・向くプロジェクト・トレードオフ・検証状況
  principles/*.yaml
  rules/*.yml      # ast-grep / Semgrep ルール
  examples/
  eval/            # このパック専用の評価課題
```

### ユーザーのプロジェクト側

```
.torus/
  profile.yaml     # 選んだスタイルと優先度
  lock.json        # 使う原則のID・バージョン・ハッシュを固定
  decisions.md     # トレードオフの判断記録（1行ずつ）
  ledger.jsonl     # 作業ごとに適用した原則と検査結果（ローカルのみ）
CLAUDE.md / AGENTS.md   # torus が管理する区画をマーカーで囲んで書き込む
```

```yaml
# .torus/profile.yaml
packs:
  security-resilience: ^1.0
  maintainable: ^1.0
  simple-readable: ^1.0
primary: security-resilience
secondary:
  - { pack: maintainable, weight: 0.5 }
phase: production          # prototype | production：mandatory 以外の厳しさを変える
overrides:
  disable: [MNT-DOC-004]   # default / advisory だけ無効にできる
  scope:
    "scripts/**": { primary: simple-readable }   # ディレクトリごとに切り替え
```

パックの更新は `torus update` で行う。原則の差分を見せてから lock を更新し、勝手には上がらない。

### 衝突の解決順

1. **mandatory**（どのスタイルを選んでも外せない）
2. プロジェクトの明示設定（overrides）
3. 主スタイル
4. 副スタイル（weight の大きい順）
5. 共通の既定

同じ `tensions` 軸で逆向きの原則が両方有効なときは、上の順で決めて `decisions.md` に記録する。mandatory が絡むものや設計の変更が大きいものは、ユーザーに説明する。

### mandatory とぶつかる依頼への対応

例：開発速度重視のユーザーが「入力チェックは要らない」と言った場合

1. AI は止まり、該当する原則の ID と理由を示す
2. 最小限の安全な代替案を出す（例：スキーマ1行で済む書き方）
3. それでも必要な場合は、**その箇所だけ**に、理由付きの例外コメントを書く（`// torus-allow SEC-IV-001: 理由`）。`torus audit` は例外を一覧に出す

→ 元の指示書からの変更提案：mandatory は設定ファイルでは外せないが、理由を書いた箇所単位の例外は認める（リンターの disable コメントと同じ考え方）。完全に禁止すると、ユーザーがプラグインごと外してしまうため。

---

## 4. 守らせる仕組み（5層）

| 層 | いつ動くか | 何をするか | コスト | 防ぐ問題 |
|---|---|---|---|---|
| **L0 常駐ルール** | セッション開始時と、会話の圧縮（compact）後 | 主要原則10〜15個を1行ずつ CLAUDE.md / AGENTS.md の管理区画に書き、開始時にも渡す | 1k トークン以下 | 方針を最初から知らない／圧縮で忘れる |
| **L1 その時に必要な原則** | 依頼を受けた時・ファイルを書く直前 | 作業の種類（新規・機能追加・バグ修正・リファクタ）とファイルパスから、該当する原則だけを渡す | 小 | 全部入れるとコンテキストがあふれる |
| **L2 機械的な検査** | ファイルを書いた直後 | 変更ファイルに静的ルールをかけ、違反を原則 ID 付きで AI に返す。mandatory 違反は直るまで先へ進ませない | 速い（数百ms以内が目標） | 書いた直後の崩れ |
| **L3 意味のレビュー** | 作業を終える時 | レビュー役のサブエージェントが差分を、機械では判定できない原則の rubric で確認する。差分が大きい時や mandatory が関わる時だけ動かす | 大きい → 条件付きで動かす | 機械では見えない設計の崩れ |
| **L4 監査・CI** | `torus audit`・pre-commit・CI | リポジトリ全体の違反数と複雑度の推移を見る | AI 環境に依存しない | 長期間でのずれ |

L2 と L4 は決まった手順で動き、AI の記憶に頼らない。「開発が進むと方針が崩れる」問題に対する本命はこの2層。

各作業の終わりに「適用した原則／検査結果／未解決の問題」を報告し、`ledger.jsonl` に残す。どの原則が実際に効いたかを後で分析するのに使う。

---

## 5. Claude Code プラグインの構成

```
torus-plugin/
  .claude-plugin/plugin.json    # mcpServers に torus MCP サーバーを書く
  skills/
    torus-apply/SKILL.md       # 作業の種類ごとに原則を引いて従う手順
    torus-select/SKILL.md      # スタイル選択の対話
  commands/
    torus-init.md              # 初期設定とスタイル選択
    torus-style.md             # スタイルの確認・変更
    torus-audit.md             # 全体の監査
    torus-explain.md           # 原則の説明と根拠
  agents/
    torus-reviewer.md          # L3 のレビュー役
  hooks/hooks.json              # SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / Stop
```

| hook | 層 | 動作 |
|---|---|---|
| SessionStart（開始時・compact 後） | L0 | プロファイルと主要原則を渡す |
| UserPromptSubmit | L1 | 依頼を作業の種類に分類し、該当原則を渡す |
| PreToolUse（Edit / Write） | L1 | 書き込むパスに該当する原則を渡す |
| PostToolUse（Edit / Write） | L2 | 静的検査。違反があれば AI に返す |
| Stop | L3 | 条件を満たす時だけレビュー役を呼ぶ |

MCP ツール：`get_principles(task, paths)`、`check(paths | diff)`、`explain(id)`、`record_decision(text, principle_ids)`、`profile()`

スタイル選択の画面：MVP では `/torus-init` の対話と、`torus init` のターミナル選択で作る。各スタイルには、重視する価値・主な原則・向くプロジェクト・トレードオフ・根拠の数・検証状況を表示する。Web 画面は後で作る。

※ hooks の発火タイミングや、AI への返し方（終了コードなど）の細かい仕様は実装時に公式ドキュメントで確認する。

---

## 6. 他の環境への対応（機能を減らして対応）

| 環境 | L0 | L1 | L2 | L3 | L4 |
|---|---|---|---|---|---|
| Claude Code | CLAUDE.md＋開始時 hook | hooks＋MCP | 書き込み後 hook | サブエージェント | ○ |
| Cursor | `.cursor/rules/*.mdc`（globs 指定） | MCP | hooks（対応状況を実装時に確認） | △ | ○ |
| Codex ほか | AGENTS.md | MCP | ✕ | ✕ | ○ |

pre-commit と CI はどの環境でも同じように効く最後の砦。アダプターは薄く作り、処理は core に寄せる（各環境の仕様変更に強くするため）。

---

## 7. 技術構成（元の案からの変更点）

| 部分 | 元の案 | 推奨 | 理由 |
|---|---|---|---|
| 手元で動く部分 | Python＋PostgreSQL | **TypeScript（Node）単体。DB なし、原則はファイル** | hooks は毎回起動するので軽い必要がある。ユーザーに DB を入れさせない。MCP SDK と ast-grep（napi）がそろっていて、npx で配れる |
| 静的検査 | Tree-sitter を直接使う | **ast-grep**（中身は Tree-sitter）、必要なら Semgrep | ルールを YAML で書けるので、原則と1対1で結び付けやすい |
| 抽出側 | Python＋PostgreSQL | Python＋まず SQLite / DuckDB。規模が大きくなったら PostgreSQL | 最初は数十リポジトリで足りる |
| LLM | 全体で使う | **抽出側だけで使う**（候補生成・分類・要約） | 手元側にコストと鍵を持たせない |
| 配布 | — | 原則パックを npm パッケージまたは git タグで、ハッシュ付きで配る | lock で固定できるようにする |

### リポジトリ構成（モノレポ）

```
torus-code/
  packages/
    core/          # スキーマ・プロファイル解決・衝突解決・ルール生成
    checks/        # ast-grep / Semgrep の実行と違反→原則IDの対応付け
    mcp-server/
    cli/
  adapters/
    claude-code-plugin/
    cursor/
    agents-md/
    ci/            # GitHub Actions・pre-commit
  packs/
    security-resilience/
    simple-readable/
    maintainable/
  eval/            # 評価課題と評価の仕組み
  miner/           # 抽出側（Python、Phase 3）
```

---

## 8. 原則をつくる側（Phase 3 以降）

1. **対象選定**：長く保守されている、レビューが必須、テストがある、ライセンスを確認済み。指標は保守期間・レビュー必須率・テスト比率・リリースが続いているか。知名度や役職は使わない。
2. **収集**：コードのスナップショットよりも、**PR のレビューコメント、バグ修正の前後の差分、リバート、設計文書（CONTRIBUTING・ADR・RFC）** を集める。「これはやめよう、なぜなら〜」というレビューが原則のもとになる。
3. **候補生成**：LLM で「主張・理由・適用条件」を出典付きで構造化する。
4. **統合**：意味の近い候補をまとめる。
5. **根拠の数え上げ**：別々の組織・プロジェクトからの独立した根拠を数える。1プロジェクトだけの癖は落とす。
6. **検査化**：ast-grep ルールか rubric を作る。作れない候補は保留にする。
7. **検証**：評価の仕組み（9章）で効果を測る。
8. **人の承認**：配布の前に人が確認する。

始め方：新しい原則を見つけるより、**手作りの原則に根拠を後から付ける**ほうが易しい。こちらから始める。

---

## 9. 評価の仕組み（最初に作る）

- **課題は「連続した作業」にする。** 新規作成 → 機能追加 → 仕様変更 → バグ修正 → リファクタ を、同じリポジトリで続けて行わせる。このプラグインの売りは「長く続けても崩れない」ことなので、それを測れる課題にする。
- **比較する組み合わせ**：プラグインなし／L0 だけ／L0〜L2／全層。どの層がどれだけ効き、どれだけコストがかかるかを分ける。
- **指標**：テスト成功率、回帰の数、有効な原則の違反数、静的解析の警告、複雑度、変更範囲、トークン消費、所要時間。
- **原則ごとの効果**：その原則だけを外した版と比べる。効かない原則は advisory に下げるか外す。
- **規模**：最初は課題10〜20個、TypeScript と Python の2言語。

---

## 10. ロードマップと完了条件

| フェーズ | 内容 | 完了条件 |
|---|---|---|
| **Phase 1（MVP）** | 3パック×15〜25原則（手作り、すべて検査付き）、core＋CLI、Claude Code プラグイン L0〜L2、評価の仕組み v1 | 評価課題で、有効な原則の違反がプラグインなしの半分以下。テスト成功率は下がらない。トークン増加は 20% 以内 |
| Phase 2 | L3 レビュー役、ledger、explain、Cursor / AGENTS.md / CI 対応 | 3つの環境で同じプロファイルが動く |
| Phase 3 | 抽出側。まず既存の原則に根拠を付け、次に新しい原則の候補を出す | 承認した新原則が評価で効果を示す |
| Phase 4 | 残り5スタイル、チームでの共有、パックの登録所 | — |

※ 数値の目標は仮置き。Phase 1 で基準値を取ってから見直す。

---

## 11. 主なリスクと対策

| リスク | 対策 |
|---|---|
| 縛りすぎて質が落ちる・遅くなる | 層ごとの効果とコストを評価で測る。advisory では止めない |
| 静的検査の誤検出で、AI が無駄な修正を繰り返す | mandatory 以外は警告だけにする。同じ違反は繰り返し通知しない。誤検出を ledger に記録してルールを直す |
| 原則がただの標語になる | 検査方法のない原則は採用しない |
| 実在の人物の名前・評判に関わる | スタイル名に個人名を使わない |
| ライセンス | コードは複製せず参照だけ持つ。例は自作する |
| 各環境の仕様変更（hooks など） | アダプターを薄くし、処理を core に寄せる |
| コンテキストの圧迫 | L0 は 1k トークン以下。残りは L1 で必要な時だけ渡す |

---

## 12. 最初にやること（順番）

1. 評価課題を5つ作り、プラグインなしの基準値を取る
2. 原則のスキーマを確定する（2章）
3. 「セキュリティ・障害耐性」パックの原則を15個、検査付きで書く
4. core と CLI の `check` を作る
5. Claude Code プラグインの L0〜L2 を作る
6. 評価して効果を確かめてから、残り2パックに進む
