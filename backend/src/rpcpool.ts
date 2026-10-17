// The RPC pool: endpoints WE control, rotating on 429/5xx. Typed helpers go
// through web3.js Connections (one per url) so the objects handed to the SDK
// verifier are exactly VersionedTransactionResponse shaped. Never a
// user-supplied endpoint: a hostile RPC could return a doctored transaction and
// walk a fake inscription past the verifier.

import { Connection } from "@solana/web3.js";
import { config } from "./config.ts";

type Stat = { url: string; ok: number; fail: number; totalMs: number };

const connections = config.rpcUrls.map((url) => new Connection(url, "confirmed"));
const stats: Stat[] = config.rpcUrls.map((url) => ({ url, ok: 0, fail: 0, totalMs: 0 }));

// Run `fn` against each endpoint in turn until one succeeds. `retableOnNull`
// lets getTransaction treat a null (tx not yet visible) as a reason to rotate.
export async function withConnection<T>(
  fn: (c: Connection) => Promise<T>,
  opts: { retableOnNull?: boolean } = {}
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < connections.length; i++) {
    const start = Date.now();
    const host = new URL(stats[i].url).host; // hostname only, never the api-key
    try {
      const out = await fn(connections[i]);
      if (opts.retableOnNull && out == null && i < connections.length - 1) {
        stats[i].fail++;
        console.warn(`[rpc] ${host} returned null (${Date.now() - start}ms), rotating to fallback`);
        continue;
      }
      stats[i].ok++;
      stats[i].totalMs += Date.now() - start;
      return out;
    } catch (e) {
      stats[i].fail++;
      stats[i].totalMs += Date.now() - start;
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[rpc] ${host} failed (${Date.now() - start}ms): ${msg}${i < connections.length - 1 ? ", rotating" : ""}`);
    }
  }
  throw lastErr ?? new Error("rpc pool exhausted");
}

export function poolStats() {
  return stats.map((s) => ({
    url: s.url.replace(/(api-key=|\/)([A-Za-z0-9_-]{6})[A-Za-z0-9_-]+/g, "$1$2..."),
    ok: s.ok,
    fail: s.fail,
    avgMs: s.ok + s.fail > 0 ? Math.round(s.totalMs / (s.ok + s.fail)) : 0,
  }));
}
