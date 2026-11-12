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
 const old=global.fetch;t.after(()=>global.fetch=old);let reads=0;const phases=[];
 global.fetch=async()=>{reads++;return new Response('{}');};
 const context=await createIqMediaContext({sdk:{},connection:{getGenesisHash:async()=>genesis},signer:{publicKey:Keypair.generate().publicKey},chain:'solana:devnet',gateway:'https://gateway.iqlabs.dev',saveCheckpoint:async()=>{},onProgress:event=>{phases.push(event.phase);throw Error('Broken display');}});
 const signature=bs58.encode(Keypair.generate().secretKey);
 await Promise.all([context.readArtifact(signature),context.readArtifact(signature)]);assert.equal(reads,1);await context.readArtifact(signature);assert.equal(reads,2);assert.deepEqual(phases,['checking-gateway-copy','checking-gateway-copy']);
});

test('cold gateway reads have a bounded two-minute budget and never automatically retry',async t=>{
 const oldFetch=global.fetch,oldTimeout=AbortSignal.timeout;t.after(()=>{global.fetch=oldFetch;AbortSignal.timeout=oldTimeout;});let reads=0,timeoutMs=0,chainReads=0;
 AbortSignal.timeout=ms=>{timeoutMs=ms;return new AbortController().signal;};
 global.fetch=async()=>{reads++;throw new DOMException('Timeout','TimeoutError');};
 const context=await createIqMediaContext({sdk:{},connection:{getGenesisHash:async()=>{chainReads++;return genesis;}},signer:{publicKey:Keypair.generate().publicKey},chain:'solana:devnet',gateway:'https://gateway.iqlabs.dev',saveCheckpoint:async()=>{},onProgress:()=>Promise.reject(Error('Async display failure'))});
 await assert.rejects(()=>context.readArtifact(bs58.encode(Keypair.generate().secretKey)),/after 2 minutes.*receipt is saved.*existing inscription/);
 assert.equal(timeoutMs,120000);assert.equal(reads,1);assert.equal(chainReads,1);
});

test('SDK chunk progress is artifact-scoped, integer deduplicated and cannot fail a write',async()=>{
 const signature=bs58.encode(Keypair.generate().secretKey),events=[];let writes=0,statusReads=0;
 const sdk={writer:{codeIn:async(_input,_text,name,_method,_type,onProgress)=>{
  writes++;assert.equal(typeof onProgress,'function');
  for(const percent of [0,0.2,1.1,1.9,NaN,50.8,100])onProgress(percent);
  return signature;
 }}};
 const connection={getGenesisHash:async()=>genesis,getSignatureStatuses:async()=>{statusReads++;return{value:[{confirmationStatus:'confirmed',err:null}]};}};
 const context=await createIqMediaContext({sdk,connection,signer:{publicKey:Keypair.generate().publicKey},chain:'solana:devnet',gateway:'https://gateway.iqlabs.dev',saveCheckpoint:async()=>{},onProgress:event=>{events.push(event);if(event.percent===1)throw Error('Broken display');if(event.percent===50)return Promise.reject(Error('Async display failure'));}});
 assert.equal(await context.writeArtifact(new TextEncoder().encode('{}'),'image.json'),signature);
 assert.deepEqual(events,[0,1,50,100].map(percent=>({name:'image.json',percent})));
 assert.equal(await context.writeArtifact(new TextEncoder().encode('{}'),'recipe.json'),signature);
 assert.deepEqual(events.slice(4),[0,1,50,100].map(percent=>({name:'recipe.json',percent})));
 assert.equal(writes,2);assert.equal(statusReads,2);
});
