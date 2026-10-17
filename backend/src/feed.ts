// The iq6900 global feed's on-chain identity, same labels as the site's
// assets/js/codein/feed.js, so collection rows written here show up on the
// site's board and item inscriptions land in the same table the site reads.

import { contract, utils } from "@iqlabs-official/solana-sdk";
import type { PublicKey } from "@solana/web3.js";

export const DB_ROOT_LABEL = "iq6900-codein-feed-v1";
export const FEED_LABEL = "global-feed";
export const codeInProgramId = contract.createInstructionBuilder().programId;
export const dbRootSeed = utils.toSeedBytes(DB_ROOT_LABEL);
export const feedSeed = utils.toSeedBytes(FEED_LABEL);
export const userInventoryPda = (user: PublicKey) => contract.getUserInventoryPda(user, codeInProgramId);
