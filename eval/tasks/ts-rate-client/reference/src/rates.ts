import { setTimeout as sleep } from "node:timers/promises";
import config from "./rates.config.json" with { type: "json" };

export interface RateDeps {
  fetch?: typeof fetch;
}

// 接続先は環境変数 RATES_API_BASE_URL で変えられる。指定がなければ設定ファイルの値を使う
const BASE_URL = process.env.RATES_API_BASE_URL ?? config.baseUrl;
const RATES_PATH = "/v1/rates";
const CURRENCY_CODE = /^[A-Za-z]{3}$/;

const MAX_ATTEMPTS = 3;
const ATTEMPT_TIMEOUT_MS = 2_000;
const BASE_DELAY_MS = 100;

// 通貨の組み合わせごとに、最後に取得できたレートを覚えておく
const lastKnownRates = new Map<string, number>();

class HttpError extends Error {
  status: number;

  constructor(status: number) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

class InvalidResponseError extends Error {}

function assertCurrencyCode(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !CURRENCY_CODE.test(value)) {
    throw new TypeError(`${label} は英字 3 文字の通貨コードにしてください`);
  }
}

function parseRate(body: unknown): number {
  const rate = typeof body === "object" && body !== null ? (body as { rate?: unknown }).rate : undefined;
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
    throw new InvalidResponseError("rate が正の数値ではありません");
  }
  return rate;
}

async function readRate(response: Response): Promise<number> {
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    if (error instanceof SyntaxError) throw new InvalidResponseError("応答が JSON ではありません", { cause: error });
    throw error;
  }
  return parseRate(body);
}

async function requestRate(fetchFn: typeof fetch, from: string, to: string): Promise<number> {
  const url = new URL(RATES_PATH, BASE_URL);
  url.searchParams.set("from", from);
  url.searchParams.set("to", to);

  const response = await fetchFn(url, { method: "GET", signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS) });
  if (!response.ok) throw new HttpError(response.status);
  return readRate(response);
}

/** 通信エラー・タイムアウト・サーバー側の失敗（5xx / 408 / 429）だけがやり直す価値のある失敗。 */
function isRetryable(error: unknown): boolean {
  if (error instanceof InvalidResponseError) return false;
  if (error instanceof HttpError) return error.status >= 500 || error.status === 408 || error.status === 429;
  return true;
}

/** 待ち時間は回ごとに倍にし、揺らぎ（ジッター）を加える。 */
function backoffDelayMs(attempt: number): number {
  return BASE_DELAY_MS * 2 ** (attempt - 1) + Math.random() * BASE_DELAY_MS;
}

async function withRetry<T>(task: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      if (attempt >= MAX_ATTEMPTS || !isRetryable(error)) throw error;
      await sleep(backoffDelayMs(attempt));
    }
  }
}

/** from から to へのレートを返す。取得できなければ前回の値を返し、それもなければ例外を投げる。 */
export async function getRate(from: string, to: string, deps: RateDeps = {}): Promise<number> {
  assertCurrencyCode(from, "from");
  assertCurrencyCode(to, "to");
  const pair = `${from.toUpperCase()}>${to.toUpperCase()}`;
  const fetchFn = deps.fetch ?? fetch;

  try {
    const rate = await withRetry(() => requestRate(fetchFn, from.toUpperCase(), to.toUpperCase()));
    lastKnownRates.set(pair, rate);
    return rate;
  } catch (error) {
    const previous = lastKnownRates.get(pair);
    if (previous !== undefined) return previous;
    throw new Error(`為替レートを取得できませんでした（${from} → ${to}）`, { cause: error });
  }
}
