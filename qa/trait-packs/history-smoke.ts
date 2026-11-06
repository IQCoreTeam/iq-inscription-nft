// Exercise the former collection-wide 64-epoch ceiling with real local writes.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {PublicKey,SystemProgram} from '@solana/web3.js';
import {inputsFromEnvironment,startSyntheticFixture,snapshotSource,ORAO_ID} from './fixture.mjs';
import {catalogSetup} from '../../extensions/trait-packs/creator/catalog.mjs';
import {addresses,account,instruction,readEpoch} from '../../extensions/trait-packs/client/protocol.mjs';
import {createPackPageStateReader} from '../../extensions/trait-packs/service/pack-state.mjs';
const inputs=await inputsFromEnvironment(),sourceHashes=await snapshotSource(),f=await startSyntheticFixture(inputs),out=new URL('./.evidence/history-'+Date.now()+'/',import.meta.url);
await mkdir(out,{recursive:true});
const report:any={passed:false,scope:'offline Surfpool, generated keys,70 real empty sale epochs; not280 on-chain reward mints',sourceHashes,inputs:Object.fromEntries(Object.entries(inputs).map(([k,v]:any)=>[k,v.sha256]))};
try {
 const metadata=Buffer.from(JSON.stringify({name:'History proof',image:'http://127.0.0.1/history.png',attributes:[{trait_type:'Initial supply',value:4}]}));
 const spec={program:f.program,collection:f.collection,registry:f.registry,nftProgram:f.iqId,authority:f.creator.publicKey,treasury:f.treasury.publicKey,provider:new PublicKey(ORAO_ID),providerTreasury:f.providerTreasury.publicKey,price:100000000,window:1000,timeout:1000,definitions:[{id:0,name:'History proof',slot:0,bodyMask:1,supply:4,hash:createHash('sha256').update(metadata).digest('hex'),uri:'http://127.0.0.1/history.json',requiredSlot:255,requiredDefinition:255}]};
 for(const step of catalogSetup(spec,null))await f.send('history-catalog-'+step.stage,[step.instruction]);
 const pool=addresses(f.program,f.collection).pool;
 for(let id=0;id<70;id++) {
  const current=addresses(f.program,f.collection,id),previous=addresses(f.program,f.collection,Math.max(0,id-1));
  await f.send('history-open-'+id,[instruction(f.program,1,[account(f.creator.publicKey,true,true),account(pool,true),account(current.epoch,true),account(SystemProgram.programId),...(id?[account(previous.epoch),account(previous.requester)]:[])])]);
  const e=readEpoch((await f.connection.getAccountInfo(current.epoch,'confirmed'))!.data);f.surf.timeTravelToSlot(e.closeSlot+1);
  await f.send('history-close-empty-'+id,[instruction(f.program,3,[account(pool),account(current.epoch,true)])]);
 }
 let scans=0;const original=f.connection.getProgramAccounts.bind(f.connection);
 f.connection.getProgramAccounts=async(...args:any[])=>{scans++;assert(args[1].filters.some((filter:any)=>filter.memcmp?.offset===40));return original(...args);};
 const reader=createPackPageStateReader({connection:f.connection,program:f.program,collection:f.collection,chain:'solana:localnet',expectedGenesis:await f.connection.getGenesisHash(),readCoreAssets:async keys=>{assert.equal(keys.length,0);return new Map();},readMetadata:async()=>metadata,getAvatar:async()=>null,outfitUrl:()=>{throw Error('No NFT in this history proof');}});
 const seen=new Set<number>();let before:any,pages=0;
 do {
  const value=await reader.read(undefined,{before});pages++;assert(value.epochs.length<=2);assert.equal(value.traits.length,0);assert.equal(value.packs.length,0);
  for(const e of value.epochs){assert(!seen.has(e.id));seen.add(e.id);}
  const calls=scans;await reader.read(undefined,{before});assert.equal(scans,calls,'same-page requests should share the warm cache');
  before=value.pagination.nextBefore;
 }while(before!==null);
 assert.equal(seen.size,70);assert(seen.has(0)&&seen.has(69));assert.equal(pages,35);assert.equal(scans,70);
 assert.deepEqual(await snapshotSource(),sourceHashes,'Source changed during proof');
 Object.assign(report,{passed:true,epochCount:70,pageCount:pages,epochIssuanceScans:scans,receipts:f.receipts,firstEpoch:0,lastEpoch:69});
} catch(error){report.error=String(error);process.exitCode=1;} finally {
 f.stop();await writeFile(new URL('RESULTS.json',out),JSON.stringify(report,null,2));console.log(new URL('RESULTS.json',out).pathname);
}
