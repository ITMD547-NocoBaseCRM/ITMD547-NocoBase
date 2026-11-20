// Fixed-window rate limiter for the public review endpoints. Pure, unit-tested.
// In-memory, per server process: enough for this single-instance deployment. A multi-instance deployment
// would need a shared store (documented as a limitation).

export class FixedWindowLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;

  constructor(limit: number, windowMs: number, maxKeys = 10000) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
  }

  hit(key: string, now: number = Date.now()): { allowed: boolean; retryAfterSeconds: number } {
    let entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      if (this.hits.size >= this.maxKeys) this.sweep(now);
      entry = { count: 0, resetAt: now + this.windowMs };
      this.hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > this.limit) return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) };
    return { allowed: true, retryAfterSeconds: 0 };
  }

  private sweep(now: number) {
    for (const [key, entry] of this.hits) if (entry.resetAt <= now) this.hits.delete(key);
    // Still full (an attack from many addresses): drop the oldest windows rather than grow without bound.
    if (this.hits.size >= this.maxKeys) {
      const excess = this.hits.size - Math.floor(this.maxKeys / 2);
      let i = 0;
      for (const key of this.hits.keys()) {
        if (i++ >= excess) break;
        this.hits.delete(key);
      }
    }
  }
}
