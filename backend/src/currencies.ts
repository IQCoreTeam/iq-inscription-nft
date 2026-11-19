// The mints a collection may price its mint in, besides native SOL. The program
// accepts any mint as the registry `currency`; this list is what the backend
// exposes and displays (symbol, decimals, issuer) and the token program its ATAs
// use. transfer_checked reads decimals from the mint on chain, so the decimals
// here are display-only. On devnet any valid mint is allowed (test flexibility);
// on mainnet only SOL + the known list, so a typo can never become the price.

import { PublicKey } from "@solana/web3.js";
import { config } from "./config.ts";

export const TOKEN_2022_PROGRAM = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ASSOCIATED_TOKEN_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
// The registry stores Pubkey::default() (all ones in base58) to mean native SOL.
export const SOL_SENTINEL = PublicKey.default.toBase58();

export type CurrencyInfo = { mint: string; symbol: string; decimals: number; issuer: string };

// Tokenized stocks on Solana (Backpack Securities via Sunrise, and xStocks). All
// Token-2022. Verified mints; see the tensor-tx-api memory.
const LIST: CurrencyInfo[] = [
  { mint: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh", symbol: "NVDAx", decimals: 8, issuer: "xStocks" },
  { mint: "NVDAVuiB7hwd3m5Wa1JuHNovPaPG6BH1QNztbKFxNjv", symbol: "NVDA", decimals: 6, issuer: "Backpack Securities" },
  { mint: "BLKKYfF41c6xRPrtX1rdYbxLE1xxEdZUnxQsB5hcZ8Nf", symbol: "BLK", decimals: 6, issuer: "Backpack Securities" },
  { mint: "SPYBo66VJPFjh1pXMb9Le53kDYWTK1zzYVDeVRWtsbi", symbol: "SPY", decimals: 6, issuer: "Backpack Securities" },
];
const byMint = new Map(LIST.map((c) => [c.mint, c]));

export const SOL_INFO: CurrencyInfo = { mint: "SOL", symbol: "SOL", decimals: 9, issuer: "" };

// Is this currency native SOL? ("SOL", empty, or the default-pubkey sentinel.)
export const isSol = (mint: string | null | undefined): boolean =>
  !mint || mint === "SOL" || mint === SOL_SENTINEL;

export function currencyList(): CurrencyInfo[] {
  return LIST;
}

// Display info for a stored currency mint. SOL for the native case; the known
// entry for a listed mint; a generic entry (symbol = short mint) otherwise, so
// an unknown-but-valid devnet mint still renders.
export function currencyInfo(mint: string | null | undefined): CurrencyInfo {
  if (isSol(mint)) return SOL_INFO;
  return byMint.get(mint!) ?? { mint: mint!, symbol: mint!.slice(0, 4), decimals: 0, issuer: "" };
}

// What a creator or trader may use. SOL is always allowed. A non-SOL currency
// needs `stocks` (geo.ts stockAllowed for this request: the switch and the
// caller's country); then the known mints on mainnet and any valid mint on
// devnet (for tests).
export function isAllowedCurrency(mint: string, stocks: boolean): boolean {
  if (isSol(mint)) return true;
  if (!stocks) return false;
  if (byMint.has(mint)) return true;
  if (config.cluster !== "mainnet") {
    try { new PublicKey(mint); return true; } catch { return false; }
  }
  return false;
}

// All target stock tokens are Token-2022; a mint not in the list (devnet test)
// is also created as Token-2022. Classic SPL is not a target, so default 2022.
export function tokenProgramFor(_mint: string): PublicKey {
  return TOKEN_2022_PROGRAM;
}

// The associated token account for an owner + mint under a token program.
// Hand-derived so the backend needs no @solana/spl-token dependency.
export function ataFor(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM
  )[0];
}
