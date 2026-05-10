import { randomUUID } from "node:crypto";
import type {
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResponse,
  Provider,
} from "./types.js";

/**
 * Failure injection provider for testing resilience.
 *
 * Models follow the pattern `chaos-<behavior>[-...]`. Behavior can also be
 * overridden per-request via X-Chaos-* headers, parsed by the handler and
 * passed through req.messages metadata is not used; we encode behaviors in
 * the model id so tests can be reproduced from the model id alone.
 *
 * Recognized model ids:
 *   chaos-ok                  always returns "ok"
 *   chaos-fail                always throws (synthetic 500)
 *   chaos-fail-rate-50        50% of calls throw
 *   chaos-slow-2000           sleep 2000ms then return ok
 *   chaos-timeout-10000       sleep 10000ms (will trip request timeout)
 *   chaos-stream-cut-mid      streams 3 chunks then throws
 *   chaos-rate-limit          throws an Error with status=429
 *
 * Only registered when ENABLE_CHAOS=true in env.
 */

interface ParsedBehavior {
  failRate: number;
  slowMs: number;
  cutMid: boolean;
  status: number | null;
}

function parseBehavior(model: string): ParsedBehavior {
  const out: ParsedBehavior = {
    failRate: 0,
    slowMs: 0,
    cutMid: false,
    status: null,
  };
  const lower = model.toLowerCase();

  if (lower === "chaos-fail" || lower.startsWith("chaos-fail-rate-")) {
    if (lower === "chaos-fail") out.failRate = 1;
    else {
      const pct = Number(lower.slice("chaos-fail-rate-".length));
      out.failRate = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) / 100 : 1;
    }
  }
  if (lower.startsWith("chaos-slow-") || lower.startsWith("chaos-timeout-")) {
    const ms = Number(lower.split("-").pop());
    out.slowMs = Number.isFinite(ms) ? ms : 0;
  }
  if (lower === "chaos-stream-cut-mid") out.cutMid = true;
  if (lower === "chaos-rate-limit") out.status = 429;
  if (lower === "chaos-server-error") out.status = 500;
  return out;
}

class StatusError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = "StatusError";
  }
}

async function sleepCancellable(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("aborted"));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function maybeFail(b: ParsedBehavior): void {
  if (b.status != null) {
    throw new StatusError(`chaos: synthetic ${b.status}`, b.status);
  }
  if (b.failRate > 0 && Math.random() < b.failRate) {
    throw new StatusError("chaos: synthetic failure", 500);
  }
}

const FIXED_TEXT = "ok";

export const chaosProvider: Provider = {
  id: "chaos",

  supports(model) {
    return model.startsWith("chaos-");
  },

  async chat(req, ctx): Promise<ChatCompletionResponse> {
    const b = parseBehavior(req.model);
    await sleepCancellable(b.slowMs, ctx?.signal);
    maybeFail(b);

    return {
      id: `chatcmpl-${randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: req.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: FIXED_TEXT },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: req.messages.reduce(
          (n, m) => n + Math.ceil(m.content.length / 4),
          0
        ),
        completion_tokens: 1,
        total_tokens: 0,
      },
    };
  },

  async *chatStream(
    req,
    ctx
  ): AsyncIterable<ChatCompletionChunk> {
    const b = parseBehavior(req.model);
    await sleepCancellable(b.slowMs, ctx?.signal);
    maybeFail(b);

    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);

    const tokens = ["o", "k", " ", "f", "r", "o", "m", " ", "c", "h", "a", "o", "s"];
    let firstChunk = true;
    let i = 0;

    for (const t of tokens) {
      if (ctx?.signal?.aborted) {
        throw ctx.signal.reason ?? new Error("aborted");
      }
      if (b.cutMid && i === 3) {
        throw new StatusError("chaos: stream cut mid-flight", 502);
      }
      yield {
        id,
        object: "chat.completion.chunk",
        created,
        model: req.model,
        choices: [
          {
            index: 0,
            delta: firstChunk
              ? { role: "assistant", content: t }
              : { content: t },
            finish_reason: null,
          },
        ],
      };
      firstChunk = false;
      i += 1;
      await sleepCancellable(20, ctx?.signal);
    }

    yield {
      id,
      object: "chat.completion.chunk",
      created,
      model: req.model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: req.messages.reduce(
          (n, m) => n + Math.ceil(m.content.length / 4),
          0
        ),
        completion_tokens: tokens.length,
        total_tokens: 0,
      },
    };
  },
};
