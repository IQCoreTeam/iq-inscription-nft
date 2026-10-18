// Configuration, loaded once at boot. Everything comes from process env; the
// collections themselves live in SQLite (one backend serves many collections),
// so there is no per-deployment file like bible-nft had. Nothing here reaches a
// browser: the registrar key and the RPC credentials stay in this process.

import { readFileSync } from "node:fs";
import { dirname, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey } from "@solana/web3.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, "..", "..");
export const IDL_PATH = join(REPO_ROOT, "target", "idl", "iq_inscription_nft.json");

export const MPL_CORE = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
// The IQLabs code-in program: every C and M is a transaction against it.
export const CODE_IN_PROGRAM = new PublicKey("9KLLchQVJpGkw4jPuUmnvqESdR7mtNCYr3qS4iQLabs");

function repoPath(p: string): string {
  return isAbsolute(p) ? p : join(REPO_ROOT, p);
}

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing required env ${name}`);
  }
  return v;
}

function loadKeypair(path: string): Keypair {
  const secret = JSON.parse(readFileSync(repoPath(path), "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

export const idl = JSON.parse(readFileSync(IDL_PATH, "utf8"));

export const config = {
  port: Number(env("PORT", "8787")),
  dbPath: repoPath(env("DB_PATH", "backend/.data/nft.sqlite")),
  cluster: env("CLUSTER", "devnet") as "devnet" | "mainnet",
  programId: new PublicKey(idl.address as string),

  // The co-signer. Never the fee payer. File mode 0600, never in git.
  registrar: loadKeypair(env("REGISTRAR_KEYPAIR", "backend/.registrar.json")),

  // Primary first. Rotation walks the list on 429/5xx. Never a user-supplied
  // endpoint: a hostile RPC could return a doctored transaction and walk a fake
  // inscription past the verifier.
  rpcUrls: env("RPC_URLS", "https://api.devnet.solana.com")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  // Where the on-chain uri and the metadata image point. A cache over the chain.
  gatewayBase: env("GATEWAY_BASE", "https://gateway.iqlabs.dev").replace(/\/$/, ""),
  // The slug of the global single-NFT collection (max_supply 0) that
  // /single/mint registers into.
  singleSlug: env("SINGLE_SLUG", "iq6900-inscriptions"),
  siteBase: env("SITE_BASE", "https://iqlabs.dev").replace(/\/$/, ""),

  // A reservation holds an index for this long; the client re-arms it right
  // before inscribing (/reserve/touch). Slack past expiry before the reaper acts.
  reservationTtlSeconds: Number(env("RESERVATION_TTL_SECONDS", "600")),
  reaperSlackSeconds: Number(env("REAPER_SLACK_SECONDS", "60")),
  // A deposit transfer older than this is not accepted for a new reservation.
  depositMaxAgeSeconds: Number(env("DEPOSIT_MAX_AGE_SECONDS", "900")),

  reconcileMs: Number(env("RECONCILE_MS", "300000")),
  reaperMs: Number(env("REAPER_MS", "60000")),

  corsOrigin: env("CORS_ORIGIN", "*"),

  // Permanent image storage on Arweave via Irys, paid in SOL by the creator's
  // deploy flow (deploy-collection) or an ops key. Optional for the API process.
  arweaveKeypairPath: process.env.ARWEAVE_KEYPAIR ? repoPath(process.env.ARWEAVE_KEYPAIR) : "",
  irysDevnet: env("IRYS_DEVNET", "true") === "true",
  arweaveGateway: env("ARWEAVE_GATEWAY", "https://gateway.irys.xyz").replace(/\/$/, ""),

  maxOpenReservationsPerWallet: Number(env("MAX_OPEN_RESERVATIONS_PER_WALLET", "3")),
  reservePerIpPerMinute: Number(env("RESERVE_PER_IP_PER_MINUTE", "10")),
};
