/**
 * Per-(provider, model) circuit breaker.
 *
 * States:
 *   closed    - normal traffic. Failures increment a rolling counter.
 *   open      - reject without calling upstream. Auto-transitions to half-open after openMs.
 *   half-open - allow ONE probe. On success → closed. On failure → open again.
 *
 * Counters are rolling: failures older than rollingWindowMs are forgotten.
 */

export type CircuitState = "closed" | "open" | "half-open";

interface BreakerEntry {
  state: CircuitState;
  failures: number[]; // timestamps of recent failures
  successes: number; // count in current window (for ratio if we ever need it)
  openedAt: number;
  halfOpenInFlight: boolean;
}

export interface CircuitBreakerOptions {
  failureThreshold: number; // failures within window to open
  rollingWindowMs: number; // window for counting failures
  openMs: number; // time the circuit stays open
}

const DEFAULTS: CircuitBreakerOptions = {
  failureThreshold: 5,
  rollingWindowMs: 30_000,
  openMs: 30_000,
};

export class CircuitBreaker {
  private breakers = new Map<string, BreakerEntry>();
  private opts: CircuitBreakerOptions;

  constructor(opts: Partial<CircuitBreakerOptions> = {}) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  state(key: string): CircuitState {
    const b = this.breakers.get(key);
    if (!b) return "closed";

    if (b.state === "open") {
      if (Date.now() - b.openedAt >= this.opts.openMs) {
        b.state = "half-open";
        b.halfOpenInFlight = false;
      }
    }
    return b.state;
  }

  /**
   * Reserves a call slot. Returns false if the circuit is open or a half-open
   * probe is already in flight. The caller MUST then invoke recordSuccess()
   * or recordFailure() once the upstream call resolves.
   */
  tryAcquire(key: string): boolean {
    const state = this.state(key);
    if (state === "open") return false;

    const b = this.ensure(key);
    if (state === "half-open") {
      if (b.halfOpenInFlight) return false;
      b.halfOpenInFlight = true;
    }
    return true;
  }

  recordSuccess(key: string): void {
    const b = this.ensure(key);
    b.successes += 1;
    if (b.state !== "closed") {
      b.state = "closed";
      b.failures = [];
      b.openedAt = 0;
      b.halfOpenInFlight = false;
    }
    this.trim(b);
  }

  recordFailure(key: string): void {
    const b = this.ensure(key);
    const now = Date.now();
    b.failures.push(now);
    this.trim(b);

    if (b.state === "half-open") {
      b.state = "open";
      b.openedAt = now;
      b.halfOpenInFlight = false;
      return;
    }

    if (
      b.state === "closed" &&
      b.failures.length >= this.opts.failureThreshold
    ) {
      b.state = "open";
      b.openedAt = now;
    }
  }

  /** Total open circuits, for /metrics. */
  countOpen(): number {
    let n = 0;
    for (const key of this.breakers.keys()) {
      if (this.state(key) === "open") n += 1;
    }
    return n;
  }

  /** All circuit states keyed by `${providerId}:${modelId}`. */
  snapshot(): Array<{ key: string; state: CircuitState; failures: number }> {
    const out: Array<{ key: string; state: CircuitState; failures: number }> =
      [];
    for (const key of this.breakers.keys()) {
      const b = this.breakers.get(key)!;
      out.push({ key, state: this.state(key), failures: b.failures.length });
    }
    return out;
  }

  private ensure(key: string): BreakerEntry {
    let b = this.breakers.get(key);
    if (!b) {
      b = {
        state: "closed",
        failures: [],
        successes: 0,
        openedAt: 0,
        halfOpenInFlight: false,
      };
      this.breakers.set(key, b);
    }
    return b;
  }

  private trim(b: BreakerEntry): void {
    const cutoff = Date.now() - this.opts.rollingWindowMs;
    while (b.failures.length > 0 && b.failures[0]! < cutoff) {
      b.failures.shift();
    }
  }
}

export const circuitBreaker = new CircuitBreaker();

export function circuitKey(providerId: string, modelId: string): string {
  return `${providerId}:${modelId}`;
}
