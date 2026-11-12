import {mkdir,mkdtemp,readFile,writeFile,rename,rm,lstat,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import bs58 from 'bs58';
import {createCuratedRenderer} from './renderer.mjs';
import {loadPngSource,resolveAssetPath,validateRenderConfig} from './render-engine.mjs';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const hashPattern=/^[a-f0-9]{64}$/;
const MAX_SOURCE_COUNT=192,MAX_SOURCE_BYTES=64_000_000,MAX_SOURCE_PIXELS=64_000_000,MAX_IMAGE_BYTES=20_000_000,MAX_METADATA_BYTES=8_000_000;
function relativeImage(file){
 if(typeof file!=='string'||file.length>240||!file||file.startsWith('/')||file.includes('\\')||/[\x00-\x1f]/.test(file)||file.split('/').some(part=>!part||part.startsWith('.')||['__proto__','prototype','constructor','config.json','edition.json','catalog.json'].includes(part))||!/\.(png|webp)$/i.test(file))throw Error('Permanent render source needs a plain relative PNG path');
 return file;
}
function imageBytes(raw,reference){
 if(!hashPattern.test(reference.sha256)||reference.mime!=='image/png')throw Error('Permanent render source hash or MIME changed');
 const bytes=Buffer.from(raw);if(bytes.length>28_000_000)throw Error('Permanent image envelope exceeds its budget');
 const value=JSON.parse(bytes.toString('utf8'));
 if(!value||typeof value!=='object'||Array.isArray(value)||value.kind!=='image'||typeof value.body!=='string')throw Error('Invalid permanent image envelope');
 const match=/^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(value.body);
 if(!match||match[1].length%4!==0)throw Error('Permanent image MIME or encoding changed');
 const image=Buffer.from(match[1],'base64');if(!image.length||image.length>MAX_IMAGE_BYTES||image.toString('base64')!==match[1]||digest(image)!==reference.sha256)throw Error('Permanent image bytes do not match the pinned source');
 return image;
}
function renderSources(kit){
 if(!kit||kit.schema!=='iq-trait-kit/1'||!Array.isArray(kit.files))throw Error('Verified permanent render kit is required');
 validateRenderConfig(kit.config);
 const required=new Map(),files=new Map(kit.files.map(entry=>[entry.file,entry]));
 if(files.size!==kit.files.length)throw Error('Conflicting render-source descriptors');
 const add=(file,hash,transparent,mask)=>{
  file=relativeImage(file);const entry=files.get(file);
  if(!entry||entry.sha256!==hash||!hashPattern.test(hash)||entry.mime!=='image/png')throw Error('Permanent source is missing or differs from the reviewed pins');
  const old=required.get(file);if(old&&old.entry.sha256!==hash)throw Error('Conflicting source-image pins');
  required.set(file,{entry,transparent:transparent||old?.transparent,mask:mask||old?.mask});
 };
 for(const group of kit.config.groups)for(const asset of group.assets){
  if(asset.file!==null)add(asset.file,kit.edition.sourceHashes[asset.id],group.role!=='background',false);
  if(asset.occlusion)add(asset.occlusion.maskFile,kit.edition.maskSourceHashes[asset.occlusion.maskFile],true,true);
 }
 if(!required.size||required.size>MAX_SOURCE_COUNT)throw Error('Permanent render source count exceeds its budget');
 return required;
}
function renderDescriptors(kit){
 const descriptor={config:kit.config,edition:kit.edition,catalog:{...kit.catalog,schema:'iq-trait-kit/1'}};
 const expected=new Map(Object.entries(descriptor).map(([name,value])=>[name+'.json',Buffer.from(JSON.stringify(value))]));
 if([...expected.values()].reduce((sum,bytes)=>sum+bytes.length,0)>MAX_METADATA_BYTES)throw Error('Permanent render metadata exceeds its budget');
 return {descriptor,expected};
}

// Apply the native renderer's existing recovery limits to the prepared kit
// before publication costs/signatures. Recovery calls the same check with the
// dimensions measured from permanent sources, rather than trusting cache data.
export function validateRenderableKit(kit){
 const required=renderSources(kit);let bytes=0,pixels=0;
 for(const {entry}of required.values()){
  if(!Number.isSafeInteger(entry.bytes)||entry.bytes<=0||entry.bytes>MAX_IMAGE_BYTES||!Number.isSafeInteger(entry.width)||entry.width<=0||!Number.isSafeInteger(entry.height)||entry.height<=0||!Number.isSafeInteger(entry.width*entry.height))throw Error('Render source dimensions or byte count are invalid');
  bytes+=entry.bytes;pixels+=entry.width*entry.height;
  if(bytes>MAX_SOURCE_BYTES||pixels>MAX_SOURCE_PIXELS)throw Error('Permanent render kit exceeds its source budget');
 }
 renderDescriptors(kit);
 return required;
}
function sources(verified){
 const {kit,recipe}=verified;
 if(recipe?.schema!==kit?.schema||typeof verified.renderKit!=='string'||!/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(verified.renderKit)||bs58.decode(verified.renderKit).length!==64)throw Error('Verified permanent render kit is required');
 const required=renderSources(kit);
 for(const [file,value]of required){
  const reference=recipe.media[file];
  if(!reference||reference.sha256!==value.entry.sha256||reference.mime!=='image/png'||typeof reference.signature!=='string'||!/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(reference.signature)||bs58.decode(reference.signature).length!==64)throw Error('Permanent source is missing or differs from the reviewed pins');
  value.reference=reference;
 }
 // Flat edition files are deliberately absent. Empty outfits use original C/M
 // via the existing view adapter; equipped outfits only need these shared PNGs.
 return required;
}

// readVerifiedPublishedKit binds the DB's reviewed terms, permanent R and sealed
// catalog. readArtifact is the existing same-cluster IQ/gateway cached reader.
// Disk is a disposable cache, never the only copy of collection source media.
export function createPublishedKitRenderer({cacheRoot,readVerifiedPublishedKit,readArtifact}){
 if(!cacheRoot)throw Error('A dedicated render cache root is required');
 const cache=new Map();let stopped=false;
 async function materialize(collection){
  const verified=await readVerifiedPublishedKit(collection),required=sources(verified);
  const {descriptor,expected}=renderDescriptors(verified.kit);
  const key=digest(JSON.stringify({renderKit:verified.renderKit,descriptor}));
  await mkdir(cacheRoot,{recursive:true});const parent=await realpath(cacheRoot),target=path.join(parent,key);
  async function verifyFiles(root){
   if((await lstat(root)).isSymbolicLink())throw Error('Render cache root must not be a symlink');
   for(const [file,bytes]of expected)if(!Buffer.from(await readFile(await resolveAssetPath(file,root))).equals(bytes))throw Error('Render cache metadata changed');
   const measured=new Map();
   for(const [file,{reference,transparent,mask}]of required){
    const actual=await resolveAssetPath(file,root),bytes=await readFile(actual);if(digest(bytes)!==reference.sha256)throw Error('Cached render source changed');
    const value=await loadPngSource(file,root,{transparent,...(mask?{canvas:verified.kit.config.canvas}:{})});
    measured.set(file,{bytes:bytes.length,width:value.metadata.width,height:value.metadata.height});
   }
   validateRenderableKit({...verified.kit,files:verified.kit.files.map(entry=>({...entry,...measured.get(entry.file)}))});
  }
  let exists=true;try{await lstat(target);}catch(error){if(error.code!=='ENOENT')throw error;exists=false;}
  if(!exists){
   const stage=await mkdtemp(path.join(parent,'.kit-'));let retained=false;
   try{
    let total=0;
    // Serial recovery intentionally bounds both memory and gateway concurrency.
    for(const [file,{reference}]of required){
     const bytes=imageBytes(await readArtifact(reference.signature),reference);total+=bytes.length;
     if(total>MAX_SOURCE_BYTES)throw Error('Permanent render kit exceeds its byte budget');
     const destination=path.join(stage,file);await mkdir(path.dirname(destination),{recursive:true});await writeFile(destination,bytes,{flag:'wx',mode:0o600});
    }
    for(const [file,bytes]of expected)await writeFile(path.join(stage,file),bytes,{flag:'wx',mode:0o600});
    await verifyFiles(stage);
    try{await rename(stage,target);retained=true;}catch(error){if(!['EEXIST','ENOTEMPTY'].includes(error.code))throw error;await verifyFiles(target);}
   }finally{if(!retained)await rm(stage,{recursive:true,force:true});}
  }else await verifyFiles(target);
  return {root:target,renderKit:verified.renderKit,renderer:await createCuratedRenderer(target)};
 }
 return {
  async forCollection(collection){
   if(stopped)throw Error('Published render cache is stopped');
   if(typeof collection!=='string'||!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(collection))throw Error('Invalid collection address');
   let work=cache.get(collection);
   if(work){const existing=await work;try{await lstat(existing.root);return existing;}catch(error){if(error.code!=='ENOENT')throw error;if(cache.get(collection)===work){const recovery=existing.renderer.stop().then(()=>materialize(collection));cache.set(collection,recovery);}work=cache.get(collection);}}
   if(!work){if(cache.size>=32)throw Error('Render collection cache exceeds its configured process bound');work=materialize(collection);cache.set(collection,work);}
   try{return await work;}catch(error){if(cache.get(collection)===work)cache.delete(collection);throw error;}
  },
  async stop(){stopped=true;await Promise.all([...cache.values()].map(async work=>{try{await(await work).renderer.stop();}catch{}}));cache.clear();},
 };
}
