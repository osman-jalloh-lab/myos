// Sliding-window in-memory rate limiter.
// Works per Vercel function instance — adequate for a single-user personal OS.
// For multi-user or distributed enforcement, swap the store for Vercel KV / Upstash.

interface Window {
  tokens: number[];   // timestamps of recent requests
  blockedUntil?: number;
}

const store = new Map<string, Window>();

// Clean up entries older than the window to prevent memory growth
function prune(window: Window, windowMs: number, now: number) {
  const cutoff = now - windowMs;
  window.tokens = window.tokens.filter((t) => t > cutoff);
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs?: number;
}

export function rateLimit(
  key: string,
  opts: {
    limit: number;      // max requests per window
    windowMs: number;   // window duration in ms
    blockMs?: number;   // how long to block after limit hit (default: windowMs)
  }
): RateLimitResult {
  const now = Date.now();
  const blockMs = opts.blockMs ?? opts.windowMs;

  let entry = store.get(key);
  if (!entry) {
    entry = { tokens: [] };
    store.set(key, entry);
  }

  // Check hard block first
  if (entry.blockedUntil && now < entry.blockedUntil) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterMs: entry.blockedUntil - now,
    };
  }

  prune(entry, opts.windowMs, now);

  if (entry.tokens.length >= opts.limit) {
    entry.blockedUntil = now + blockMs;
    return {
      allowed: false,
      remaining: 0,
      retryAfterMs: blockMs,
    };
  }

  entry.tokens.push(now);
  return {
    allowed: true,
    remaining: opts.limit - entry.tokens.length,
  };
}

export function rateLimitResponse(result: RateLimitResult): Response {
  const retryAfterSec = Math.ceil((result.retryAfterMs ?? 60_000) / 1000);
  return new Response(
    JSON.stringify({ error: "Too many requests", retryAfterSec }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(retryAfterSec),
        "X-RateLimit-Remaining": "0",
      },
    }
  );
}
