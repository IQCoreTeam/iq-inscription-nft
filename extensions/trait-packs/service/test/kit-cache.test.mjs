import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,access,symlink} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';import {createHash,randomBytes} from 'node:crypto';import sharp from 'sharp';import bs58 from 'bs58';
import {fixture} from '../../creator/test/fixtures.mjs';import {prepareRenderKit} from '../../creator/kit.mjs';import {publishRenderKit} from '../../creator/publish.mjs';import {createCuratedRenderer} from '../renderer.mjs';import {createPublishedKitRenderer,validateRenderableKit} from '../kit-cache.mjs';
const collection='11111111111111111111111111111112';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function publishedFixture({mask=false}={}){
 const source=await fixture();
 if(mask){
  const rgba=Buffer.alloc(16*16*4);for(let y=0;y<16;y++)for(let x=0;x<8;x++){const at=(y*16+x)*4;rgba[at]=255;rgba[at+1]=255;rgba[at+2]=255;rgba[at+3]=255;}
  await writeFile(path.join(source.root,'mask.png'),await sharp(rgba,{raw:{width:16,height:16,channels:4}}).png().toBuffer());
  source.input.config.groups.push({name:'Accessory',role:'overlay',assets:[{id:'accessory',file:'hair-a.png',label:'Accessory',weight:1,occlusion:{targetGroup:'Hair',maskFile:'mask.png'}}]});source.input.items[0].sourceDna.push('accessory');
 }
 source.input.appearance.coverFile=null;const kit=await prepareRenderKit(source.input,source.root),objects=new Map();
 const context={owner:collection,gateway:'http://127.0.0.1',expectedGenesis:'local',connection:{getGenesisHash:async()=> 'local'},saveCheckpoint:async()=>{},writeArtifact:async bytes=>{const sig=bs58.encode(randomBytes(64));objects.set(sig,Buffer.from(bytes));return sig;},readArtifact:async sig=>objects.get(sig)};
 const published=await publishRenderKit(kit,source.root,context,{}),recipe=JSON.parse(objects.get(published.renderKit)),cacheRoot=await mkdtemp(path.join(tmpdir(),'iq-public-render-cache-'));
 const verified={collection,kit,recipe,renderKit:published.renderKit,renderKitHash:hash(objects.get(published.renderKit)),published};
 return {source,kit,objects,verified,cacheRoot,readArtifact:async sig=>objects.get(sig),stop:async()=>{await source.stop();await rm(cacheRoot,{recursive:true,force:true});}};
}
const avatar={address:'synthetic-local-asset',revision:1,name:'Creator #1',bodyClass:0,sourceEditionId:1,originalBasePreserved:true,definitions:[0,255,255,255,255,255]};
test('staging and the entire disk cache can disappear; permanent shared sources rebuild the same outfit',async()=>{
 const f=await publishedFixture();let original,cache;
 try{
  for(const [file,data]of [['config.json',f.kit.config],['edition.json',f.kit.edition],['catalog.json',f.kit.catalog]])await writeFile(path.join(f.source.root,file),JSON.stringify(data));
  original=await createCuratedRenderer(f.source.root);const expected=await original.image(avatar);await original.stop();original=null;await f.source.stop();
  let reads=0;cache=createPublishedKitRenderer({cacheRoot:f.cacheRoot,readVerifiedPublishedKit:async()=>f.verified,readArtifact:async sig=>{reads++;return f.readArtifact(sig);}});
  const first=await cache.forCollection(collection),actual=await first.renderer.image(avatar);assert.deepEqual(actual.image,expected.image);assert.equal(reads,4);await assert.rejects(access(path.join(first.root,'base/1.png')));
  await cache.stop();cache=null;await rm(f.cacheRoot,{recursive:true,force:true});
  cache=createPublishedKitRenderer({cacheRoot:f.cacheRoot,readVerifiedPublishedKit:async()=>f.verified,readArtifact:f.readArtifact});const restarted=await cache.forCollection(collection);assert.deepEqual((await restarted.renderer.image(avatar)).image,expected.image);
 }finally{await original?.stop();await cache?.stop();await f.stop();}
});
test('permanent image envelope tampering, MIME changes and path escapes reject before renderer creation',async()=>{
 for(const kind of ['bytes','mime','path','source-pin']){
  const f=await publishedFixture();let cache;
  try{
   const entry=f.verified.recipe.media['hair-b.png'];
   if(kind==='bytes'){const value=JSON.parse(f.objects.get(entry.signature));value.body='data:image/png;base64,'+Buffer.from('not the reviewed pixels').toString('base64');f.objects.set(entry.signature,Buffer.from(JSON.stringify(value)));}
   if(kind==='mime'){const value=JSON.parse(f.objects.get(entry.signature));value.body=value.body.replace('image/png','image/webp');f.objects.set(entry.signature,Buffer.from(JSON.stringify(value)));}
   if(kind==='path'){f.verified.kit.config.groups[2].assets[1].file='../escape.png';}
   if(kind==='source-pin')f.verified.recipe.media['hair-b.png'].sha256='00'.repeat(32);
   cache=createPublishedKitRenderer({cacheRoot:f.cacheRoot,readVerifiedPublishedKit:async()=>f.verified,readArtifact:f.readArtifact});await assert.rejects(()=>cache.forCollection(collection),/pin|source|image|path|encoding|MIME/);
  }finally{await cache?.stop();await f.stop();}
 }
});
test('mask bytes are recovered and hash-pinned; a wrong mask cannot be substituted',async()=>{
 const f=await publishedFixture({mask:true});let cache;
 try{
  cache=createPublishedKitRenderer({cacheRoot:f.cacheRoot,readVerifiedPublishedKit:async()=>f.verified,readArtifact:f.readArtifact});const result=await cache.forCollection(collection);assert.equal(hash(await readFile(path.join(result.root,'mask.png'))),f.kit.edition.maskSourceHashes['mask.png']);await result.renderer.image(avatar);await cache.stop();cache=null;await rm(f.cacheRoot,{recursive:true,force:true});
  const entry=f.verified.recipe.media['mask.png'];entry.sha256='00'.repeat(32);cache=createPublishedKitRenderer({cacheRoot:f.cacheRoot,readVerifiedPublishedKit:async()=>f.verified,readArtifact:f.readArtifact});await assert.rejects(()=>cache.forCollection(collection),/pins/);
 }finally{await cache?.stop();await f.stop();}
});
test('cached-file tampering is rejected after process restart',async()=>{
 const f=await publishedFixture();let cache;
 try{
  cache=createPublishedKitRenderer({cacheRoot:f.cacheRoot,readVerifiedPublishedKit:async()=>f.verified,readArtifact:f.readArtifact});const result=await cache.forCollection(collection);await cache.stop();cache=null;
  await writeFile(path.join(result.root,'hair-b.png'),await readFile(path.join(result.root,'hair-a.png')));
  cache=createPublishedKitRenderer({cacheRoot:f.cacheRoot,readVerifiedPublishedKit:async()=>f.verified,readArtifact:f.readArtifact});await assert.rejects(()=>cache.forCollection(collection),/Cached render source changed/);
 }finally{await cache?.stop();await f.stop();}
});

