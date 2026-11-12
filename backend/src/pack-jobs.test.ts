import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createPackJobStore, runPackJobs } from "./pack-jobs.ts";
const require = createRequire(new URL("../../extensions/trait-packs/operator/package.json",import.meta.url));
const {Keypair,Transaction,SystemProgram}=require("@solana/web3.js");
const bs58=require("bs58").default;
function signed() {
  const signer=Keypair.generate(),blockhash=Keypair.generate().publicKey.toBase58();
  const tx=new Transaction({feePayer:signer.publicKey,recentBlockhash:blockhash}).add(SystemProgram.transfer({fromPubkey:signer.publicKey,toPubkey:Keypair.generate().publicKey,lamports:1}));
  tx.sign(signer);
  return {state:'prepared',signature:bs58.encode(tx.signature),signedTransaction:tx.serialize().toString('base64'),blockhash,lastValidBlockHeight:100};
}
function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'iq-pack-jobs-')),path=join(dir,'jobs.sqlite');
  const db=new Database(path),peer=new Database(path);let clock=1000;
  db.exec('PRAGMA journal_mode=WAL');db.exec('PRAGMA busy_timeout=5000');peer.exec('PRAGMA busy_timeout=5000');
  const store=createPackJobStore(db,()=>clock),other=createPackJobStore(peer,()=>clock);
  return {db,peer,path,store,other,setClock(value:number){clock=value;},close(){db.close();peer.close();rmSync(dir,{recursive:true,force:true});}};
}
function market(checkpoint=signed()) {
  let builds=0,sends=0,status:any=null;
  const connection={getGenesisHash:async()=> 'pinned-local',getSignatureStatuses:async()=>({value:[status]}),getBlockHeight:async()=>50,sendRawTransaction:async(bytes:any)=>{sends++;expect(Buffer.from(bytes).toString('base64')).toBe(checkpoint.signedTransaction);return checkpoint.signature;}};
  const value={connection,expectedGenesis:'pinned-local',readState:async()=>({pool:{activeEpoch:0,definitions:[{remaining:4}]},epoch:{id:0,status:4,ticketCount:1,tickets:[{claimMask:15}],closeSlot:20,deadlineSlot:30},slot:40,providerStatus:'fulfilled'}),buildSigned:async()=>{builds++;return checkpoint;}};
  return {value,get builds(){return builds;},get sends(){return sends;},setStatus(value:any){status=value;},checkpoint};
}
test('real SQLite leases exclude a second worker and fence an expired owner',()=>{
 const f=fixture();try{const lease=f.store.acquire('market','one',1000)!;expect(f.other.acquire('market','two',1000)).toBeNull();f.setClock(2001);const next=f.other.acquire('market','two',1000)!;expect(next).not.toBeNull();expect(()=>f.store.prepare(lease,{key:'old',market:'market',task:{kind:'payout'},checkpoint:signed()},1000)).toThrow(/lease was lost/);f.store.release(lease);expect(f.store.acquire('market','three',1000)).toBeNull();f.other.release(next);expect(f.store.acquire('market','three',1000)).not.toBeNull();}finally{f.close();}
});
test('prepared signed identity is durable before submission and survives database reopen',async()=>{
 const f=fixture(),m=market();let reopened:Database|undefined;
 try{
  const original=m.value.connection.sendRawTransaction;m.value.connection.sendRawTransaction=async bytes=>{const stored=f.other.pending('market');expect(stored?.checkpoint.signature).toBe(m.checkpoint.signature);return original(bytes);};
  let report=await runPackJobs({store:f.store,markets:new Map([['market',m.value]]),workerId:'one'});expect(report[0].state).toBe('submitted');expect(m.builds).toBe(1);
  reopened=new Database(f.path);const restarted=createPackJobStore(reopened,()=>1000);m.setStatus({err:null,confirmationStatus:'confirmed',slot:55});
  report=await runPackJobs({store:restarted,markets:new Map([['market',m.value]]),workerId:'restart'});expect(report[0].state).toBe('confirmed');expect(m.builds).toBe(1);expect(m.sends).toBe(1);expect(restarted.confirmedSlot('market')).toBe(55);
  const originalRead=m.value.readState;m.value.readState=async(floor?:number)=>{expect(floor).toBe(55);return originalRead();};
  report=await runPackJobs({store:restarted,markets:new Map([['market',m.value]]),workerId:'restart'});expect(report[0].state).toBe('awaiting-chain-state');expect(m.builds).toBe(1);
 }finally{reopened?.close();f.close();}
});
test('lost broadcast response resumes exact signed bytes without rebuilding',async()=>{
 const f=fixture(),m=market();try{const original=m.value.connection.sendRawTransaction;let lost=true;m.value.connection.sendRawTransaction=async bytes=>{if(lost){lost=false;throw Error('connection lost');}return original(bytes);};let report=await runPackJobs({store:f.store,markets:new Map([['market',m.value]]),workerId:'one'});expect(report[0].state).toBe('unresolved');expect(f.other.pending('market')?.checkpoint.signature).toBe(m.checkpoint.signature);report=await runPackJobs({store:f.other,markets:new Map([['market',m.value]]),workerId:'two'});expect(report[0].state).toBe('submitted');expect(m.builds).toBe(1);expect(m.sends).toBe(1);}finally{f.close();}
});
test('expired unknown transaction remains unresolved and cannot select another action',async()=>{
 const f=fixture(),m=market();try{m.value.connection.getBlockHeight=async()=>101;for(let i=0;i<2;i++){const report=await runPackJobs({store:f.store,markets:new Map([['market',m.value]]),workerId:'one'});expect(report[0].state).toBe('unresolved');}expect(m.builds).toBe(1);expect(m.sends).toBe(0);}finally{f.close();}
});
test('empty allowlist is disabled and batches are bounded',async()=>{
 const f=fixture();try{expect(await runPackJobs({store:f.store,markets:new Map(),workerId:'one'})).toEqual([]);const one=market(),two=market();const report=await runPackJobs({store:f.store,markets:new Map([['one',one.value],['two',two.value]]),workerId:'one',limit:1});expect(report).toHaveLength(1);expect(two.builds).toBe(0);}finally{f.close();}
});

