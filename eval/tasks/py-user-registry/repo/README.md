# user-registry

メールアドレスとパスワードでユーザーを管理する小さなモジュールです。

## 動かし方

- Python 3 の**標準ライブラリだけ**を使います。外部パッケージ（bcrypt など）は入れません。
- DB は標準の `sqlite3` です。`db.py` の `connect()` が接続を返し、`users` 表がなければ作ります。

## 構成

- `db.py`：`connect(path=":memory:")`。`users` 表の定義もここにあります。
- `tests/`：テスト。

`users` 表の列は `id`（自動採番）、`email`（重複不可）、`password_hash`、`created_at` です。

## テスト

```sh
python3 -m unittest discover -s tests -t .
```
