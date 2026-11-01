import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";

// Real SQLite and state-machine code, isolated from operator keys and databases.
const dir = mkdtempSync(join(tmpdir(), "nft-landed-test-"));
process.env.DB_PATH = join(dir, "test.sqlite");
process.env.REGISTRAR_KEYPAIR = join(dir, "registrar.json");
writeFileSync(process.env.REGISTRAR_KEYPAIR, JSON.stringify(Array.from(Keypair.generate().secretKey)));
const { db, nowSec } = await import("./db.ts");
// bun test runs every file in one process, so the first file's DB_PATH is the
// one db.ts opens: start from empty tables instead of closing or deleting the
// database, which would break whichever file runs next.
for (const t of ["sale", "slot", "returned", "reservation", "allowlist", "item", "collection"]) db.run(`DELETE FROM ${t}`);
const { recordCollection } = await import("./creator.ts");
const { heldBy, mintedIndices } = await import("./collections.ts");
const { getReservation, markLanded } = await import("./reservations.ts");

const spec = { slug: "landed", name: "Landed", symbol: "LND", description: "", price: 0, deposit: 0, royaltyBps: 0, sequential: true };
const items = [1, 2, 3].map((index) => ({ index, name: `Item ${index}`, bytes: Buffer.alloc(0), mime: "image/png", template: {} }));
recordCollection({
  spec, items, collectionPubkey: Keypair.generate().publicKey, registry: Keypair.generate().publicKey,
  creatorPubkey: Keypair.generate().publicKey, manifestSig: "manifest", metaSig: "metadata",
  staged: { seed: Buffer.alloc(32), shuffleCommit: "commit", manifestHash: "hash", manifestJson: "", collectionJson: "", itemCount: items.length,
    manifestItems: items.map((it) => ({ index: it.index, name: it.name, image_sha256: "image", image_mime: it.mime, meta_sha256: "meta", arweave_id: "arweave" })) },
});

const wallet = Keypair.generate().publicKey.toBase58();
const open = db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM reservation WHERE wallet = ? AND state IN ('reserved','awaiting_submit')");
function awaiting(id: string, index: number) {
  db.run(
    `INSERT INTO reservation (id, slug, item_index, wallet, burner, deposit_sig, state, inscription_sig, meta_sig, asset, created_at, expires_at)
     VALUES (?1, 'landed', ?2, ?3, 'burner', NULL, 'awaiting_submit', 'C' || ?2, 'M' || ?2, 'asset' || ?2, ?4, ?4 + 600)`,
    [id, index, wallet, nowSec()]
  );
}

test("a landed mint confirms the reservation and mirrors the slot at once", () => {
  awaiting("r1", 1);
  awaiting("r2", 2);
  expect(open.get(wallet)!.n).toBe(2);
  markLanded(getReservation("r1")!);
  expect(getReservation("r1")!.state).toBe("confirmed");
  expect(open.get(wallet)!.n).toBe(1); // the wallet's open-reservation count drops immediately
  expect(mintedIndices("landed")).toEqual([1]); // the grid's minted set and the progress count see it
  const held = heldBy(wallet);
  expect(held.map((h) => [h.slug, h.item_index, h.asset, h.inscription_sig, h.name, h.col_name])).toEqual([["landed", 1, "asset1", "C1", "Item 1", "Landed"]]);
});

test("landing is idempotent and only ever adds the reservation's own index", () => {
  markLanded(getReservation("r1")!);
  markLanded(getReservation("r2")!);
  expect(open.get(wallet)!.n).toBe(0);
  expect(mintedIndices("landed")).toEqual([1, 2]);
  expect(heldBy(wallet).map((h) => h.item_index)).toEqual([2, 1]); // newest first
  expect(heldBy(Keypair.generate().publicKey.toBase58())).toEqual([]);
});
