import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,readFile,rm,symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { prepareRenderKit } from '../kit.mjs';
import {fixture} from './fixtures.mjs';
test('normal collection mode never reads a layer directory',async()=>{assert.equal(await prepareRenderKit(null,'/does-not-exist'),null);});
test('a real aligned PNG kit retains original base identity and a closed upload list',async()=>{
 const f=await fixture();try{await writeFile(path.join(f.root,'do-not-upload.txt'),'private unrelated file');const kit=await prepareRenderKit(f.input,f.root);assert.equal(kit.edition.items[0].sha256,f.input.items[0].sha256);assert.equal(kit.appearance.subtitle,'새로운 모습');assert(kit.files.every(file=>file.mime.startsWith('image/')));assert(!kit.files.some(file=>file.file.includes('do-not-upload')));assert(kit.edition.sourceHashes['hair-b']);}finally{await f.stop();}
});
test('flat art, identity-layer swaps and mismatched base hashes reject',async()=>{
 const f=await fixture();try{for(const change of ['flat','body','hash']){const input=structuredClone(f.input);if(change==='flat')delete input.items[0].sourceDna;if(change==='body'){input.slotGroups={0:'Body'};input.definitions[0].sourceId='body';}if(change==='hash')input.items[0].sha256='00'.repeat(32);await assert.rejects(prepareRenderKit(input,f.root));}}finally{await f.stop();}
});
test('paths and symlink escapes are not uploaded',async()=>{
 const f=await fixture(),outside=await mkdtemp(path.join(tmpdir(),'iq-outside-'));try{await writeFile(path.join(outside,'escape.png'),await readFile(path.join(f.root,'hair-b.png')));await symlink(path.join(outside,'escape.png'),path.join(f.root,'escape.png'));for(const file of ['../escape.png','escape.png']){const input=structuredClone(f.input);input.config.groups[2].assets[1].file=file;await assert.rejects(prepareRenderKit(input,f.root),/relative|outside/);}}finally{await f.stop();await rm(outside,{recursive:true,force:true});}
});
test('contract-allowed equipment combinations must satisfy renderer constraints',async()=>{
 const f=await fixture();try{const input=structuredClone(f.input);input.config.groups[0].assets.push({id:'bg-other',file:'bg.png',label:'Other',weight:1});input.config.groups[2].assets[1].requires={Background:['bg-other']};await assert.rejects(prepareRenderKit(input,f.root),/combination cannot render/);input.slotGroups[4]='Background';input.definitions.push({id:1,name:'Other background',sourceId:'bg-other',slot:4,bodyMask:1,supply:4});input.definitions[0].requiredSlot=4;input.definitions[0].requiredDefinition=1;const kit=await prepareRenderKit(input,f.root);assert(kit.compatibilityChecks>0);}finally{await f.stop();}
});

test('generic collection rendering reuses recipes, preserves the base and pins modified layers',async()=>{
 const f=await fixture();
 const {createCuratedRenderer}=await import('../../service/renderer.mjs');let renderer;
 try{
  const kit=await prepareRenderKit(f.input,f.root);
  for(const [file,data]of [['config.json',kit.config],['edition.json',kit.edition],['catalog.json',kit.catalog]])await writeFile(path.join(f.root,file),JSON.stringify(data));
  renderer=await createCuratedRenderer(f.root);
  const base={address:'local-test',revision:0,name:'Creator #1',bodyClass:0,sourceEditionId:1,originalBasePreserved:true,definitions:[255,255,255,255,255,255]};
  const original=await renderer.image(base);assert.equal(createHash('sha256').update(original.image).digest('hex'),f.input.items[0].sha256);
  const dressed=await renderer.image({...base,revision:1,definitions:[0,255,255,255,255,255]});assert.equal((await sharp(dressed.image).metadata()).format,'webp');
  await writeFile(path.join(f.root,'hair-b.png'),await readFile(path.join(f.root,'hair-a.png')));
  await assert.rejects(renderer.image({...base,revision:2,definitions:[0,255,255,255,255,255]}),/layer changed/);
 }finally{await renderer?.stop();await f.stop();}
});
