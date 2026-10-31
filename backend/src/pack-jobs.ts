import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { nextEpochTask } from "../../extensions/trait-packs/operator/epoch-task.mjs";
import { recoverOperatorTransaction } from "../../extensions/trait-packs/operator/recovery.mjs";

type Task = {
  kind: string;
  ticket?: number;
  pull?: number;
  cursor?: number;
  limit?: number;
};
type Checkpoint = {
  state: string;
  signature: string;
  signedTransaction: string;
  blockhash: string;
  lastValidBlockHeight: number;
  error?: unknown;
  confirmedSlot?: number;
};
type Lease = { market: string; owner: string; token: string; until: number };
type Job = { key: string; market: string; task: Task; checkpoint: Checkpoint };

// Uses the existing backend SQLite connection and lifecycle. Signed transaction
// bytes are operator-only data; this table must never be returned by public APIs.
export function createPackJobStore(db: Database, now = Date.now) {
  db.exec(`CREATE TABLE IF NOT EXISTS pack_operator_lease (
    market TEXT PRIMARY KEY, owner TEXT NOT NULL, token TEXT NOT NULL,
    lease_until INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pack_operator_job (
    job_key TEXT PRIMARY KEY, market TEXT NOT NULL, task_json TEXT NOT NULL,
    checkpoint_json TEXT NOT NULL, signature TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS pack_operator_pending_idx ON pack_operator_job(market,state,created_at);
  CREATE UNIQUE INDEX IF NOT EXISTS pack_operator_one_pending_market ON pack_operator_job(market)
    WHERE state NOT IN ('confirmed','failed');`);
  const leaseRow = db.query<
    { owner: string; token: string; lease_until: number },
    [string]
  >("SELECT owner,token,lease_until FROM pack_operator_lease WHERE market=?");
  function requireLease(lease: Lease) {
    const row = leaseRow.get(lease.market);
    if (
      !row ||
      row.owner !== lease.owner ||
      row.token !== lease.token ||
      row.lease_until <= now()
    )
      throw Error("Pack operator lease was lost; do not broadcast");
  }
  const decode = (row: any): Job | null =>
    row
      ? {
          key: row.job_key,
          market: row.market,
          task: JSON.parse(row.task_json),
          checkpoint: JSON.parse(row.checkpoint_json),
        }
      : null;
  return {
    acquire(market: string, owner: string, ttlMs: number): Lease | null {
      if (
        !market ||
        !owner ||
        !Number.isSafeInteger(ttlMs) ||
        ttlMs < 1000 ||
        ttlMs > 120000
      )
        throw Error("Invalid pack operator lease");
      const at = now(),
        token = randomUUID(),
        until = at + ttlMs;
      const result = db
        .query(
          `INSERT INTO pack_operator_lease(market,owner,token,lease_until)
        VALUES (?1,?2,?3,?4) ON CONFLICT(market) DO UPDATE SET
        owner=excluded.owner,token=excluded.token,lease_until=excluded.lease_until
        WHERE pack_operator_lease.lease_until <= ?5`,
        )
        .run(market, owner, token, until, at);
      return result.changes === 1 ? { market, owner, token, until } : null;
    },
    release(lease: Lease) {
      db.query(
        "DELETE FROM pack_operator_lease WHERE market=? AND owner=? AND token=?",
      ).run(lease.market, lease.owner, lease.token);
    },
    confirmedSlot(market: string) {
      const row=db.query<{slot:number|null},[string]>("SELECT MAX(CAST(json_extract(checkpoint_json,'$.confirmedSlot') AS INTEGER)) AS slot FROM pack_operator_job WHERE market=? AND state='confirmed'").get(market);
      const slot=row?.slot;
      return slot!==null&&slot!==undefined&&Number.isSafeInteger(slot)&&slot>=0?slot:0;
    },
    get(key: string) {
      return decode(
        db.query("SELECT * FROM pack_operator_job WHERE job_key=?").get(key),
      );
    },
    pending(market: string) {
      return decode(
        db
          .query(
            `SELECT * FROM pack_operator_job WHERE market=?
        AND state NOT IN ('confirmed','failed') ORDER BY created_at,job_key LIMIT 1`,
          )
          .get(market),
      );
    },
    prepare(lease: Lease, job: Job, ttlMs: number) {
      db.transaction(() => {
        requireLease(lease);
        if (job.market !== lease.market)
          throw Error("Pack job belongs to another market");
        const at = now();
        db.query(
          `INSERT INTO pack_operator_job(job_key,market,task_json,checkpoint_json,signature,state,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?)`,
        ).run(
          job.key,
          job.market,
          JSON.stringify(job.task),
          JSON.stringify(job.checkpoint),
          job.checkpoint.signature,
          job.checkpoint.state,
          at,
          at,
        );
        db.query(
          "UPDATE pack_operator_lease SET lease_until=? WHERE market=? AND token=?",
        ).run(at + ttlMs, lease.market, lease.token);
      }).immediate();
    },
    save(lease: Lease, job: Job, checkpoint: Checkpoint, ttlMs: number) {
      db.transaction(() => {
        requireLease(lease);
        const at = now();
        const result = db
          .query(
            `UPDATE pack_operator_job SET checkpoint_json=?,state=?,updated_at=?
          WHERE job_key=? AND market=? AND signature=?`,
          )
          .run(
            JSON.stringify(checkpoint),
            checkpoint.state,
            at,
            job.key,
            lease.market,
            checkpoint.signature,
          );
        if (result.changes !== 1)
          throw Error("Pack operator checkpoint identity changed");
        db.query(
          "UPDATE pack_operator_lease SET lease_until=? WHERE market=? AND token=?",
        ).run(at + ttlMs, lease.market, lease.token);
      }).immediate();
    },
  };
}

