import { createHash, randomBytes } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { packWindowMessage } from "../../extensions/trait-packs/client/window-message.mjs";
import { createPackJobStore } from "./pack-jobs.ts";

const fault = (message: string, status = 400) =>
  Object.assign(Error(message), { status });
const digest = (message: string) =>
  createHash("sha256").update(message).digest("hex");
const key = (value: any) => {
  try {
    if (typeof value !== "string") throw Error();
    return new PublicKey(value).toBase58();
  } catch {
    throw fault("Invalid sale-window wallet or collection");
  }
};

// Explicit host configuration, not a public operator-discovery or funding API.
// The signed intent authenticates demand; the independent rolling24h market
// cap bounds operator rent even if many different wallets sign requests.
export function createPackWindowApi({
  db,
  origin,
  markets,
  runJobs,
  requestOrigins = [origin],
  now = Date.now,
}: {
  db: any;
  origin: string;
  markets: Map<
    string,
    { market: any; chain: string; program: string; maxWindowsPerDay: number }
  >;
  runJobs: () => Promise<any>;
  requestOrigins?: string[];
  now?: () => number;
}) {
  if (
    !Array.isArray(requestOrigins) ||
    !requestOrigins.length ||
    requestOrigins.length > 16
  )
    throw Error("Configure explicit sale-window request origins");
  for (const value of new Set([origin, ...requestOrigins])) {
    const canonical = new URL(value);
    if (
      canonical.origin !== value ||
      canonical.username ||
      canonical.password ||
      !(
        canonical.protocol === "https:" ||
        (canonical.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(canonical.hostname))
      )
    )
      throw Error("Configure canonical sale-window origins");
  }
  const allowedOrigins = new Set(requestOrigins);
  if (typeof runJobs !== "function" || markets.size > 32)
    throw Error("Configure the bounded registered operator runner");
  for (const [collection, entry] of markets) {
    if (
      key(collection) !== collection ||
      key(entry.program) !== entry.program ||
      !["solana:localnet", "solana:devnet", "solana:mainnet"].includes(
        entry.chain,
      ) ||
      !Number.isInteger(entry.maxWindowsPerDay) ||
      entry.maxWindowsPerDay < 1 ||
      entry.maxWindowsPerDay > 32 ||
      !entry.market.program?.equals(new PublicKey(entry.program)) ||
      !entry.market.collection?.equals(new PublicKey(collection)) ||
      typeof entry.market.requestSaleWindow !== "function"
    )
      throw Error(
        "Configure an explicit sale-window deployment and finite daily budget",
      );
  }
  createPackJobStore(db); // Reuse the incumbent job schema, never another job DB.
  db.exec(`CREATE TABLE IF NOT EXISTS pack_window_challenge (
   message_hash TEXT PRIMARY KEY, collection TEXT NOT NULL, owner TEXT NOT NULL,
   challenge_json TEXT NOT NULL, expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0
 );
 CREATE INDEX IF NOT EXISTS pack_window_challenge_expiry ON pack_window_challenge(expires_at);
 CREATE TABLE IF NOT EXISTS pack_window_demand (
   collection TEXT NOT NULL, epoch INTEGER NOT NULL, created_at INTEGER NOT NULL,
   execute_until INTEGER NOT NULL, program TEXT, chain TEXT, PRIMARY KEY(collection,epoch)
 );`);
  db.transaction(() => {
    const columns = new Set(
      db
        .query("PRAGMA table_info(pack_window_demand)")
        .all()
        .map((column: any) => column.name),
    );
    // Legacy rows remain NULL/unbound and cannot authorize a guessed deployment.
    if (!columns.has("program"))
      db.exec("ALTER TABLE pack_window_demand ADD COLUMN program TEXT");
    if (!columns.has("chain"))
      db.exec("ALTER TABLE pack_window_demand ADD COLUMN chain TEXT");
  }).immediate();
  function refreshDemands() {
    const at = now();
    for (const row of db
      .query(
        "SELECT collection,epoch,execute_until,program,chain FROM pack_window_demand WHERE execute_until>?1 ORDER BY created_at LIMIT 256",
      )
      .all(at)) {
      const entry = markets.get(row.collection);
      if (entry && row.program === entry.program && row.chain === entry.chain)
        entry.market.requestSaleWindow({
          epoch: row.epoch,
          until: row.execute_until,
        });
    }
  }
  function chargedEpochs(collection: string, at: number) {
    const charged = new Set<string>(),
      cutoff = at - 86400000;
    for (const row of db
      .query(
        "SELECT epoch FROM pack_window_demand WHERE collection=?1 AND created_at>=?2",
      )
      .all(collection, cutoff))
      charged.add(String(row.epoch));
    for (const row of db
      .query(
        `SELECT job_key FROM pack_operator_job WHERE market=?1 AND json_extract(task_json,'$.kind')='open'
    AND (created_at>=?2 OR updated_at>=?2 OR state NOT IN ('confirmed','failed'))`,
      )
      .all(collection, cutoff)) {
      const parts = row.job_key.split(":");
      charged.add(
        parts[0] === collection && /^\d+$/.test(parts[1]) && parts[2] === "open"
          ? parts[1]
          : "unknown:" + row.job_key,
      );
    }
    return charged;
  }
  async function handle(request: Request) {
    const url = new URL(request.url),
      match = /^\/packs\/([1-9A-HJ-NP-Za-km-z]{32,44})\/window$/.exec(
        url.pathname,
      );
    const send = (status: number, value: any) =>
      Response.json(value, {
        status,
        headers: {
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    if (!match) return send(404, { error: "Not found" });
    if (request.method !== "POST") return send(405, { error: "POST required" });
    const collection = match[1],
      entry = markets.get(collection);
    if (!entry)
      return send(404, { error: "Sale-window requests are not configured" });
    try {
      if (
        !allowedOrigins.has(request.headers.get("origin") ?? "") ||
        url.search ||
        request.headers.get("content-type")?.split(";")[0] !==
          "application/json"
      )
        throw fault("Same-origin JSON sale-window request required", 403);
      const reader = request.body?.getReader();
      if (!reader) throw fault("JSON body required");
      const parts = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 4096)
            throw fault("Sale-window request exceeds its bound", 413);
          parts.push(value);
        }
      } finally {
        await reader.cancel();
      }
      let body: any;
      try {
        body = JSON.parse(Buffer.concat(parts).toString("utf8"));
      } catch {
        throw fault("Invalid sale-window JSON");
      }
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).some(
          (field) => !["owner", "message", "signature"].includes(field),
        )
      )
        throw fault("Unexpected sale-window fields");
      const owner = key(body.owner),
        at = now();
      db.query("DELETE FROM pack_window_challenge WHERE expires_at<=?1").run(
        at,
      );
      if (body.message === undefined && body.signature === undefined) {
        const pending = db
          .query("SELECT COUNT(*) AS n FROM pack_window_challenge WHERE used=0")
          .get();
        const own = db
          .query(
            "SELECT COUNT(*) AS n FROM pack_window_challenge WHERE owner=?1 AND used=0",
          )
          .get(owner);
        if (pending.n >= 256 || own.n >= 4)
          throw fault("Too many pending sale-window challenges", 429);
        const challenge = {
            origin,
            chain: entry.chain,
            program: entry.program,
            collection,
            owner,
            nonce: randomBytes(32).toString("hex"),
            expiresAt: at + 30000,
          },
          message = packWindowMessage(challenge);
        db.query(
          "INSERT INTO pack_window_challenge(message_hash,collection,owner,challenge_json,expires_at) VALUES(?1,?2,?3,?4,?5)",
        ).run(
          digest(message),
          collection,
          owner,
          JSON.stringify(challenge),
          challenge.expiresAt,
        );
        return send(200, { challenge, message });
      }
      if (
        typeof body.message !== "string" ||
        body.message.length > 2048 ||
        typeof body.signature !== "string" ||
        !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(body.signature)
      )
        throw fault("Invalid signed sale-window intent");
      const row = db
        .query("SELECT * FROM pack_window_challenge WHERE message_hash=?1")
        .get(digest(body.message));
      if (
        !row ||
        row.used ||
        row.expires_at <= at ||
        row.owner !== owner ||
        row.collection !== collection
      )
        throw fault("Sale-window challenge expired or was already used", 409);
      const challenge = JSON.parse(row.challenge_json);
      if (
        challenge.origin !== origin ||
        challenge.chain !== entry.chain ||
        challenge.program !== entry.program ||
        packWindowMessage(challenge) !== body.message
      )
        throw fault("Sale-window challenge deployment changed", 409);
      let signature: Uint8Array;
      try {
        signature = bs58.decode(body.signature);
      } catch {
        throw fault("Invalid signed sale-window intent");
      }
      if (
        signature.length !== 64 ||
        !nacl.sign.detached.verify(
          new TextEncoder().encode(body.message),
          signature,
          new PublicKey(owner).toBytes(),
        )
      )
        throw fault("Sale-window wallet signature rejected", 403);
      const state = await entry.market.readState();
      if (
        state.pool.retired ||
        state.pool.definitions.reduce(
          (sum: number, trait: any) => sum + trait.remaining,
          0,
        ) < 4 ||
        ![5, 6].includes(state.epoch.status) ||
        (state.epoch.status === 5 &&
          state.epoch.tickets.some((ticket: any) => !ticket.refunded))
      )
        throw fault("This sale is not ready for another window", 409);
      db.transaction(() => {
        const current = db
          .query(
            "SELECT used,expires_at FROM pack_window_challenge WHERE message_hash=?1",
          )
          .get(digest(body.message));
        if (!current || current.used || current.expires_at <= now())
          throw fault("Sale-window challenge expired or was already used", 409);
        const previous = db
          .query(
            "SELECT program,chain FROM pack_window_demand WHERE collection=?1 AND epoch=?2",
          )
          .get(collection, state.epoch.id);
        if (
          previous &&
          (previous.program !== entry.program || previous.chain !== entry.chain)
        )
          throw fault(
            "Prior window intent belongs to another deployment; operator review required",
            409,
          );
        const charged = chargedEpochs(collection, now()),
          target = String(state.epoch.id);
        if (!charged.has(target) && charged.size >= entry.maxWindowsPerDay)
          throw fault(
            "The registered operator sale-window budget is exhausted",
            429,
          );
        if (
          db
            .query(
              "SELECT COUNT(*) AS n FROM pack_window_demand WHERE execute_until>?1",
            )
            .get(now()).n >= 256
        )
          throw fault("Sale-window execution queue is full", 429);
        const until = now() + 300000;
        const changed = db
          .query(
            `INSERT INTO pack_window_demand(collection,epoch,program,chain,created_at,execute_until) VALUES(?1,?2,?3,?4,?5,?6)
     ON CONFLICT(collection,epoch) DO UPDATE SET execute_until=excluded.execute_until,
     created_at=CASE WHEN pack_window_demand.created_at<?7 THEN excluded.created_at ELSE pack_window_demand.created_at END
     WHERE pack_window_demand.program=excluded.program AND pack_window_demand.chain=excluded.chain`,
          )
          .run(
            collection,
            state.epoch.id,
            entry.program,
            entry.chain,
            now(),
            until,
            now() - 86400000,
          ).changes;
        if (changed !== 1)
          throw fault(
            "Window demand deployment changed; operator review required",
            409,
          );
        db.query(
          "UPDATE pack_window_challenge SET used=1 WHERE message_hash=?1 AND used=0",
        ).run(digest(body.message));
      }).immediate();
      refreshDemands();
      // Acceptance is durable before the bounded worker pass. A temporary worker
      // failure does not erase intent or invite the wallet to sign it again.
      try {
        await runJobs();
      } catch {
        /* Durable intent remains queued for the existing worker. */
      }
      return send(200, { accepted: true });
    } catch (error: any) {
      const controlled =
        Number.isInteger(error?.status) &&
        error.status >= 400 &&
        error.status <= 599;
      return send(controlled ? error.status : 503, {
        error: controlled
          ? error.message
          : "Sale-window request is temporarily unavailable",
      });
    }
  }
  return { handle, refreshDemands };
}
