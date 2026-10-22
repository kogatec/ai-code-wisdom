# rate-client

為替レートを外部の API から取得する小さなクライアントです。

## 動かし方

- Node.js 26 で `.ts` を**ビルドせずに直接実行**します（型注釈を取り除くだけの実行です）。
- そのため、型注釈以外の TypeScript の構文（`enum`、`namespace`、コンストラクタの引数プロパティなど）は使えません。
- `import` は `./format.ts` のように拡張子付きで書きます。型だけを読み込むときは `import type` を使います。
- 外部パッケージは使いません。HTTP は標準の `fetch`、テストは `node:test` です。

## 構成

- `src/format.ts`：レートを画面に出す形に整える。
- `test/`：テスト。

## テスト

```sh
npm test
# または
node --test "test/**/*.test.ts"
```
