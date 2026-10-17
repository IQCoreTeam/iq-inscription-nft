// The verifier: prove the minter's inscriptions ARE the item, byte for byte,
// before co-signing. The load-bearing security check. Each check does one
// getTransaction through our own rotating pool and hands the object to the SDK
// reader, so a hostile RPC never gets a say.
//
// C must be a feed row {kind: "image", body: data URL, who: wallet} whose image
// bytes sha256 to the manifest hash. M must be exactly the canonical JSON the
// server built for (item, C). Both must be paid by the burner that reserved.

import { createHash } from "node:crypto";
import { reader, setRpcUrl } from "@iqlabs-official/solana-sdk";
import { config } from "./config.ts";
import { withConnection } from "./rpcpool.ts";
import { buildMetadata } from "./metadata.ts";
import type { CollectionRow, ItemRow, ReservationRow } from "./db.ts";

// Set once, to our primary, and never rotated: the SDK's RPC is a process-global
// and only linked-list / session walks go through it (inline reads cost zero).
setRpcUrl(config.rpcUrls[0]);

// retry: true means the chain could not be read (RPC down, 429, tx not visible
// yet), which is not a verdict: the caller keeps the reservation and the client
// tries again. retry: false is a real mismatch and the reservation is rejected.
export type VerifyResult = { pass: true } | { pass: false; retry: boolean; reason: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const transient = (e: unknown) => /429|Too Many Requests|rate|timeout|ECONN|fetch failed|503|502|pool exhausted/i.test(String(e));

function feePayerOf(tx: any): string | null {
  const msg = tx?.transaction?.message;
  const keys = msg?.staticAccountKeys ?? msg?.accountKeys;
  const first = keys?.[0];
  if (!first) return null;
  return typeof first === "string" ? first : first.toBase58();
}

// One getTransaction + SDK decode, with backoff on transient RPC trouble (a
// session-path image walks a dozen chunk transactions, which public RPCs
// rate-limit). Returns the payload, a definitive reason, or a retry.
async function readInscription(sig: string, burner: string): Promise<{ data: string } | { reason: string; retry: boolean }> {
  const delays = [2000, 4000, 8000];
  for (let attempt = 0; ; attempt++) {
    let tx: any;
    try {
      tx = await withConnection(
        (c) => c.getTransaction(sig, { maxSupportedTransactionVersion: 1, commitment: "confirmed" }),
        { retableOnNull: true }
      );
    } catch (e) {
      if (attempt < delays.length) { await sleep(delays[attempt]); continue; }
      return { retry: true, reason: `rpc pool could not fetch ${sig.slice(0, 8)}: ${e}` };
    }
    if (!tx) {
      // not visible yet on this endpoint: give propagation a moment
      if (attempt < delays.length) { await sleep(delays[attempt]); continue; }
      return { retry: true, reason: `transaction ${sig.slice(0, 8)} not found` };
    }
    if (tx.meta?.err) return { retry: false, reason: `transaction ${sig.slice(0, 8)} failed on chain` };
    const payer = feePayerOf(tx);
    if (payer !== burner) return { retry: false, reason: `fee payer ${payer} is not the reserving burner ${burner}` };
    let decoded: { metadata: string; data: string | null };
    try {
      decoded = await reader.readUserInventoryCodeInFromTx(tx);
    } catch (e) {
      if (transient(e) && attempt < delays.length) { await sleep(delays[attempt]); continue; }
      return { retry: transient(e), reason: `SDK could not decode ${sig.slice(0, 8)}: ${e}` };
    }
    const data = decoded.data ?? (decoded.metadata ? (JSON.parse(decoded.metadata).data ?? null) : null);
    if (data == null) return { retry: false, reason: `no code-in data in ${sig.slice(0, 8)}` };
    return { data };
  }
}

// The image inscription is the site's feed row; the bytes live in a data URL.
function imageBytesOf(row: string, wallet: string): { bytes: Buffer } | { reason: string } {
  let obj: any;
  try {
    obj = JSON.parse(row);
  } catch {
    return { reason: "image inscription is not a feed row" };
  }
  if (obj?.kind !== "image") return { reason: `feed row kind is ${obj?.kind}, expected image` };
  if (obj?.who !== wallet) return { reason: `feed row who is ${obj?.who}, expected ${wallet}` };
  const body = String(obj.body ?? "");
  const at = body.indexOf(";base64,");
  if (!body.startsWith("data:") || at < 0) return { reason: "feed row body is not a base64 data URL" };
  return { bytes: Buffer.from(body.slice(at + 8), "base64") };
}

export async function verifyItem(
  r: ReservationRow,
  c: CollectionRow,
  item: ItemRow,
  inscriptionSig: string,
  metaSig: string
): Promise<VerifyResult> {
  const image = await readInscription(inscriptionSig, r.burner);
  if ("reason" in image) return { pass: false, retry: image.retry, reason: `C: ${image.reason}` };
  const bytes = imageBytesOf(image.data, r.wallet);
  if ("reason" in bytes) return { pass: false, retry: false, reason: `C: ${bytes.reason}` };
  const got = createHash("sha256").update(bytes.bytes).digest("hex");
  if (got !== item.image_sha256) {
    return { pass: false, retry: false, reason: `C: sha256 of the inscribed image ${got.slice(0, 12)} is not the manifest hash ${item.image_sha256.slice(0, 12)}` };
  }

  const meta = await readInscription(metaSig, r.burner);
  if ("reason" in meta) return { pass: false, retry: meta.retry, reason: `M: ${meta.reason}` };
  if (meta.data !== buildMetadata(c, item, inscriptionSig)) {
    return { pass: false, retry: false, reason: "M: inscribed JSON is not the canonical metadata for this item and C" };
  }
  return { pass: true };
}

// Single NFT: the user is the author, so the only facts to check are that both
// inscriptions were paid by the requester's burner, the row names the wallet,
// and M is a JSON object that points at C.
export async function verifySingle(wallet: string, burner: string, inscriptionSig: string, metaSig: string): Promise<VerifyResult> {
  const content = await readInscription(inscriptionSig, burner);
  if ("reason" in content) return { pass: false, retry: content.retry, reason: `C: ${content.reason}` };
  try {
    const row = JSON.parse(content.data);
    if (row?.who !== wallet) return { pass: false, retry: false, reason: `C: feed row who is ${row?.who}, expected ${wallet}` };
  } catch {
    return { pass: false, retry: false, reason: "C: inscription is not a feed row" };
  }
  const meta = await readInscription(metaSig, burner);
  if ("reason" in meta) return { pass: false, retry: meta.retry, reason: `M: ${meta.reason}` };
  try {
    const json = JSON.parse(meta.data);
    const points = Array.isArray(json?.attributes) && json.attributes.some((a: any) => a?.trait_type === "inscription" && a?.value === inscriptionSig);
    if (!points) return { pass: false, retry: false, reason: "M: attributes.inscription does not name C" };
  } catch {
    return { pass: false, retry: false, reason: "M: not valid JSON" };
  }
  return { pass: true };
}
