// Permanent image storage on Arweave via Irys, paid in SOL by the configured
// keypair (the creator's deploy flow or an ops key). Uploads are tiny (~0.00006
// SOL per 115 KB), so a whole collection costs a fraction of a SOL.

import { Uploader } from "@irys/upload";
import { Solana } from "@irys/upload-solana";
import { readFileSync } from "node:fs";
import { config } from "./config.ts";

let irysPromise: Promise<any> | null = null;

async function getIrys(): Promise<any> {
  if (!config.arweaveKeypairPath) throw new Error("ARWEAVE_KEYPAIR is not set");
  if (!irysPromise) {
    const secret = Uint8Array.from(JSON.parse(readFileSync(config.arweaveKeypairPath, "utf8")));
    let builder = Uploader(Solana).withWallet(secret);
    if (config.rpcUrls[0]) builder = builder.withRpc(config.rpcUrls[0]);
    if (config.irysDevnet) builder = builder.devnet();
    irysPromise = builder;
  }
  return irysPromise;
}

// Keep the Irys funding step serialized: a collection stages its images with
// several uploads in flight at once, and without this every concurrent upload
// that saw a short balance would fire its own fund tx. Fund a generous buffer
// (~200 images' worth) so funding runs a handful of times, not once per image.
let fundLock: Promise<void> = Promise.resolve();
async function ensureFunded(irys: any, price: any): Promise<void> {
  const run = fundLock.then(async () => {
    const balance = await irys.getLoadedBalance();
    if (balance.isLessThan(price)) await irys.fund(price.multipliedBy(200));
  });
  fundLock = run.catch(() => {});
  await run;
}

// Upload bytes permanently and return the Arweave id. Safe to call concurrently;
// funding is serialized and the upload itself is independent per call.
export async function uploadToArweave(bytes: Buffer, contentType: string): Promise<string> {
  const irys = await getIrys();
  const price = await irys.getPrice(bytes.length);
  await ensureFunded(irys, price);
  const receipt = await irys.upload(bytes, { tags: [{ name: "Content-Type", value: contentType }] });
  return receipt.id as string;
}
