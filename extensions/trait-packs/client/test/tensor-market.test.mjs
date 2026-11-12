import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair,PublicKey} from '@solana/web3.js';
import {readTensorListings,tensorListingInstruction,tensorCancelInstruction,tensorPurchaseInstructions,TENSOR_PROGRAM} from '../tensor-market.mjs';
const owner=Keypair.generate().publicKey,asset=Keypair.generate().publicKey,collection=Keypair.generate().publicKey;
test('listing instruction requires exact price/expiry and marks the wallet signer without signing',async()=>{
  for(const price of [1,-1n,0n,2n**64n])await assert.rejects(()=>tensorListingInstruction({asset,collection,seller:owner,price,expiresInSeconds:3600}),/price/);
  await assert.rejects(()=>tensorListingInstruction({asset,collection,seller:owner,price:1n,expiresInSeconds:0}),/lifetime/);
  const ix=await tensorListingInstruction({asset,collection,seller:owner,price:10000000n,expiresInSeconds:3600});
  assert(ix.programId.equals(TENSOR_PROGRAM));assert(ix.keys.some(k=>k.pubkey.equals(owner)&&k.isSigner));assert(ix.keys.some(k=>k.pubkey.equals(asset)&&k.isWritable));
});
test('known-asset discovery is bounded and deduplicates addresses in one batched clock/listing read',async()=>{
  let calls=0;const connection={getMultipleAccountsInfo:async keys=>{calls++;assert.equal(keys.length,2);const clock=Buffer.alloc(40);clock.writeBigInt64LE(100n,32);return[null,{data:clock}];}};
  assert.deepEqual(await readTensorListings(connection,[]),[]);assert.equal(calls,0);
  assert.deepEqual(await readTensorListings(connection,[asset,asset.toBase58()]),[]);assert.equal(calls,1);
  await assert.rejects(()=>readTensorListings(connection,Array(65).fill(asset)),/64/);assert.equal(calls,1);
  const invalid={getMultipleAccountsInfo:async()=>[{owner:PublicKey.default,data:Buffer.alloc(100)},{data:Buffer.alloc(40)}]};
  await assert.rejects(()=>readTensorListings(invalid,[asset]),/listing account/);
});
test('unsupported markets and seller mismatches reject before wallet interaction',async()=>{
  await assert.rejects(()=>tensorPurchaseInstructions({listing:{supported:false,expired:false}}),/cannot be purchased/);
  await assert.rejects(()=>tensorPurchaseInstructions({listing:{supported:true,expired:true}}),/cannot be purchased/);
  await assert.rejects(()=>tensorCancelInstruction({listing:{seller:asset.toBase58()},seller:owner,collection}),/seller/);
});
