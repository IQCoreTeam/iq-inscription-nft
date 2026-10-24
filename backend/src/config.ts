// Configuration, loaded once at boot. Everything comes from process env; the
// collections themselves live in SQLite (one backend serves many collections),
// so there is no per-deployment file like bible-nft had. Nothing here reaches a
// browser: the registrar key and the RPC credentials stay in this process.

import { readFileSync } from "node:fs";
import { dirname, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey } from "@solana/web3.js";
import { networkFor, type Cluster } from "./networks.ts";

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

// Pick the network preset once. Every cluster-coupled value (gateway, tensor,
// irys, explorer, the RPC default) derives from it, so they can never desync
// from CLUSTER. To retune a network, edit networks.ts, not this file or the env.
const cluster = env("CLUSTER", "devnet") as Cluster;
const net = networkFor(cluster);
// RPC is the one coupled value with a secret (mainnet Helius key), so it alone
// keeps an env override; empty/unset falls back to the preset's public default.
const rpcOverride = (process.env.RPC_URLS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export const config = {
  port: Number(env("PORT", "8787")),
  dbPath: repoPath(env("DB_PATH", "backend/.data/nft.sqlite")),
  cluster,
  programId: new PublicKey(idl.address as string),

  // The co-signer. Never the fee payer. File mode 0600, never in git.
  registrar: loadKeypair(env("REGISTRAR_KEYPAIR", "backend/.registrar.json")),

  // Primary first. Rotation walks the list on 429/5xx. Never a user-supplied
  // endpoint: a hostile RPC could return a doctored transaction and walk a fake
  // inscription past the verifier. Default from the preset; RPC_URLS overrides.
  rpcUrls: rpcOverride.length ? rpcOverride : net.rpcUrls,

  // Where the on-chain uri and the metadata image point (a cache over the chain)
  // and the cluster suffix for solscan external_url. Both from the preset so a
  // devnet mint never bakes a mainnet host. See networks.ts.
  gatewayBase: net.gatewayBase,
  explorerCluster: net.explorerCluster,
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

  // Comma-separated allowlist; "*" allows any origin. The launchpad is served
  // under both iqlabs.dev and iq6900.com, so both must be allowed.
  corsOrigins: env("CORS_ORIGIN", "*").split(",").map((s) => s.trim()).filter(Boolean),

  // Permanent image storage on Arweave via Irys, paid in SOL by the creator's
  // deploy flow (deploy-collection) or an ops key. Optional for the API process.
  arweaveKeypairPath: process.env.ARWEAVE_KEYPAIR ? repoPath(process.env.ARWEAVE_KEYPAIR) : "",
  // Irys bundler mode + image-bytes gateway, both from the preset (devnet vs mainnet).
  irysDevnet: net.irysDevnet,
  arweaveGateway: net.arweaveGateway,

  maxOpenReservationsPerWallet: Number(env("MAX_OPEN_RESERVATIONS_PER_WALLET", "3")),
  reservePerIpPerMinute: Number(env("RESERVE_PER_IP_PER_MINUTE", "10")),

  // Creator deploy fee, paid by the creator to the platform treasury inside the
  // deploy tx. Covers the Arweave upload the backend fronts (ops key) plus a
  // margin, so the platform is not out of pocket at scale. Placeholder amounts.
  deployFeeBase: Number(env("DEPLOY_FEE_BASE", "10000000")), // 0.01 SOL
  deployFeePerItem: Number(env("DEPLOY_FEE_PER_ITEM", "300000")), // 0.0003 SOL/item

  // Tensor secondary-market sales (read-only). The key is mainnet-scoped: the
  // devnet host rejects it, so the poller only runs on mainnet. Empty = off.
  // The base host is cluster-keyed in the preset.
  tensorApiKey: env("TENSOR_API_KEY", ""),
  tensorBase: net.tensorBase,
  tensorPollMs: Number(env("TENSOR_POLL_MS", "90000")),
};