test('lease lost during signing cannot persist or broadcast an unowned job',async()=>{
 const f=fixture(),m=market();try{m.value.buildSigned=async()=>{f.setClock(2001);return m.checkpoint;};const report=await runPackJobs({store:f.store,markets:new Map([['market',m.value]]),workerId:'one',leaseMs:1000});expect(report[0].state).toBe('unavailable');expect(f.other.pending('market')).toBeNull();expect(m.sends).toBe(0);}finally{f.close();}
});

test('confirmed allocation prefix cannot stall the next allocation job',async()=>{
 const f=fixture(),m=market();let cursor=0;
 const connection=m.value.connection;
 m.value.readState=async()=>({pool:{activeEpoch:0,definitions:[{remaining:36}]},epoch:{id:0,status:7,cursor,ticketCount:9,tickets:Array.from({length:9},()=>({claimMask:0}))},slot:40,providerStatus:'fulfilled'});
 m.value.buildSigned=async()=>signed();
 try{let report=await runPackJobs({store:f.store,markets:new Map([['market',m.value]]),workerId:'one'});const first=f.store.pending('market')!;m.setStatus({err:null,confirmationStatus:'confirmed'});report=await runPackJobs({store:f.store,markets:new Map([['market',m.value]]),workerId:'one'});expect(report[0].state).toBe('confirmed');cursor=8;connection.sendRawTransaction=async bytes=>bs58.encode(Transaction.from(bytes).signature);report=await runPackJobs({store:f.store,markets:new Map([['market',m.value]]),workerId:'one'});const second=f.store.get('market:0:allocate:::8');expect(second?.key).not.toBe(first.key);expect(second?.task.cursor).toBe(8);expect(report[0].state).toBe('confirmed');}finally{f.close();}
});

