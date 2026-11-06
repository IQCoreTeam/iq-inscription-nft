import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { assertConnectionChain } from "../../extensions/trait-packs/client/transactions.mjs";
import { config } from "./config.ts";
import { program } from "./program.ts";
import type { createPackRuntime } from "./pack-runtime.ts";

export async function configuredPackRuntime(): Promise<
  Omit<Parameters<typeof createPackRuntime>[0], "db"> | undefined
> {
  const settingsPath = process.env.PACK_RUNTIME_CONFIG;
  if (!settingsPath) return;
  const operatorPath = process.env.PACK_OPERATOR_KEYPAIR;
  if (!isAbsolute(settingsPath) || !operatorPath || !isAbsolute(operatorPath))
    throw Error("Pack runtime requires absolute paths for config and operator keypair");

  const settings = JSON.parse(await readFile(settingsPath, "utf8"));
  const { origin, requestOrigins, stagingRoot, renderRoot, window, timeout,
    operationsReserveLamports, requestFundingLamports, maxWindowsPerDay } = settings;
  if (
    typeof origin !== "string" ||
    !Array.isArray(requestOrigins) || !requestOrigins.length ||
    requestOrigins.some((value) => {
      if (typeof value !== "string") return true;
      const url = new URL(value);
      return url.protocol !== "https:" || url.origin !== value;
    }) ||
    typeof stagingRoot !== "string" || !isAbsolute(stagingRoot) ||
    typeof renderRoot !== "string" || !isAbsolute(renderRoot)
  )
    throw Error("Pack runtime requires explicit HTTPS browser origins and absolute storage paths");

  const packProgram = new PublicKey(settings.program);
  const providerTreasury = new PublicKey(settings.providerTreasury).toBase58();
  const secret = JSON.parse(await readFile(operatorPath, "utf8"));
  if (!Array.isArray(secret) || secret.length !== 64 ||
      secret.some((value) => !Number.isInteger(value) || value < 0 || value > 255))
    throw Error("Invalid pack operator keypair file");
  const operator = Keypair.fromSecretKey(Uint8Array.from(secret));
  if (operator.publicKey.equals(config.registrar.publicKey))
    throw Error("The pack operator must be separate from the NFT registrar");

  const connection = program.provider.connection;
  const chain = `solana:${config.cluster}` as const;
  const expectedGenesis = await assertConnectionChain(connection, chain);
  const { Orao } = await import("@orao-network/solana-vrf");
  const vrf = new Orao(new AnchorProvider(connection, new Wallet(operator), {
    commitment: "confirmed",
  }));
  return {
    connection, iqProgram: program, program: packProgram, operator, vrf, chain,
    expectedGenesis, gateway: config.gatewayBase, origin, requestOrigins,
    stagingRoot, renderRoot, providerTreasury, window, timeout,
    operationsReserveLamports, requestFundingLamports, maxWindowsPerDay,
  };
}
