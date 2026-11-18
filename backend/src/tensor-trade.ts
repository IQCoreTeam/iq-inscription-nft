// Secondary-market trade transactions, built by the Tensor TX API and handed to
// the client unsigned. The trade settles on Tensor's on-chain program (TCOMP),
// not ours; we only build the tx (the API key stays server-side) and set our
// treasury as the broker so our share of Tensor's taker fee comes back to us.
// Read-side listings/sales live in tensor.ts; this is the write side. Nothing
// here signs or spends.

import { config } from "./config.ts";
import { withConnection } from "./rpcpool.ts";
import { PLATFORM_TREASURY } from "./program.ts";
import { isSol } from "./currencies.ts";

// Our treasury collects the maker/taker broker share of Tensor's fee.
const BROKER = PLATFORM_TREASURY.toBase58();

export type TradeTx = { txV0: string; lastValidBlockHeight: number | null; totalCost: number | null };

async function tensorTx(path: string, params: Record<string, string>): Promise<TradeTx> {
  if (!config.tensorApiKey) throw new Error("tensor api key not configured");
  const url = `${config.tensorBase}${path}?${new URLSearchParams(params)}`;
  const r = await fetch(url, { headers: { "x-tensor-api-key": config.tensorApiKey } });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error((j && (j.message || j.error)) || `tensor ${path} ${r.status}`);
  const t = j?.txs?.[0];
  if (!t?.txV0) throw new Error(`tensor ${path} returned no transaction`);
  // The API returns txV0 as a Buffer-JSON ({type:"Buffer",data:[...]}), not the
  // base64 the OpenAPI implies. Normalize to a base64 string so the client just
  // does VersionedTransaction.deserialize(base64 -> bytes).
  const raw = t.txV0 as any;
  const txV0 = typeof raw === "string" ? raw : Buffer.from(raw.data ?? raw).toString("base64");
  return { txV0, lastValidBlockHeight: t.lastValidBlockHeight ?? null, totalCost: j.totalCost ?? null };
}

const blockhash = () => withConnection((c) => c.getLatestBlockhash("confirmed")).then((b) => b.blockhash);

// List the seller's NFT. `price` is in the currency's base unit (lamports for
// SOL). currency null/SOL lists in SOL. makerBroker = our treasury.
export async function buildListTx(a: { mint: string; owner: string; price: number; currency?: string | null }): Promise<TradeTx> {
  const p: Record<string, string> = { mint: a.mint, owner: a.owner, price: String(a.price), blockhash: await blockhash(), makerBroker: BROKER };
  if (!isSol(a.currency)) p.currency = a.currency as string;
  return tensorTx("/tx/list", p);
}

// Buy a listed NFT. `maxPrice` caps slippage (base unit). includeTotalCost so the
// response's totalCost covers royalties + fees. takerBroker = our treasury.
export async function buildBuyTx(a: { mint: string; buyer: string; owner: string; maxPrice: number; currency?: string | null }): Promise<TradeTx> {
  const p: Record<string, string> = { mint: a.mint, buyer: a.buyer, owner: a.owner, maxPrice: String(a.maxPrice), blockhash: await blockhash(), takerBroker: BROKER, includeTotalCost: "true" };
  if (!isSol(a.currency)) p.currency = a.currency as string;
  return tensorTx("/tx/buy", p);
}

// Cancel the seller's listing (no currency, no broker).
export async function buildDelistTx(a: { mint: string; owner: string }): Promise<TradeTx> {
  return tensorTx("/tx/delist", { mint: a.mint, owner: a.owner, blockhash: await blockhash() });
}
