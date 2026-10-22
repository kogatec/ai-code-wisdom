import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { getRate } from "../../src/rates.ts";

// 相手が応答しない・エラーを返し続ける・おかしな中身を返す、といった場面でも、
// 呼び出し側が止まり続けたり、変な値を受け取ったりしないことを確かめる。

let counter = 0;
function freshPair(): { from: string; to: string } {
  counter += 1;
  const code = (n: number) =>
    String.fromCharCode(65 + (Math.floor(n / 676) % 26), 65 + (Math.floor(n / 26) % 26), 65 + (n % 26));
  return { from: code(counter * 2), to: code(counter * 2 + 1) };
}

type Step = { error: Error } | { status: number; body?: unknown } | { raw: string };

function makeFetch(steps: Step[]): { fetch: typeof fetch; urls: URL[] } {
  const urls: URL[] = [];
  const stub = async (input: string | URL | Request): Promise<Response> => {
    urls.push(input instanceof Request ? new URL(input.url) : new URL(String(input)));
    const step = steps[Math.min(urls.length - 1, steps.length - 1)];
    if ("error" in step) throw step.error;
    if ("raw" in step) return new Response(step.raw, { status: 200 });
    return new Response(JSON.stringify(step.body ?? {}), {
      status: step.status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch: stub as typeof fetch, urls };
}

const ok = (rate: number): Step => ({ status: 200, body: { rate } });

/** signal で中断されるまで解決しない fetch（signal が渡されなければ永遠に解決しない）。 */
function hangingFetch(): typeof fetch {
  const stub = (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      if (!signal) return;
      const abort = () => reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  return stub as typeof fetch;
}

const LIMIT_MS = 15_000;

describe("応答しない相手", { concurrency: true }, () => {
  test("前回の値がなければ、15 秒以内に例外で終わる", { timeout: 20_000 }, async () => {
    const { from, to } = freshPair();
    const started = performance.now();
    await assert.rejects(getRate(from, to, { fetch: hangingFetch() }));
    const elapsed = performance.now() - started;
    assert.ok(elapsed < LIMIT_MS, `${Math.round(elapsed)}ms かかりました`);
  });

  test("前回の値があれば、15 秒以内にその値を返して終わる", { timeout: 20_000 }, async () => {
    const { from, to } = freshPair();
    assert.equal(await getRate(from, to, { fetch: makeFetch([ok(150)]).fetch }), 150);

    const started = performance.now();
    assert.equal(await getRate(from, to, { fetch: hangingFetch() }), 150);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < LIMIT_MS, `${Math.round(elapsed)}ms かかりました`);
  });
});

test("400 や 404 のような、やり直しても直らない失敗は再試行しない", { timeout: 20_000 }, async () => {
  for (const status of [400, 404]) {
    const a = freshPair();
    const noCache = makeFetch([{ status, body: { error: "bad request" } }]);
    await assert.rejects(getRate(a.from, a.to, { fetch: noCache.fetch }));
    assert.equal(noCache.urls.length, 1, `${status} を ${noCache.urls.length} 回リクエストしました`);

    const b = freshPair();
    assert.equal(await getRate(b.from, b.to, { fetch: makeFetch([ok(10)]).fetch }), 10);
    const withCache = makeFetch([{ status, body: { error: "bad request" } }]);
    assert.equal(await getRate(b.from, b.to, { fetch: withCache.fetch }), 10);
    assert.equal(withCache.urls.length, 1, `${status} を ${withCache.urls.length} 回リクエストしました`);
  }
});

test("500 が続いても、有限回の再試行で終わる", { timeout: 20_000 }, async () => {
  const { from, to } = freshPair();
  const failing = makeFetch([{ status: 500, body: { error: "boom" } }]);

  const started = performance.now();
  await assert.rejects(getRate(from, to, { fetch: failing.fetch }));
  const elapsed = performance.now() - started;

  assert.ok(failing.urls.length >= 1);
  assert.ok(failing.urls.length <= 10, `${failing.urls.length} 回もリクエストしました`);
  assert.ok(elapsed < LIMIT_MS, `${Math.round(elapsed)}ms かかりました`);
});

const BAD_BODIES: Step[] = [
  { status: 200, body: { rate: "abc" } },
  { status: 200, body: { rate: null } },
  { status: 200, body: {} },
  { status: 200, body: { rate: {} } },
  { status: 200, body: { rate: [] } },
  { status: 200, body: { rate: true } },
  { status: 200, body: [] },
  { status: 200, body: "text" },
  { status: 200, body: null },
  { raw: "this is not json" },
];

test("rate が数値でない応答は、前回の値がなければ例外にする", { timeout: 20_000 }, async () => {
  await Promise.all(
    BAD_BODIES.map(async (step) => {
      const { from, to } = freshPair();
      await assert.rejects(
        getRate(from, to, { fetch: makeFetch([step]).fetch }),
        () => true,
        `応答 ${JSON.stringify(step)} の値が返されました`,
      );
    }),
  );
});

test("rate が数値でない応答のときは、数値の前回の値を返す", { timeout: 20_000 }, async () => {
  await Promise.all(
    BAD_BODIES.map(async (step) => {
      const { from, to } = freshPair();
      assert.equal(await getRate(from, to, { fetch: makeFetch([ok(123.45)]).fetch }), 123.45);
      const value = await getRate(from, to, { fetch: makeFetch([step]).fetch });
      assert.equal(value, 123.45, `応答 ${JSON.stringify(step)} のとき ${String(value)} を返しました`);
    }),
  );
});

test("通貨コードに URL の記号が混ざっても、問い合わせ先やほかのパラメーターは変わらない", { timeout: 20_000 }, async () => {
  for (const from of ["USD&to=EUR", "USD#frag", "US D", "USD/../admin"]) {
    const stub = makeFetch([ok(1.5)]);
    try {
      await getRate(from, "JPY", { fetch: stub.fetch });
    } catch {
      // 不正な通貨コードとして拒否してもよい
    }
    // 問い合わせるなら、値は 1 つのパラメーターとして正しくエンコードされていること
    for (const url of stub.urls) {
      assert.equal(url.origin, "https://api.example-rates.test");
      assert.equal(url.pathname, "/v1/rates");
      assert.deepEqual(url.searchParams.getAll("from"), [from]);
      assert.deepEqual(url.searchParams.getAll("to"), ["JPY"]);
    }
  }
});