test('a symlinked recovered source cannot escape the dedicated cache root',async()=>{
 const f=await publishedFixture();let cache;
 try{
  cache=createPublishedKitRenderer({cacheRoot:f.cacheRoot,readVerifiedPublishedKit:async()=>f.verified,readArtifact:f.readArtifact});const result=await cache.forCollection(collection);await cache.stop();cache=null;
  await rm(path.join(result.root,'hair-b.png'));await symlink(path.join(f.source.root,'hair-b.png'),path.join(result.root,'hair-b.png'));
  cache=createPublishedKitRenderer({cacheRoot:f.cacheRoot,readVerifiedPublishedKit:async()=>f.verified,readArtifact:f.readArtifact});await assert.rejects(()=>cache.forCollection(collection),/outside configured root/);
 }finally{await cache?.stop();await f.stop();}
});
test('concurrent recovery coalesces and reads only shared sources',async()=>{
 const f=await publishedFixture();let cache,reads=0;
 try{
  cache=createPublishedKitRenderer({cacheRoot:f.cacheRoot,readVerifiedPublishedKit:async()=>f.verified,readArtifact:async sig=>{reads++;await new Promise(setImmediate);return f.readArtifact(sig);}});
  const [first,second]=await Promise.all([cache.forCollection(collection),cache.forCollection(collection)]);assert.equal(first.root,second.root);assert.equal(first.renderer,second.renderer);assert.equal(reads,4);
  await rm(first.root,{recursive:true,force:true});const [rebuiltA,rebuiltB]=await Promise.all([cache.forCollection(collection),cache.forCollection(collection)]);assert.equal(rebuiltA.renderer,rebuiltB.renderer);assert.equal(reads,8);
  await cache.stop();await assert.rejects(()=>cache.forCollection(collection),/stopped/);
 }finally{await cache?.stop();await f.stop();}
});

test('native render limits reject oversized prepared kits before publication or source reads',async()=>{
 const f=await publishedFixture();
 try{
  assert.equal(validateRenderableKit(f.kit).size,4);
  const tooMany=structuredClone(f.kit);
  for(let i=0;i<189;i++){const id='extra-'+i,file=id+'.png';tooMany.config.groups[2].assets.push({id,file,label:id,weight:1});tooMany.edition.sourceHashes[id]=tooMany.edition.sourceHashes['hair-a'];tooMany.files.push({...tooMany.files.find(entry=>entry.file==='hair-a.png'),file});}
  assert.throws(()=>validateRenderableKit(tooMany),/source count exceeds/);
  const tooLarge=structuredClone(f.kit);for(const file of tooLarge.files)if(file.kind==='layer')file.bytes=16_000_001;assert.throws(()=>validateRenderableKit(tooLarge),/source budget/);
  const tooManyPixels=structuredClone(f.kit);for(const file of tooManyPixels.files)if(file.kind==='layer'){file.width=4001;file.height=4000;}assert.throws(()=>validateRenderableKit(tooManyPixels),/source budget/);
  const boundary=structuredClone(f.kit);for(const file of boundary.files)if(file.kind==='layer'){file.bytes=16_000_000;file.width=4000;file.height=4000;}assert.equal(validateRenderableKit(boundary).size,4);
 }finally{await f.stop();}
});