export type PackMarket = {
  connection: any;
  expectedGenesis: string;
  // Must validate program ownership, registry, provider/network treasury and
  // contextual slots before handing state to the bounded decision function.
  readState(minContextSlot?: number): Promise<any>;
  // Build/simulate/sign only the selected task using the existing operator key.
  // Never broadcast here. Return signed bytes; no secret key fields are accepted.
  buildSigned(task: Task, state: any): Promise<Checkpoint>;
};

// Explicitly configured markets only, at most one action each. The existing
// backend's job scheduler calls this; it creates no interval or public service.
export async function runPackJobs({
  store,
  markets,
  workerId,
  leaseMs = 30000,
  limit = 8,
}: {
  store: ReturnType<typeof createPackJobStore>;
  markets: Map<string, PackMarket>;
  workerId: string;
  leaseMs?: number;
  limit?: number;
  balance?: number;
  slot?: number;
}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 32)
    throw Error("Invalid pack job batch limit");
  const report: Array<{
    market: string;
    state: string;
    kind?: string;
    signature?: string;
  }> = [];
  const batch = [...markets].slice(0, limit);
  // The host retains this allowlist between ticks. Rotate even idle or leased
  // entries so they cannot permanently hide paid work in later collections.
  // Do this before the first await so concurrent passes select the next batch.
  for (const [marketId, market] of batch) {
    markets.delete(marketId);
    markets.set(marketId, market);
  }
  for (const [marketId, market] of batch) {
    const lease = store.acquire(marketId, workerId, leaseMs);
    if (!lease) {
      report.push({ market: marketId, state: "leased" });
      continue;
    }
    let job: Job | null = null;
    try {
      if ((await market.connection.getGenesisHash()) !== market.expectedGenesis)
        throw Error("Pack operator RPC chain mismatch");
      // Pending identity takes precedence over selecting/signing another action.
      job = store.pending(marketId);
      if (!job) {
        const state = await market.readState(store.confirmedSlot(marketId)),
          task = nextEpochTask(state) as Task | null;
        if (!task) {
          report.push({ market: marketId, state: "idle" });
          continue;
        }
        const key = [
          marketId,
          state.epoch.id,
          task.kind,
          task.ticket ?? "",
          task.pull ?? "",
          task.cursor ?? "",
          ...(task.kind === "sweep" ? [task.balance,task.slot] : []),
        ].join(":");
        const previous = store.get(key);
        if (previous) {
          report.push({
            market: marketId,
            state:
              previous.checkpoint.state === "confirmed"
                ? "awaiting-chain-state"
                : "failed",
            kind: task.kind,
          });
          continue;
        }
        const signed = await market.buildSigned(task, state);
        const checkpoint: Checkpoint = {
          state: "prepared",
          signature: signed.signature,
          signedTransaction: signed.signedTransaction,
          blockhash: signed.blockhash,
          lastValidBlockHeight: signed.lastValidBlockHeight,
        };
        const prepared = { key, market: marketId, task, checkpoint };
        store.prepare(lease, prepared, leaseMs);
        job = prepared; // Durable before recovery can broadcast.
      }
      const active = job;
      const checkpoint = await recoverOperatorTransaction({
        connection: market.connection,
        expectedGenesis: market.expectedGenesis,
        job: active.checkpoint,
        save: (value: Checkpoint) => store.save(lease, active, value, leaseMs),
      });
      report.push({
        market: marketId,
        state: checkpoint.state,
        kind: job.task.kind,
        signature: checkpoint.signature,
      });
    } catch {
      // A transient/read/sign failure never erases a prepared signed identity.
      report.push({
        market: marketId,
        state: job ? "unresolved" : "unavailable",
        kind: job?.task.kind,
        signature: job?.checkpoint.signature,
      });
    } finally {
      store.release(lease);
    }
  }
  return report;
}
