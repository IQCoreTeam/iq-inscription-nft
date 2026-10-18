// Rotate the registrar (co-signer) of every collection's registry to a new
// pubkey, signed by the admin. The registrar secret never needs to be here:
// initialize_registry and rotate_registrar both take it as a plain pubkey; the
// secret only signs register_item, on the server. Use this to move the hot
// co-signer onto the server (its key generated there, only its pubkey shared).
//
//   bun --env-file=backend/.env.devnet backend/scripts/rotate-registrar.ts \
//       --new <REGISTRAR_PUBKEY> --admin ~/Desktop/deploy/deploy.json
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { config, idl } from "../src/config.ts";
import { db } from "../src/db.ts";

const { values: a } = parseArgs({ options: { new: { type: "string" }, admin: { type: "string" } } });
if (!a.new || !a.admin) throw new Error("--new <pubkey> and --admin <keypair> required");
const newRegistrar = new PublicKey(a.new);
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(a.admin.replace(/^~/, process.env.HOME!), "utf8"))));

const connection = new Connection(config.rpcUrls[0], "confirmed");
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(admin), { commitment: "confirmed" });
const program = new anchor.Program(idl, provider);

const rows = db.query<{ slug: string; registry: string }, []>("SELECT slug, registry FROM collection").all();
console.log(`admin ${admin.publicKey.toBase58()} -> new registrar ${newRegistrar.toBase58()}`);
for (const r of rows) {
  const registry = new PublicKey(r.registry);
  const before = (await program.account.registry.fetch(registry)).registrar as PublicKey;
  if (before.equals(newRegistrar)) { console.log(`  ${r.slug}: already ${newRegistrar.toBase58().slice(0, 8)}, skip`); continue; }
  const sig = await program.methods.rotateRegistrar(newRegistrar).accounts({ admin: admin.publicKey, registry }).rpc();
  const after = (await program.account.registry.fetch(registry)).registrar as PublicKey;
  console.log(`  ${r.slug}: ${before.toBase58().slice(0, 8)} -> ${after.toBase58().slice(0, 8)}  ${after.equals(newRegistrar) ? "OK" : "MISMATCH"}  (${sig.slice(0, 8)})`);
}
console.log("done");