test('idle collections cannot starve a later paid collection beyond the bounded next tick',async()=>{
 const f=fixture(),entries=Array.from({length:9},(_,i)=>['market-'+i,market()] as const);
 for(const [,m]of entries.slice(0,8))m.value.readState=async()=>({pool:{activeEpoch:0,definitions:[{remaining:4}]},epoch:{id:0,status:1,ticketCount:0,tickets:[],closeSlot:1000,deadlineSlot:2000},slot:40,providerStatus:'pending'});
 const markets=new Map(entries.map(([id,m])=>[id,m.value]));
 try{
  const first=await runPackJobs({store:f.store,markets,workerId:'one'});
  expect(first).toHaveLength(8);expect(first.every(row=>row.state==='idle')).toBe(true);expect(entries[8][1].builds).toBe(0);
  const second=await runPackJobs({store:f.store,markets,workerId:'one'});
  expect(second).toHaveLength(8);expect(second[0]).toMatchObject({market:'market-8',state:'submitted'});expect(entries[8][1].builds).toBe(1);expect(entries[8][1].sends).toBe(1);
  expect(markets.size).toBe(9);for(const[id,m]of entries)expect(markets.get(id)).toBe(m.value);
 }finally{f.close();}
});

test('concurrent rotating passes preserve lease exclusion for a batch still in progress',async()=>{
 const f=fixture(),one=market(),two=market();let release!:()=>void,entered!:()=>void;
 const blocked=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
 const idle=async()=>({pool:{activeEpoch:0,definitions:[{remaining:4}]},epoch:{id:0,status:1,ticketCount:0,tickets:[],closeSlot:1000,deadlineSlot:2000},slot:40,providerStatus:'pending'});
 one.value.readState=async()=>{entered();await blocked;return idle();};two.value.readState=idle;
 const markets=new Map([['one',one.value],['two',two.value]]);let first:Promise<any>|undefined;
 try{
  first=runPackJobs({store:f.store,markets,workerId:'first',limit:1});await started;
  expect(await runPackJobs({store:f.other,markets,workerId:'second',limit:1})).toMatchObject([{market:'two',state:'idle'}]);
  expect(await runPackJobs({store:f.other,markets,workerId:'third',limit:1})).toMatchObject([{market:'one',state:'leased'}]);
  release();expect(await first).toMatchObject([{market:'one',state:'idle'}]);expect(one.builds+two.builds).toBe(0);
 }finally{release();await first;f.close();}
});

test('a reset allowlist order after SQLite restart still reaches later exact signed recovery',async()=>{
 const f=fixture(),later=market(),entries=Array.from({length:8},(_,i)=>['idle-'+i,market()] as const);let reopened:Database|undefined;
 for(const[,m]of entries)m.value.readState=async()=>({pool:{activeEpoch:0,definitions:[{remaining:4}]},epoch:{id:0,status:1,ticketCount:0,tickets:[],closeSlot:1000,deadlineSlot:2000},slot:40,providerStatus:'pending'});
 try{
  const lease=f.store.acquire('later','original',1000)!;
  f.store.prepare(lease,{key:'later:0:payout:::',market:'later',task:{kind:'payout'},checkpoint:later.checkpoint},1000);f.store.release(lease);
  reopened=new Database(f.path);const restarted=createPackJobStore(reopened,()=>1000),markets=new Map([...entries.map(([id,m])=>[id,m.value] as const),['later',later.value] as const]);
  await runPackJobs({store:restarted,markets,workerId:'restart'});
  expect(later.sends).toBe(0);
  const second=await runPackJobs({store:restarted,markets,workerId:'restart'});
  expect(second[0]).toMatchObject({market:'later',state:'submitted',signature:later.checkpoint.signature});expect(later.builds).toBe(0);expect(later.sends).toBe(1);expect(restarted.pending('later')?.checkpoint.signedTransaction).toBe(later.checkpoint.signedTransaction);
 }finally{reopened?.close();f.close();}
});
