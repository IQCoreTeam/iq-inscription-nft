import { PublicKey, TransactionInstruction, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { Buffer } from 'buffer';
import { createNoopSigner } from '@solana/signers';
import {
  TENSOR_MARKETPLACE_PROGRAM_ADDRESS,
  LIST_STATE_DISCRIMINATOR,
  findListStatePda, findFeeVaultPda, getListStateDecoder,
  getListCoreInstructionAsync, getDelistCoreInstructionAsync, getBuyCoreInstructionAsync,
} from '@tensor-foundation/marketplace';
import { guardedTrade } from './transactions.mjs';

export const TENSOR_PROGRAM = new PublicKey(TENSOR_MARKETPLACE_PROGRAM_ADDRESS);

// Tensor's maintained SDK emits Kit instructions. The host wallet uses web3 v1;
// convert account roles/data once here. SDK noop signers only mark account roles:
// the existing Wallet Standard transaction flow supplies every real signature.
function walletInstruction(ix) {
  if (ix.programAddress !== TENSOR_PROGRAM.toBase58()) throw Error('Unexpected marketplace program');
  return new TransactionInstruction({
    programId: TENSOR_PROGRAM,
    keys: ix.accounts.map(({ address, role }) => {
      if (![0, 1, 2, 3].includes(role)) throw Error('Unknown account role');
      return { pubkey: new PublicKey(address), isWritable: (role & 1) !== 0, isSigner: (role & 2) !== 0 };
    }),
    data: Buffer.from(ix.data),
  });
}

// Discover only PDAs for assets the host already knows. No GPA scan, polling,
// new metadata fetch or separate clock RPC. Closed listings disappear naturally.
export async function readTensorListings(connection, assets) {
  if (!Array.isArray(assets) || assets.length > 64) throw Error('Read at most 64 known assets per page');
  const unique = [...new Set(assets.map(asset => new PublicKey(asset).toBase58()))];
  if (!unique.length) return [];
  const pdas = await Promise.all(unique.map(mint => findListStatePda({ mint })));
  const accounts = await connection.getMultipleAccountsInfo([...pdas.map(([address]) => new PublicKey(address)), SYSVAR_CLOCK_PUBKEY], 'confirmed');
  const clock = accounts.at(-1);
  if (!clock || clock.data.length < 40) throw Error('Missing chain clock');
  const now = Buffer.from(clock.data).readBigInt64LE(32), listings = [];
  for (let i = 0; i < unique.length; i++) {
    const account = accounts[i];
    if (!account) continue;
    if (!account.owner.equals(TENSOR_PROGRAM) || !Buffer.from(account.data).subarray(0, 8).equals(Buffer.from(LIST_STATE_DISCRIMINATOR)))
      throw Error('Invalid Tensor listing account');
    const state = getListStateDecoder().decode(account.data);
    if (state.assetId !== unique[i] || state.version !== 1 || state.amount <= 0n) throw Error('Invalid Tensor listing identity');
    const unsupported = state.currency.__option !== 'None' || state.privateTaker.__option !== 'None' || state.makerBroker.__option !== 'None' || state.cosigner !== null;
    listings.push({ address: pdas[i][0], asset: unique[i], seller: state.owner, price: state.amount, expiry: state.expiry,
      rentDestination: state.rentPayer ?? state.owner, expired: state.expiry > 0n && state.expiry <= now,
      supported: !unsupported });
  }
  return listings;
}

export async function tensorListingInstruction({ asset, collection, seller, price, expiresInSeconds }) {
  if (typeof price !== 'bigint' || price <= 0n || price > 0xffffffffffffffffn) throw Error('Set a positive exact lamport price');
  if (!Number.isSafeInteger(expiresInSeconds) || expiresInSeconds <= 0) throw Error('Set an explicit listing lifetime');
  const owner = createNoopSigner(new PublicKey(seller).toBase58());
  return walletInstruction(await getListCoreInstructionAsync({
    asset: new PublicKey(asset).toBase58(), collection: collection == null ? undefined : new PublicKey(collection).toBase58(), owner, payer: owner,
    amount: price, expireInSec: BigInt(expiresInSeconds),
  }));
}

export async function tensorCancelInstruction({ listing, collection, seller }) {
  const owner = createNoopSigner(new PublicKey(seller).toBase58());
  if (owner.address !== listing.seller) throw Error('Only the listing seller can cancel');
  const [expected] = await findListStatePda({ mint: listing.asset });
  if (expected !== listing.address) throw Error('Listing does not match the asset');
  return walletInstruction(await getDelistCoreInstructionAsync({ asset: listing.asset,
    collection: collection == null ? undefined : new PublicKey(collection).toBase58(), listState: listing.address, owner,
    rentDestination: new PublicKey(listing.rentDestination).toBase58(),
  }));
}

export async function tensorPurchaseInstructions({ listing, collection, buyer, creators, maximumAmount, outfit }) {
  if (!listing.supported || listing.expired) throw Error('This listing cannot be purchased with this SOL flow');
  if (typeof listing.price !== 'bigint' || listing.price <= 0n) throw Error('Invalid reviewed listing price');
  const [expected] = await findListStatePda({ mint: listing.asset });
  if (expected !== listing.address) throw Error('Listing does not match the asset');
  if (typeof maximumAmount !== 'bigint' || maximumAmount < listing.price || maximumAmount > 0xffffffffffffffffn) throw Error('Review the price plus Core royalties before purchasing');
  if (!Array.isArray(creators) || creators.length > 5) throw Error('Read the Core royalty creators before purchasing');
  const [feeVault] = await findFeeVaultPda({ address: listing.address });
  const payer = createNoopSigner(new PublicKey(buyer).toBase58());
  const ix = walletInstruction(await getBuyCoreInstructionAsync({ asset: listing.asset,
    collection: collection == null ? undefined : new PublicKey(collection).toBase58(), listState: listing.address, feeVault,
    owner: new PublicKey(listing.seller).toBase58(), buyer: payer.address, payer,
    rentDestination: new PublicKey(listing.rentDestination).toBase58(), maxAmount: maximumAmount,
    creators: creators.map(address => new PublicKey(address).toBase58()),
  }));
  if (!outfit) return [ix];
  if (new PublicKey(outfit.avatar).toBase58() !== listing.asset) throw Error('Outfit snapshot belongs to another NFT');
  return guardedTrade({ ...outfit, settlement: [ix] });
}
