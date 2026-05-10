import { TimeoutError } from "./timeouts.js";

export interface RetryOptions {
  maxAttempts: number;
  baseMs: number;
  maxMs: number;
}

export function isTransient(err: unknown): boolean {
  if (err instanceof TimeoutError) return true;
  if (!(err instanceof Error)) return false;

  const message = err.message?.toLowerCase() ?? "";
  if (
    message.includes("econnreset") ||
    message.includes("econnrefused") ||
    message.includes("etimedout") ||
    message.includes("socket hang up") ||
    message.includes("network") ||
    message.includes("fetch failed") ||
    message.includes("timeout")
  ) {
    return true;
  }

  const status = (err as { status?: unknown }).status;
  if (typeof status === "number") {
    if (status === 408 || status === 425 || status === 429) return true;
    if (status >= 500 && status < 600) return true;
  }
  return false;
}

function backoffMs(attempt: number, opts: RetryOptions): number {
  const exp = Math.min(opts.maxMs, opts.baseMs * 2 ** (attempt - 1));
  return Math.floor(Math.random() * exp);
}

export interface RetryResult<T> {
  value: T;
  attempts: number;
}

export async function retry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions
): Promise<RetryResult<T>> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      const value = await fn(attempt);
      return { value, attempts: attempt };
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || attempt === opts.maxAttempts) {
        throw err;
      }
      const sleep = backoffMs(attempt, opts);
      await new Promise((r) => setTimeout(r, sleep));
    }
  }
  throw lastErr;
}
