import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import bs58 from 'bs58';
import {Keypair,PublicKey} from '@solana/web3.js';
import {sha256} from '@noble/hashes/sha256';
import {catalogSetup,validateCatalog} from '../catalog.mjs';
import {prepareRenderKit} from '../kit.mjs';
import {publishRenderKit} from '../publish.mjs';
import {fixture} from './fixtures.mjs';
const key=()=>Keypair.generate().publicKey;
function draft(){const collection=key(),nftProgram=key();return {program:key(),collection,nftProgram,registry:PublicKey.findProgramAddressSync([Buffer.from('registry'),collection.toBuffer()],nftProgram)[0],authority:key(),treasury:key(),provider:key(),providerTreasury:key(),price:30_000_000,window:100,timeout:100,definitions:[{id:0,name:'Blue hair',uri:'https://example.invalid/trait',hash:'12'.repeat(32),slot:0,bodyMask:1,supply:4}]};}
function poolAccount(spec){const data=Buffer.alloc(4352);data.write('NUBSALE5');for(const [field,offset]of [['authority',8],['collection',40],['treasury',72],['provider',104],['providerTreasury',136]])spec[field].toBuffer().copy(data,offset);Buffer.from(sha256(validateCatalog(spec.definitions))).copy(data,168);data.writeBigUInt64LE(BigInt(spec.price),200);data[208]=spec.definitions.length;data[209]=4;data.writeBigUInt64LE(BigInt(spec.window),210);data.writeBigUInt64LE(BigInt(spec.timeout),218);data[254]=1;spec.registry.toBuffer().copy(data,255);spec.nftProgram.toBuffer().copy(data,287);return {owner:spec.program,data};}
function storage(){const objects=new Map(),state={writes:0};return {objects,state,context:{gateway:'http://127.0.0.1:4560',owner:'11111111111111111111111111111111',expectedGenesis:'test-local',connection:{getGenesisHash:async()=> 'test-local'},saveCheckpoint:async()=>{},writeArtifact:async bytes=>{state.writes++;const signature=bs58.encode(randomBytes(64));objects.set(signature,Buffer.from(bytes));return signature;},readArtifact:async signature=>objects.get(signature)}};}

test('paid creator setup rejects a zero price before issuing any plan',()=>{const spec=draft();assert.doesNotThrow(()=>catalogSetup(spec,null));assert.throws(()=>catalogSetup({...spec,price:0},null),/price/i);});
test('resume rejects a program-owned header whose definition count differs from the draft',()=>{const spec=draft(),existing=poolAccount(spec);assert.doesNotThrow(()=>catalogSetup(spec,existing));existing.data[208]=2;assert.throws(()=>catalogSetup(spec,existing));});
test('positive supply must fit at least one dressable collection item',async()=>{const f=await fixture();try{f.input.definitions[0].bodyMask=2;await assert.rejects(prepareRenderKit(f.input,f.root));}finally{await f.stop();}});
test('reserved image filenames are rejected before any publication',async()=>{const f=await fixture(),s=storage();try{await writeFile(path.join(f.root,'__proto__'),await readFile(path.join(f.root,'body.png')));f.input.config.groups[1].assets[0].file='__proto__';await assert.rejects(prepareRenderKit(f.input,f.root),/relative|reserved|filename/i);assert.equal(s.state.writes,0);}finally{await f.stop();}});
test('a serialized or mutated validated kit cannot cause unrelated file publication',async()=>{const f=await fixture(),s=storage();try{const kit=await prepareRenderKit(f.input,f.root);await assert.rejects(publishRenderKit(JSON.parse(JSON.stringify(kit)),f.root,s.context,{}),/Revalidate/);kit.files[0].file='not-an-approved-source.json';await assert.rejects(publishRenderKit(kit,f.root,s.context,{}),/Revalidate/);assert.equal(s.state.writes,0);}finally{await f.stop();}});
test('an explicitly selected base cover is published while other base images stay excluded',async()=>{const f=await fixture(),s=storage();try{const kit=await prepareRenderKit(f.input,f.root);const published=await publishRenderKit(kit,f.root,s.context,{});const manifest=JSON.parse(s.objects.get(published.renderKit));assert(Object.hasOwn(manifest.media,'base/1.png'));assert(published.appearance.cover);assert.equal(manifest.edition.items[0].file,undefined);}finally{await f.stop();}});

test('a sealed pool cannot satisfy a draft for a different NFT program',()=>{const spec=draft(),existing=poolAccount(spec);const encoded=validateCatalog(spec.definitions);encoded.copy(existing.data,384);existing.data[250]=1;existing.data[251]=1;assert.deepEqual(catalogSetup(spec,existing),[]);const nftProgram=key(),registry=PublicKey.findProgramAddressSync([Buffer.from('registry'),spec.collection.toBuffer()],nftProgram)[0];assert.throws(()=>catalogSetup({...spec,nftProgram,registry},existing));});
