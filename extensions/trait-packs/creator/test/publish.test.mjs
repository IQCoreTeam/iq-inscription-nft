import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash,randomBytes } from 'node:crypto';
import bs58 from 'bs58';
import { publishRenderKit } from '../publish.mjs';
import {prepareRenderKit} from '../kit.mjs';
import {fixture as kitFixture} from './fixtures.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(){
 const source=await kitFixture(),root=source.root;source.input.appearance.coverFile=null;const kit=await prepareRenderKit(source.input,root);
 const objects=new Map(),state={writes:0,reads:0,saves:0,failWrite:false,failRead:false};
 const context={owner:'11111111111111111111111111111111',gateway:'http://127.0.0.1:4547',expectedGenesis:'local-pinned',connection:{getGenesisHash:async()=> 'local-pinned'},saveCheckpoint:async()=>{state.saves++;},writeArtifact:async(bytes)=>{state.writes++;if(state.failWrite)throw Error('Connection lost before outcome known');const sig=bs58.encode(randomBytes(64));objects.set(sig,Buffer.from(bytes));return sig;},readArtifact:async sig=>{state.reads++;if(state.failRead)throw Error('Temporary reader outage');return objects.get(sig);}};
 return {root,kit,context,state,objects,stop:()=>rm(root,{recursive:true,force:true})};
}
test('normal-off mode never contacts storage',async()=>assert.equal(await publishRenderKit(null,null,null,null),null));
test('publishes a verified DAG without pre-inscribing all base NFTs, and reuses confirmed artifacts',async()=>{
 const f=await fixture();try{const checkpoint={},first=await publishRenderKit(f.kit,f.root,f.context,checkpoint);assert.equal(f.state.writes,6);assert.equal(first.artifacts,6);const manifest=JSON.parse(f.objects.get(first.renderKit));assert.equal(manifest.edition.items[0].file,undefined);assert(!manifest.media['base.webp']);const metadata=JSON.parse(f.objects.get(first.definitions[0].uri.split('/').at(-1)));assert.equal(metadata.properties.iqTraitKit,first.renderKit);assert.equal(first.definitions[0].hash,hash(JSON.stringify(metadata)));const second=await publishRenderKit(f.kit,f.root,f.context,checkpoint);assert.deepEqual(second,first);assert.equal(f.state.writes,6);}finally{await f.stop();}
});
test('an ambiguous send is not repeated without receipt recovery',async()=>{
 const f=await fixture();try{f.state.failWrite=true;const checkpoint={};await assert.rejects(publishRenderKit(f.kit,f.root,f.context,checkpoint));assert(checkpoint.pending);f.state.failWrite=false;await assert.rejects(publishRenderKit(f.kit,f.root,f.context,checkpoint),/outcome is unknown/);assert.equal(f.state.writes,1);}finally{await f.stop();}
});
test('known confirmed signature survives reader failure and resumes without re-signing',async()=>{
 const f=await fixture();try{f.state.failRead=true;const checkpoint={};await assert.rejects(publishRenderKit(f.kit,f.root,f.context,checkpoint));assert(checkpoint.pending.signature);assert.equal(f.state.writes,1);f.state.failRead=false;await publishRenderKit(f.kit,f.root,f.context,checkpoint);assert.equal(f.state.writes,6);}finally{await f.stop();}
});
test('changed local files, draft contents or chain cannot reuse a publication checkpoint',async()=>{
 const f=await fixture();try{const checkpoint={};await publishRenderKit(f.kit,f.root,f.context,checkpoint);await assert.rejects(publishRenderKit({...f.kit,appearance:{...f.kit.appearance,title:'Other'}},f.root,f.context,checkpoint),/kit changed|Revalidate/);await assert.rejects(publishRenderKit(f.kit,f.root,{...f.context,expectedGenesis:'wrong'},checkpoint),/Wrong publication chain/);await writeFile(path.join(f.root,'hair-b.png'),'modified');await assert.rejects(publishRenderKit(f.kit,f.root,f.context,checkpoint),/Source image changed/);assert.equal(f.state.writes,6);}finally{await f.stop();}
});
test('a thrown writer receipt is persisted and recovered without duplicate inscription',async()=>{
 const f=await fixture();try{
  const original=f.context.writeArtifact;let lost=true;
  f.context.writeArtifact=async(...args)=>{const signature=await original(...args);if(lost){lost=false;throw Object.assign(Error('confirmation unavailable'),{signature});}return signature;};
  const checkpoint={};await assert.rejects(()=>publishRenderKit(f.kit,f.root,f.context,checkpoint),/confirmation unavailable/);
  assert(checkpoint.pending.signature);assert.equal(f.state.writes,1);
  await publishRenderKit(f.kit,f.root,f.context,checkpoint);assert.equal(f.state.writes,6);
 }finally{await f.stop();}
});
