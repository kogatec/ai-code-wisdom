# invoice

注文の請求金額を計算する小さなライブラリです。

## 動かし方

- Node.js 26 で `.ts` を**ビルドせずに直接実行**します（型注釈を取り除くだけの実行です）。
- そのため、型注釈以外の TypeScript の構文（`enum`、`namespace`、コンストラクタの引数プロパティなど）は使えません。
- `import` は `./money.ts` のように拡張子付きで書きます。型だけを読み込むときは `import type` を使います。
- 外部パッケージは使いません。テストは `node:test` です。

## 構成

- `src/money.ts`：金額を画面に出す形に整える。
- `test/`：テスト。

## テスト

```sh
npm test
# または
node --test "test/**/*.test.ts"
```
