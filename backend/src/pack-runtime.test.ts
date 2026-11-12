import { test, expect, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getRpcUrl, setRpcUrl } from "@iqlabs-official/solana-sdk";
import nftIdl from "../../target/idl/iq_inscription_nft.json";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPackRuntime } from "./pack-runtime.ts";

async function fixture() {
  const previousReaderRpc = getRpcUrl();
  const db = new Database(":memory:"),
    root = await mkdtemp(path.join(tmpdir(), "native-pack-runtime-")),
    operator = Keypair.generate(),
    provider = new PublicKey("VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y"),
    treasury = Keypair.generate().publicKey;
  let genesis = "local-genesis",
    executable = true,
    fee = 100,
    rent = 500;
  const connection = {
    rpcEndpoint: "http://127.0.0.1:8899",
    getGenesisHash: async () => genesis,
    getMultipleAccountsInfo: async () => [{ executable }, { executable }],
    getMinimumBalanceForRentExemption: async (size: number, commitment: string) => {
      expect(size).toBe(749);
      expect(commitment).toBe("confirmed");
      return rent;
    },
  };
  setRpcUrl(connection.rpcEndpoint);
  const options = {
    db,
    connection,
    operator,
    program: Keypair.generate().publicKey,
    iqProgram: {
      programId: new PublicKey(nftIdl.address),
      provider: { connection },
    },
    vrf: {
      programId: provider,
      getNetworkState: async () => ({
        config: { treasury, requestFee: fee, fulfillmentAuthorities: [operator.publicKey] },
      }),
    },
    chain: "solana:localnet" as const,
    expectedGenesis: genesis,
    gateway: "http://127.0.0.1:4517",
    origin: "http://127.0.0.1:4518",
    stagingRoot: path.join(root, "staging"),
    renderRoot: path.join(root, "render"),
    providerTreasury: treasury.toBase58(),
    window: 400,
    timeout: 800,
    operationsReserveLamports: 148000000,
    requestFundingLamports: 1000,
    maxWindowsPerDay: 2,
  };
  return {
    options,
    setGenesis: (value: string) => (genesis = value),
    setExecutable: (value: boolean) => (executable = value),
    setFee: (value: number) => (fee = value),
    setRent: (value: number) => (rent = value),
    async close() {
      setRpcUrl(previousReaderRpc);
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
test("native runtime starts disabled for an empty confirmed-publication ledger without scanning Core or creating windows", async () => {
  const f = await fixture();
  try {
    const runtime = await createPackRuntime(f.options);
    expect(runtime.markets.size).toBe(0);
    expect(runtime.pages.size).toBe(0);
    expect(runtime.creator.listFinalized()).toEqual([]);
    expect(await runtime.sync()).toEqual([]);
    expect(await runtime.runJobs()).toEqual([]);
    expect(
      await runtime.viewForAsset(Keypair.generate().publicKey.toBase58()),
    ).toBe(null);
    expect(
      f.options.db.query("SELECT count(*) AS n FROM pack_operator_job").get(),
    ).toEqual({ n: 0 });
    await runtime.stop();
  } finally {
    await f.close();
  }
});

test("native startup preserves ordinary SDK configuration and rejects a different NFT program or registry cluster",async()=>{
 const f=await fixture();
 try{
  const rpc=getRpcUrl();
  await expect(createPackRuntime({...f.options,iqProgram:{...f.options.iqProgram,programId:Keypair.generate().publicKey}})).rejects.toThrow('incumbent backend IDL');
  expect(getRpcUrl()).toBe(rpc);
  await expect(createPackRuntime({...f.options,iqProgram:{...f.options.iqProgram,provider:{connection:{rpcEndpoint:'http://127.0.0.1:8898',getGenesisHash:async()=> 'another-chain'}}}})).rejects.toThrow('registry provider RPC chain mismatch');
  expect(getRpcUrl()).toBe(rpc);
  const runtime=await createPackRuntime(f.options);expect(getRpcUrl()).toBe(rpc);await runtime.stop();
 }finally{await f.close();}
});

test("a separately configured SDK endpoint must match the runtime cluster without being overwritten",async()=>{
 const f=await fixture();const check=spyOn(Connection.prototype,'getGenesisHash');
 try{
  const incumbent='http://127.0.0.1:8897';setRpcUrl(incumbent);
  check.mockResolvedValue('another-chain');
  await expect(createPackRuntime(f.options)).rejects.toThrow('SDK reader RPC chain mismatch');expect(getRpcUrl()).toBe(incumbent);
  check.mockResolvedValue('local-genesis');
  const runtime=await createPackRuntime(f.options);expect(getRpcUrl()).toBe(incumbent);await runtime.stop();
 }finally{check.mockRestore();await f.close();}
});
test("native startup rejects ambiguous origins, unsupported clusters, undeployed programs and wrong provider economics before enabling publication", async () => {
  const f = await fixture();
  try {
    for (const patch of [
      { origin: "https://api.example/path" },
      { origin: "https://user:secret@api.example" },
      { gateway: "https://gateway.example/" },
      { chain: "solana:unknown" },
      { maxWindowsPerDay: 0 },
    ])
      await expect(
        createPackRuntime({ ...f.options, ...patch } as any),
      ).rejects.toThrow();
    f.setGenesis("another-chain");
    await expect(createPackRuntime(f.options)).rejects.toThrow(
      "chain mismatch",
    );
    f.setGenesis("local-genesis");
    f.setExecutable(false);
    await expect(createPackRuntime(f.options)).rejects.toThrow("executable");
    f.setExecutable(true);
    f.setFee(600);
    await expect(createPackRuntime(f.options)).rejects.toThrow("fee and pending account rent");
    f.setRent(400);
    const runtime = await createPackRuntime(f.options);
    await runtime.stop();
  } finally {
    await f.close();
  }
});
