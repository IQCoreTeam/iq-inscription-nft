import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha256';
import { validateCatalog, catalogSetup } from '../catalog.mjs';
const key=()=>Keypair.generate().publicKey;
function draft(){
 const collection=key(),nftProgram=key();
 return {program:key(),collection,nftProgram,registry:PublicKey.findProgramAddressSync([Buffer.from('registry'),collection.toBuffer()],nftProgram)[0],authority:key(),treasury:key(),provider:key(),providerTreasury:key(),price:30_000_000,window:100,timeout:100,definitions:Array.from({length:4},(_,id)=>({id,name:'Trait '+id,uri:'https://example.invalid/trait/'+id,hash:'12'.repeat(32),slot:id,bodyMask:1,supply:[40,24,12,4][id]}))};
}
function account(spec,appended,sealed=false){
 const data=Buffer.alloc(4352);data.write('NUBSALE4');
 for(const [field,offset] of [['authority',8],['collection',40],['treasury',72],['provider',104],['providerTreasury',136]])new PublicKey(spec[field]).toBuffer().copy(data,offset);
 const encoded=validateCatalog(spec.definitions);Buffer.from(sha256(encoded)).copy(data,168);data.writeBigUInt64LE(BigInt(spec.price),200);data[208]=spec.definitions.length;data[209]=4;data.writeBigUInt64LE(BigInt(spec.window),210);data.writeBigUInt64LE(BigInt(spec.timeout),218);data[250]=sealed?1:0;data[251]=appended;encoded.copy(data,384,0,appended*240);
 return {owner:spec.program,data};
}
test('creator plan binds its collection and reuses the exact protocol encoding',()=>{
 const spec=draft(),plan=catalogSetup(spec,null);
 assert.deepEqual(plan.map(step=>step.stage),['initialize','append','append','seal']);
 assert.equal(plan[0].instruction.data[0],15);assert.equal(plan[1].instruction.data[0],11);assert.equal(plan.at(-1).instruction.data[0],12);
 assert.deepEqual(Buffer.concat(plan.filter(step=>step.stage==='append').map(step=>step.instruction.data.subarray(3))),validateCatalog(spec.definitions));
 assert(plan.every(step=>step.instruction.keys.some(meta=>meta.pubkey.equals(spec.authority)&&meta.isSigner)));
});
test('interrupted append resumes from confirmed bytes without initializing twice',()=>{
 const spec=draft(),plan=catalogSetup(spec,account(spec,2));
 assert.deepEqual(plan.map(step=>step.stage),['append','seal']);assert.equal(plan[0].start,2);
 const wrong=account(spec,2);wrong.data[384+37]^=1;assert.throws(()=>catalogSetup(spec,wrong),/prefix/);
});
test('a sealed matching catalog is already published even after stock changes',()=>{
 const spec=draft(),pool=account(spec,4,true);pool.data.writeUInt32LE(0,384+232);assert.deepEqual(catalogSetup(spec,pool),[]);
});
test('wrong authority, collection, program owner or changed settings cannot resume',()=>{
 const spec=draft(),pool=account(spec,2);
 for(const change of [{authority:key()},{collection:key()},{price:4},{provider:key()},{treasury:key()}])assert.throws(()=>catalogSetup({...spec,...change},pool));
 assert.throws(()=>catalogSetup(spec,{...pool,owner:key()}),/owner/);
});
test('prerequisites and UTF-8 byte limits reject before paying for a header',()=>{
 const spec=draft();spec.definitions[2].requiredSlot=0;spec.definitions[2].requiredDefinition=0;assert.doesNotThrow(()=>validateCatalog(spec.definitions));
 spec.definitions[0].requiredSlot=2;spec.definitions[0].requiredDefinition=2;assert.throws(()=>validateCatalog(spec.definitions),/cycle/);
 delete spec.definitions[0].requiredSlot;delete spec.definitions[0].requiredDefinition;spec.definitions[0].name='새'.repeat(11);assert.throws(()=>validateCatalog(spec.definitions),/string bound/);
});
test('invalid slot masks, supply totals and unavailable prerequisites cannot be sealed',()=>{
 for(const field of [{slot:6},{bodyMask:0},{hash:'0'.repeat(64)},{supply:-1}]){const spec=draft();Object.assign(spec.definitions[0],field);assert.throws(()=>validateCatalog(spec.definitions));}
 const spec=draft();spec.definitions.forEach(def=>def.supply=0);assert.throws(()=>validateCatalog(spec.definitions));
});
