import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
import {addresses} from '../protocol.mjs';
import {verifyPackRandomness} from '../randomness.mjs';
const key=n=>new PublicKey(new Uint8Array(32).fill(n));
function fixture(){
 const program=key(1),collection=key(2),keys=addresses(program,collection,0),provider=new PublicKey('VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y');
 const pool=Buffer.alloc(4352);pool.write('NUBSALE5');collection.toBuffer().copy(pool,40);provider.toBuffer().copy(pool,104);pool.writeBigUInt64LE(100n,200);pool[208]=4;pool[209]=4;pool[250]=1;
 for(let i=0;i<4;i++){pool[384+i*240+36]=6;pool.write('Test '+i,384+i*240+37);}
 const epoch=Buffer.alloc(2048);epoch.write('NUBEPOC5');keys.pool.toBuffer().copy(epoch,8);epoch[48]=6;epoch.writeUInt16LE(2,65);epoch.writeUInt16LE(2,67);epoch.fill(3,77,109);epoch[141]=1;
 const oracle=Buffer.alloc(137);Buffer.from([139,239,184,215,227,86,191,226]).copy(oracle);oracle[8]=1;keys.requester.toBuffer().copy(oracle,9);epoch.subarray(77,109).copy(oracle,41);oracle.fill(7,73,137);
 createHash('sha256').update('NUBBIES_ORAO_RESULT_V4').update(oracle.subarray(73,137)).digest().copy(epoch,109);
 [36,22,10,4].forEach((v,i)=>epoch.writeUInt32LE(v,160+i*4));
 [[0,0,2,0],[2,1,1,0]].forEach((v,i)=>{Buffer.from(v).copy(epoch,256+i*48+40);epoch[256+i*48+44]=15;});
 let reads=0,recordOwner=provider,slot=11;
 const connection={getGenesisHash:async()=> 'local-test',getMultipleAccountsInfoAndContext:async()=>{reads++;return{context:{slot:10},value:[{owner:program,data:pool},{owner:program,data:epoch}]};},getAccountInfoAndContext:async(address,options)=>{reads++;assert.equal(options.minContextSlot,10);assert.equal(address.toBase58(),PublicKey.findProgramAddressSync([Buffer.from('orao-vrf-randomness-request'),epoch.subarray(77,109)],provider)[0].toBase58());return{context:{slot},value:{owner:recordOwner,data:oracle}};}};
 return{pool,epoch,oracle,reads:()=>reads,setOwner:v=>recordOwner=v,setSlot:v=>slot=v,run:extra=>verifyPackRandomness({connection,program,collection,chain:'solana:localnet',localGenesis:'local-test',epochId:0,ticket:1,...extra})};
}
test('replays a known two-ticket vector with two bounded account reads',async()=>{const f=fixture(),r=await f.run();assert.equal(r.matches,true);assert.equal(r.simulation,true);assert.deepEqual(r.initialInventory,[40,24,12,4]);assert.deepEqual(r.draws.map(x=>x.definition),[2,1,1,0]);assert.equal(f.reads(),2);});
test('proof rejects changed records and unfinished openings',async t=>{
 for(const [name,change] of [
 ['oracle result',f=>f.oracle[73]^=1],['oracle seed',f=>f.oracle[41]^=1],['oracle client',f=>f.oracle[9]^=1],['unfulfilled',f=>f.oracle[8]=0],
 ['wrong owner',f=>f.setOwner(key(8))],['stale slot',f=>f.setSlot(9)],['draw mismatch',f=>f.epoch[256+40]=1],['pending allocation',f=>f.epoch.writeUInt16LE(1,67)],['missing claim',f=>f.epoch[256+48+44]=7],['wrong collection',f=>f.pool[40]^=1]
 ])await t.test(name,async()=>{const f=fixture();change(f);await assert.rejects(f.run());});
});
test('wrong network and invalid ticket reject before proof account reads',async()=>{const f=fixture();await assert.rejects(f.run({localGenesis:'wrong'}),/chain mismatch/);await assert.rejects(f.run({ticket:32}),/identity/);assert.equal(f.reads(),0);});
