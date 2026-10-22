import { test } from "node:test";
import assert from "node:assert/strict";
import { getRate } from "../../src/rates.ts";

// 前回の値はモジュール内に残るので、テストごとに別の通貨の組み合わせを使う。
let counter = 0;
function freshPair(): { from: string; to: string } {
  counter += 1;
  const code = (n: number) =>
    String.fromCharCode(65 + (Math.floor(n / 676) % 26), 65 + (Math.floor(n / 26) % 26), 65 + (n % 26));
  return { from: code(counter * 2), to: code(counter * 2 + 1) };
}

type Step = { error: Error } | { status: number; body?: unknown };

interface Call {
  url: URL;
  method: string | undefined;
}

/** steps を順に返す fetch。使い切ったあとは最後の項目を返し続ける。 */
function makeFetch(steps: Step[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const stub = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? new URL(input.url) : new URL(String(input));
    const method = input instanceof Request ? input.method : init?.method;
    calls.push({ url, method });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    if ("error" in step) throw step.error;
    return new Response(JSON.stringify(step.body ?? {}), {
      status: step.status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch: stub as typeof fetch, calls };
}

const ok = (rate: number): Step => ({ status: 200, body: { rate } });
const networkError = (): Step => ({ error: new TypeError("fetch failed") });

test("所定の URL へ GET で問い合わせ、応答の rate を数値で返す", { timeout: 20_000 }, async () => {
  const { from, to } = freshPair();
  const stub = makeFetch([ok(150.25)]);

  const rate = await getRate(from, to, { fetch: stub.fetch });

  assert.equal(rate, 150.25);
  assert.equal(stub.calls.length, 1);
  const { url, method } = stub.calls[0];
  assert.equal(url.origin, "https://api.example-rates.test");
  assert.equal(url.pathname, "/v1/rates");
  assert.equal(url.searchParams.get("from"), from);
  assert.equal(url.searchParams.get("to"), to);
  assert.ok(method === undefined || method.toUpperCase() === "GET");
});

test("成功するたびに最新の値を取り直す", { timeout: 20_000 }, async () => {
  const { from, to } = freshPair();
  const stub = makeFetch([ok(100), ok(101)]);

  assert.equal(await getRate(from, to, { fetch: stub.fetch }), 100);
  assert.equal(await getRate(from, to, { fetch: stub.fetch }), 101);
  assert.equal(stub.calls.length, 2);
});

test("通信エラーのときは、前回の値を返す", { timeout: 20_000 }, async () => {
  const { from, to } = freshPair();
  assert.equal(await getRate(from, to, { fetch: makeFetch([ok(120.5)]).fetch }), 120.5);

  const failing = makeFetch([networkError()]);
  assert.equal(await getRate(from, to, { fetch: failing.fetch }), 120.5);
});

test("HTTP エラー（500）のときは、前回の値を返す", { timeout: 20_000 }, async () => {
  const { from, to } = freshPair();
  assert.equal(await getRate(from, to, { fetch: makeFetch([ok(99.9)]).fetch }), 99.9);

  const failing = makeFetch([{ status: 500, body: { error: "boom" } }]);
  assert.equal(await getRate(from, to, { fetch: failing.fetch }), 99.9);
});

test("前回の値がなくて取得に失敗したら、例外を投げる", { timeout: 20_000 }, async () => {
  const a = freshPair();
  await assert.rejects(getRate(a.from, a.to, { fetch: makeFetch([networkError()]).fetch }));

  const b = freshPair();
  await assert.rejects(getRate(b.from, b.to, { fetch: makeFetch([{ status: 500 }]).fetch }));
});

test("前回の値は通貨の組み合わせごとに別々に覚える", { timeout: 20_000 }, async () => {
  const a = freshPair();
  const b = freshPair();
  assert.equal(await getRate(a.from, a.to, { fetch: makeFetch([ok(100)]).fetch }), 100);

  // b はまだ成功したことがないので、a の値を返してはいけない
  await assert.rejects(getRate(b.from, b.to, { fetch: makeFetch([networkError()]).fetch }));

  assert.equal(await getRate(b.from, b.to, { fetch: makeFetch([ok(200)]).fetch }), 200);
  assert.equal(await getRate(a.from, a.to, { fetch: makeFetch([networkError()]).fetch }), 100);
  assert.equal(await getRate(b.from, b.to, { fetch: makeFetch([networkError()]).fetch }), 200);
});

test("通信エラーが一度起きても、やり直して成功すればその値を返す", { timeout: 20_000 }, async () => {
  const { from, to } = freshPair();
  assert.equal(await getRate(from, to, { fetch: makeFetch([ok(100)]).fetch }), 100);

  const flaky = makeFetch([networkError(), ok(200)]);
  assert.equal(await getRate(from, to, { fetch: flaky.fetch }), 200);
  assert.equal(flaky.calls.length, 2);
});

test("503 が一度返っても、やり直して成功すればその値を返す", { timeout: 20_000 }, async () => {
  const { from, to } = freshPair();
  assert.equal(await getRate(from, to, { fetch: makeFetch([ok(100)]).fetch }), 100);

  const flaky = makeFetch([{ status: 503, body: { error: "unavailable" } }, ok(300)]);
  assert.equal(await getRate(from, to, { fetch: flaky.fetch }), 300);
  assert.equal(flaky.calls.length, 2);
});
