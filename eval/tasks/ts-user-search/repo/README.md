# user-search

ユーザー情報を SQLite（`node:sqlite`）に保存する小さなライブラリです。

## 動かし方

- Node.js 26 で `.ts` を**ビルドせずに直接実行**します（型注釈を取り除くだけの実行です）。
- そのため、型注釈以外の TypeScript の構文（`enum`、`namespace`、コンストラクタの引数プロパティなど）は使えません。
- `import` は `./users.ts` のように拡張子付きで書きます。型だけを読み込むときは `import type` を使います。
- 外部パッケージは使いません。DB は標準の `node:sqlite`、テストは `node:test` です。

## 構成

- `src/db.ts`：`openDb()` が `users` 表を持つ DB を開く。`addUser()` がユーザーを追加する。
- `test/`：テスト。

`users` 表の列は `id`（自動採番）、`name`、`email`、`created_at`（ISO 8601 の文字列）です。

## テスト

```sh
npm test
# または
node --test "test/**/*.test.ts"
```
