// Private final-edition renderer: on-chain gear IDs select existing Nubbies layers.
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {renderCollection} from './render-engine.mjs';
import {selectFinalArt,singleFinalArtConfig} from './final-art-selection.mjs';

export async function createCuratedRenderer(artRoot){
 if(!artRoot)throw Error('A verified private render-kit root is required');
 const config=JSON.parse(await readFile(path.join(artRoot,'config.json'),'utf8'));
 const edition=JSON.parse(await readFile(path.join(artRoot,'edition.json'),'utf8'));
 const proposal=JSON.parse(await readFile(path.join(artRoot,'catalog.json'),'utf8'));
 const root=await mkdtemp(path.join(tmpdir(),'nubbies-paid-render-'));
 const cache=new Map(),slotGroup={0:'Hair',1:'Clothing',2:'Headwear',4:'Background',5:'Border'};
 const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
 let next=0;
 async function image(avatar){
  if(!avatar.originalBasePreserved)throw Error('Base NFT identity changed; outfit render paused');
  const id=avatar.sourceEditionId,base=edition.items[id-1];
  if(!base)throw Error('Unknown Nubbies edition');
  if(!Array.isArray(avatar.definitions)||avatar.definitions.length!==6)throw Error('Incomplete on-chain loadout');
  const key=avatar.address+':'+avatar.revision+':'+id+':'+avatar.definitions.join(',');
  if(cache.has(key))return cache.get(key);
  const work=(async()=>{
   if(avatar.definitions.every(value=>value===255)){
    const bytes=await readFile(path.join(artRoot,'base',id+'.webp'));
    if(digest(bytes)!==base.sha256)throw Error('Final base image changed');
    return {image:bytes};
   }
   if(!base.sourceDna||!['modular-broad','modular-restricted'].includes(base.family))throw Error('This edition has no interchangeable layer recipe');
   const overrides={};
   for(const [slot,value] of avatar.definitions.entries()){
    if(value===255)continue;
    const def=proposal.definitions[value];
    if(!def||def.id!==value||def.slot!==slot||!slotGroup[slot])throw Error('Unknown on-chain trait definition');
    overrides[slotGroup[slot]]=def.sourceId;
   }
   const chosen=selectFinalArt(config,JSON.parse(base.sourceDna),overrides);
   const target=path.join(root,String(next++));
   try{
    const rendered=await renderCollection(singleFinalArtConfig(config,chosen,'nubbies-live-outfit:'+key),artRoot,target);
    const pins=edition.families.find(family=>family.id===base.family)?.sourceHashes;
    for(const [sourceId,hash] of Object.entries(rendered.sourceHashes))if(pins?.[sourceId]!==hash)throw Error('Final layer changed: '+sourceId);
    return {image:await readFile(path.join(target,'1.webp'))};
   }finally{await rm(target,{recursive:true,force:true});}
  })();
  cache.set(key,work);
  if(cache.size>64)cache.delete(cache.keys().next().value);
  try{return await work;}catch(error){cache.delete(key);throw error;}
 }
 async function base(id,extension){
  if(!Number.isInteger(id)||id<1||id>edition.items.length||!['webp','json'].includes(extension))throw Error('Invalid edition file');
  return readFile(path.join(artRoot,'base',id+'.'+extension));
 }
 return {image,base,stop:()=>rm(root,{recursive:true,force:true})};
}
