---
description: 変更したファイルを検査して、原則の違反を直す
argument-hint: "[パス...]"
allowed-tools: Bash(wisdom:*), Read, Edit, MultiEdit
---

原則の違反を検査して、直します。

1. 検査する。引数があれば `wisdom check $ARGUMENTS`、なければ `wisdom check --changed`（git の基準 HEAD からの変更行だけ）を実行する。git でない場合は `wisdom check` でプロジェクト全体を検査する。
2. 指摘を、必須（blocking）→ error → warning → info の順に直す。直す前に、必要なら `wisdom explain <ID>` で原則の理由と良い例を確かめる。
3. 直したら、もう一度同じコマンドで確かめる。
4. 本当に直せない箇所だけ、その行か直前の行に `wisdom-allow <ID>: 理由` を書く。理由は必ず書き、書いた箇所と理由をユーザーに伝える。理由のない例外は無効として扱われる。
5. 最後に「適用した原則／検査の結果／未解決」を3行で報告する。
