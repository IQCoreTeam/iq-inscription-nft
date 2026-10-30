import {test} from 'node:test';import assert from 'node:assert/strict';import {Keypair} from '@solana/web3.js';import bs58 from 'bs58';
import {createIqMediaContext} from '../media.mjs';
const genesis='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
test('media writer binds network and signer and reports uncertain landed receipt',async()=>{
 const signature=bs58.encode(Keypair.generate().secretKey);let writes=0;
 const signer={publicKey:Keypair.generate().publicKey,signTransaction(){}};
 const connection={getGenesisHash:async()=>genesis,getSignatureStatuses:async()=>({value:[null]})};
 const sdk={writer:{codeIn:async input=>{assert.equal(input.signer,signer);writes++;return signature;}}};
 const context=await createIqMediaContext({sdk,connection,signer,chain:'solana:devnet',gateway:'https://gateway.iqlabs.dev',saveCheckpoint:async()=>{}});
 assert.equal(context.expectedGenesis,genesis);
 await assert.rejects(()=>context.writeArtifact(new TextEncoder().encode('{}'),'x.json'),e=>e.signature===signature);assert.equal(writes,1);
 connection.getGenesisHash=async()=> 'wrong';await assert.rejects(()=>context.writeArtifact(new TextEncoder().encode('{}'),'x.json'),/chain mismatch/);assert.equal(writes,1);
});
test('gateway media reads coalesce and never fall back to repeated RPC scans',async t=>{
 const old=global.fetch;t.after(()=>global.fetch=old);let reads=0;
 global.fetch=async()=>{reads++;return new Response('{}');};
 const context=await createIqMediaContext({sdk:{},connection:{getGenesisHash:async()=>genesis},signer:{publicKey:Keypair.generate().publicKey},chain:'solana:devnet',gateway:'https://gateway.iqlabs.dev',saveCheckpoint:async()=>{}});
 const signature=bs58.encode(Keypair.generate().secretKey);
 await Promise.all([context.readArtifact(signature),context.readArtifact(signature)]);assert.equal(reads,1);await context.readArtifact(signature);assert.equal(reads,2);
});
