import {test} from 'node:test';
import assert from 'node:assert/strict';
import {packCharge,PLATFORM_FEE_BPS,PLATFORM_TREASURY,readPool,addresses} from '../protocol.mjs';
import {Keypair,PublicKey} from '@solana/web3.js';

test('V5 prices mirror IQ 5 percent with exact per-ticket rounding',()=>{
 assert.equal(PLATFORM_FEE_BPS,500);
 assert.equal(PLATFORM_TREASURY.toBase58(),'EWNSTD8tikwqHMcRNuuNbZrnYJUiJdKq9UXLXSEU4wZ1');
 for(const [price,platformFee,totalPrice] of [[1,0,1],[19,0,19],[20,1,21],[21,1,22],[100000000,5000000,105000000]])assert.deepEqual(packCharge(price),{platformFee,totalPrice});
 assert.equal(packCharge(19).platformFee*32,0);
});
test('quotes reject malformed prices and unsafe total payments',()=>{
 for(const price of [0,-1,1.1,NaN,Infinity,'100',Number.MAX_SAFE_INTEGER])assert.throws(()=>packCharge(price));
});
test('new pool decoder cannot reinterpret an old fee-free pool',()=>{
 const data=Buffer.alloc(4352);data.write('NUBSALE4');data.writeBigUInt64LE(100000000n,200);
 assert.throws(()=>readPool(data),/Invalid paid pool/);
 data.write('NUBSALE5');const pool=readPool(data);assert.equal(pool.price,100000000);assert.equal(pool.platformFee,5000000);assert.equal(pool.totalPrice,105000000);
 const program=Keypair.generate().publicKey,collection=Keypair.generate().publicKey;
 const old=PublicKey.findProgramAddressSync([Buffer.from('sale-v4'),collection.toBuffer()],program)[0];
 assert.notEqual(addresses(program,collection).pool.toBase58(),old.toBase58());
});
