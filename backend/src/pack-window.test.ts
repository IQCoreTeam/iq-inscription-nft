import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { createPackWindowApi } from "./pack-window.ts";
import { packWindowMessage } from "../../extensions/trait-packs/client/window-message.mjs";
function fixture() {
  const db = new Database(":memory:"),
    origin = "http://127.0.0.1:4568",
    collection = Keypair.generate().publicKey,
    program = Keypair.generate().publicKey,
    owner = Keypair.generate(),
    demands: any[] = [];
  let clock = 1000000,
    runs = 0,
    epoch = 0;
  const market = {
    program,
    collection,
    requestSaleWindow: (value: any) => demands.push(value),
    readState: async () => ({
      pool: { retired: false, definitions: [{ remaining: 80 }] },
      epoch: { id: epoch, status: 6, tickets: [] },
      slot: 1,
    }),
  };
  const markets = new Map([
      [
        collection.toBase58(),
        {
          market,
          chain: "solana:localnet",
          program: program.toBase58(),
          maxWindowsPerDay: 1,
        },
      ],
    ]),
    options = {
      db,
      origin,
      markets,
      runJobs: async () => {
        runs++;
      },
      now: () => clock,
    };
  const request = (
    body: any,
    api = createPackWindowApi(options),
    headers: any = {},
  ) =>
    api.handle(
      new Request(origin + "/packs/" + collection.toBase58() + "/window", {
        method: "POST",
        headers: { origin, "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
    );
  const sign = (message: string, key = owner) =>
    bs58.encode(
      nacl.sign.detached(new TextEncoder().encode(message), key.secretKey),
    );
  return {
    db,
    origin,
    collection,
    program,
    owner,
    demands,
    market,
    markets,
    options,
    request,
    sign,
    setClock(value: number) {
      clock = value;
    },
    setEpoch(value: number) {
      epoch = value;
    },
    get runs() {
      return runs;
    },
  };
}
test("signed one-use intent reserves a hard budget, survives API restart, and triggers only bounded work", async () => {
  const f = fixture();
  try {
    const api = createPackWindowApi(f.options);
    let response = await f.request(
      { owner: f.owner.publicKey.toBase58() },
      api,
    );
    expect(response.status).toBe(200);
    const issued = await response.json();
    expect(issued.message).toBe(packWindowMessage(issued.challenge));
    expect(issued.challenge.program).toBe(f.program.toBase58());
    expect(f.demands).toHaveLength(0);
    const body = {
      owner: f.owner.publicKey.toBase58(),
      message: issued.message,
      signature: f.sign(issued.message),
    };
    const results = await Promise.all([
      f.request(body, api),
      f.request(body, api),
    ]);
    expect(results.map((row) => row.status).sort()).toEqual([200, 409]);
    expect(f.runs).toBe(1);
    expect(
      f.db.query("SELECT COUNT(*) AS n FROM pack_window_demand").get().n,
    ).toBe(1);
    f.setClock(1060000);
    const restarted = createPackWindowApi(f.options);
    restarted.refreshDemands();
    expect(f.demands.at(-1)).toEqual({ epoch: 0, until: 1300000 });
    expect(
      f.db.query("SELECT used FROM pack_window_challenge").get().used,
    ).toBe(1);
  } finally {
    f.db.close();
  }
});
test("wrong signer, expiry, origin or GET cannot authorize operator rent", async () => {
  const f = fixture();
  try {
    const api = createPackWindowApi(f.options),
      owner = f.owner.publicKey.toBase58();
    const issued = await (await f.request({ owner }, api)).json();
    expect(
      (
        await f.request(
          {
            owner,
            message: issued.message,
            signature: f.sign(issued.message, Keypair.generate()),
          },
          api,
        )
      ).status,
    ).toBe(403);
    expect(
      (await f.request({ owner }, api, { origin: "https://evil.example" }))
        .status,
    ).toBe(403);
    expect(
      (
        await api.handle(
          new Request(
            f.origin + "/packs/" + f.collection.toBase58() + "/window",
          ),
        )
      ).status,
    ).toBe(405);
    f.setClock(1030001);
    expect(
      (
        await f.request(
          { owner, message: issued.message, signature: f.sign(issued.message) },
          api,
        )
      ).status,
    ).toBe(409);
    expect(f.demands).toHaveLength(0);
    expect(f.runs).toBe(0);
  } finally {
    f.db.close();
  }
});
test("prepared signed open jobs remain in the cap even after a date boundary", async () => {
  const f = fixture();
  try {
    const api = createPackWindowApi(f.options),
      collection = f.collection.toBase58();
    f.db
      .query(
        "INSERT INTO pack_operator_job(job_key,market,task_json,checkpoint_json,signature,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        collection + ":0:open:::",
        collection,
        JSON.stringify({ kind: "open" }),
        "{}",
        "prepared-signature",
        "prepared",
        1000000,
        1000000,
      );
    f.setEpoch(1);
    f.setClock(1000000 + 86400001);
    let issued = await (
      await f.request({ owner: f.owner.publicKey.toBase58() }, api)
    ).json();
    expect(
      (
        await f.request(
          {
            owner: f.owner.publicKey.toBase58(),
            message: issued.message,
            signature: f.sign(issued.message),
          },
          api,
        )
      ).status,
    ).toBe(429);
    expect(f.runs).toBe(0);
    f.db.query("UPDATE pack_operator_job SET state='confirmed'").run();
    issued = await (
      await f.request({ owner: f.owner.publicKey.toBase58() }, api)
    ).json();
    expect(
      (
        await f.request(
          {
            owner: f.owner.publicKey.toBase58(),
            message: issued.message,
            signature: f.sign(issued.message),
          },
          api,
        )
      ).status,
    ).toBe(200);
  } finally {
    f.db.close();
  }
});
test("concurrent different valid intents cannot exceed one configured market window", async () => {
  const f = fixture();
  try {
    const api = createPackWindowApi(f.options),
      other = Keypair.generate(),
      first = await (
        await f.request({ owner: f.owner.publicKey.toBase58() }, api)
      ).json(),
      second = await (
        await f.request({ owner: other.publicKey.toBase58() }, api)
      ).json();
    let epoch = 0;
    f.market.readState = async () => ({
      pool: { retired: false, definitions: [{ remaining: 80 }] },
      epoch: { id: epoch++, status: 6, tickets: [] },
      slot: 1,
    });
    const results = await Promise.all([
      f.request(
        {
          owner: f.owner.publicKey.toBase58(),
          message: first.message,
          signature: f.sign(first.message),
        },
        api,
      ),
      f.request(
        {
          owner: other.publicKey.toBase58(),
          message: second.message,
          signature: f.sign(second.message, other),
        },
        api,
      ),
    ]);
    expect(results.map((row) => row.status).sort()).toEqual([200, 429]);
    expect(
      f.db.query("SELECT COUNT(*) AS n FROM pack_window_demand").get().n,
    ).toBe(1);
  } finally {
    f.db.close();
  }
});
test("accepted intent is durable when the immediate operator pass is unavailable", async () => {
  const f = fixture();
  try {
    const options = {
        ...f.options,
        runJobs: async () => {
          throw Error("temporary unavailable");
        },
      },
      api = createPackWindowApi(options),
      owner = f.owner.publicKey.toBase58(),
      issued = await (await f.request({ owner }, api)).json();
    expect(
      (
        await f.request(
          { owner, message: issued.message, signature: f.sign(issued.message) },
          api,
        )
      ).status,
    ).toBe(200);
    f.demands.length = 0;
    createPackWindowApi(options).refreshDemands();
    expect(f.demands.at(-1).epoch).toBe(0);
  } finally {
    f.db.close();
  }
});

test("an explicit frontend origin can request the canonical API challenge without reflection", async () => {
  const f = fixture();
  try {
    const frontend = "https://iqlabs.dev",
      api = createPackWindowApi({ ...f.options, requestOrigins: [frontend] }),
      owner = f.owner.publicKey.toBase58();
    const allowed = await f.request({ owner }, api, { origin: frontend });
    expect(allowed.status).toBe(200);
    const issued = await allowed.json();
    expect(issued.challenge.origin).toBe(f.origin);
    expect(
      (
        await f.request(
          { owner, message: issued.message, signature: f.sign(issued.message) },
          api,
          { origin: frontend },
        )
      ).status,
    ).toBe(200);
    expect(
      (await f.request({ owner }, api, { origin: "https://unlisted.example" }))
        .status,
    ).toBe(403);
    expect(() =>
      createPackWindowApi({ ...f.options, requestOrigins: ["*"] }),
    ).toThrow();
  } finally {
    f.db.close();
  }
});

test("accepted demand is not replayed after a program or chain configuration swap", async () => {
  for (const field of ["program", "chain"]) {
    const f = fixture();
    try {
      const api = createPackWindowApi(f.options),
        owner = f.owner.publicKey.toBase58(),
        issued = await (await f.request({ owner }, api)).json();
      expect(
        (
          await f.request(
            {
              owner,
              message: issued.message,
              signature: f.sign(issued.message),
            },
            api,
          )
        ).status,
      ).toBe(200);
      f.demands.length = 0;
      const changed = { ...f.markets.get(f.collection.toBase58())! };
      if (field === "program") {
        const next = Keypair.generate().publicKey;
        changed.program = next.toBase58();
        changed.market = { ...f.market, program: next };
      } else changed.chain = "solana:devnet";
      f.markets.set(f.collection.toBase58(), changed);
      const restarted = createPackWindowApi(f.options);
      restarted.refreshDemands();
      expect(f.demands).toHaveLength(0);
      const fresh = await (await f.request({ owner }, restarted)).json();
      const response = await f.request(
        { owner, message: fresh.message, signature: f.sign(fresh.message) },
        restarted,
      );
      expect(response.status).toBe(409);
      expect((await response.json()).error).toMatch(/another deployment/);
      expect(f.demands).toHaveLength(0);
    } finally {
      f.db.close();
    }
  }
});

test("legacy durable demand rows remain unbound instead of guessing current authority", async () => {
  const f = fixture();
  try {
    f.db.exec(
      "CREATE TABLE pack_window_demand(collection TEXT NOT NULL,epoch INTEGER NOT NULL,created_at INTEGER NOT NULL,execute_until INTEGER NOT NULL,PRIMARY KEY(collection,epoch))",
    );
    f.db
      .query("INSERT INTO pack_window_demand VALUES(?,?,?,?)")
      .run(f.collection.toBase58(), 0, 1000000, 1300000);
    const api = createPackWindowApi(f.options);
    api.refreshDemands();
    expect(f.demands).toHaveLength(0);
    const row = f.db
      .query("SELECT program,chain FROM pack_window_demand")
      .get();
    expect(row).toEqual({ program: null, chain: null });
    const owner = f.owner.publicKey.toBase58(),
      issued = await (await f.request({ owner }, api)).json();
    expect(
      (
        await f.request(
          { owner, message: issued.message, signature: f.sign(issued.message) },
          api,
        )
      ).status,
    ).toBe(409);
    expect(f.demands).toHaveLength(0);
  } finally {
    f.db.close();
  }
});
