import { readFile,stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { validateTraitRules } from './catalog.mjs';
import { validateRenderConfig,loadPngSource,resolveAssetPath } from '../service/render-engine.mjs';
import { selectFinalArt } from '../service/final-art-selection.mjs';

const preparedKits=new WeakMap();
export function assertPreparedKit(kit){if(!preparedKits.has(kit)||preparedKits.get(kit)!==JSON.stringify(kit))throw Error('Revalidate the pack kit before publishing');}

// Imported project objects are not publication manifests. Reject unknown fields
// before cloning or I/O, so notes/credentials cannot ride along into public R.
function kitSchema(input) {
  const object=(value,fields,label)=>{
    if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw Error('Invalid '+label);
    if(Reflect.ownKeys(value).some(key=>typeof key!=='string'||!fields.includes(key)))throw Error('Unsupported field in '+label);
  };
  const strings=(value,fields,label)=>{for(const field of fields)if(value[field]!==undefined&&typeof value[field]!=='string')throw Error('Invalid text in '+label);};
  const integers=(value,fields,label)=>{for(const field of fields)if(value[field]!==undefined&&!Number.isInteger(value[field]))throw Error('Invalid number in '+label);};
  object(input,['schema','config','items','definitions','slotGroups','appearance'],'pack kit');
  object(input.config,['seed','count','name','description','canvas','groups','outputFormat'],'render config');
  const config=input.config;
  strings(config,['seed','name','description','outputFormat'],'render config');integers(config,['count'],'render config');
  object(config.canvas,['width','height'],'canvas');integers(config.canvas,['width','height'],'canvas');
  if(!Array.isArray(config.groups)||!Array.isArray(input.items)||!Array.isArray(input.definitions))throw Error('Invalid pack-kit lists');
  const groupNames=config.groups.map(group=>group?.name);
  for(const group of config.groups){
    object(group,['name','role','emitTrait','assets'],'layer group');strings(group,['name','role'],'layer group');
    if(group.emitTrait!==undefined&&typeof group.emitTrait!=='boolean'||!Array.isArray(group.assets))throw Error('Invalid layer group');
    for(const asset of group.assets){
      object(asset,['id','file','label','weight','count','requires','excludes','fixedAttributes','registration','occlusion'],'layer asset');
      strings(asset,['id','label'],'layer asset');
      if(asset.file!==null&&typeof asset.file!=='string')throw Error('Invalid layer image reference');
      if(asset.weight!==undefined&&(typeof asset.weight!=='number'||!Number.isFinite(asset.weight)))throw Error('Invalid layer weight');
      integers(asset,['count'],'layer asset');
      for(const rule of ['requires','excludes'])if(asset[rule]!==undefined){
        object(asset[rule],groupNames,'compatibility rule');
        for(const ids of Object.values(asset[rule]))if(!Array.isArray(ids)||ids.some(id=>typeof id!=='string'))throw Error('Invalid compatibility choices');
      }
      if(asset.registration!==undefined){
        object(asset.registration,['source','target'],'registration');
        for(const side of ['source','target']){object(asset.registration[side],['left','top','width','height'],'registration rectangle');integers(asset.registration[side],['left','top','width','height'],'registration rectangle');}
      }
      if(asset.occlusion!==undefined){object(asset.occlusion,['targetGroup','maskFile'],'occlusion');strings(asset.occlusion,['targetGroup','maskFile'],'occlusion');}
      if(asset.fixedAttributes!==undefined){
        if(!Array.isArray(asset.fixedAttributes))throw Error('Invalid fixed attributes');
        for(const attribute of asset.fixedAttributes){object(attribute,['trait_type','value'],'fixed attribute');strings(attribute,['trait_type','value'],'fixed attribute');if(typeof attribute.trait_type!=='string'||typeof attribute.value!=='string')throw Error('Invalid fixed attribute');}
      }
    }
  }
  object(input.slotGroups,['0','1','2','3','4','5'],'slot mapping');strings(input.slotGroups,['0','1','2','3','4','5'],'slot mapping');
  for(const item of input.items){
    object(item,['index','name','bodyClass','dressable','file','sha256','sourceDna'],'item recipe');strings(item,['name','file','sha256'],'item recipe');integers(item,['index'],'item recipe');
    if(item.bodyClass!==undefined&&item.bodyClass!==null&&!Number.isInteger(item.bodyClass)||typeof item.dressable!=='boolean')throw Error('Invalid item recipe');
    if(item.sourceDna!==undefined&&item.sourceDna!==null&&(!Array.isArray(item.sourceDna)||item.sourceDna.some(id=>typeof id!=='string')))throw Error('Invalid item layer selection');
  }
  for(const definition of input.definitions){
    object(definition,['id','name','sourceId','slot','bodyMask','supply','creatorTier','requiredSlot','requiredDefinition'],'trait definition');strings(definition,['name','sourceId','creatorTier'],'trait definition');integers(definition,['id','slot','bodyMask','supply','requiredSlot','requiredDefinition'],'trait definition');
  }
  if(input.appearance!==undefined&&input.appearance!==null){
    object(input.appearance,['title','subtitle','accent','coverFile','logoFile'],'pack appearance');strings(input.appearance,['title','subtitle','accent'],'pack appearance');
    for(const field of ['coverFile','logoFile'])if(input.appearance[field]!==undefined&&input.appearance[field]!==null&&typeof input.appearance[field]!=='string')throw Error('Invalid pack artwork reference');
  }
}

// Normal collections return before touching disk. Enabled collections must
// bring actual reusable layers and per-item recipes, not just flattened art.
export async function prepareRenderKit(input,assetRoot) {
  if(input===null)return null;
  if(!input||input.schema!=='iq-trait-kit/1')throw Error('Unsupported trait-kit schema');
  kitSchema(input);
  const draft=structuredClone(input),{config,items,definitions,slotGroups}=draft;
  if(!Array.isArray(items)||!items.length||items.length>10000||config?.count!==items.length)throw Error('The kit needs a recipe entry for every collection item');
  validateRenderConfig(config);validateTraitRules(definitions);
  if(!slotGroups||typeof slotGroups!=='object'||Array.isArray(slotGroups))throw Error('Choose the wearable layer for each used slot');
  const assets=new Map(),mappedGroups=new Set(),reserved=new Set(['__proto__','constructor','prototype']);
  for(const group of config.groups){
    if(typeof group.name!=='string'||reserved.has(group.name))throw Error('Invalid layer group name');
    for(const asset of group.assets){if(typeof asset.id!=='string'||reserved.has(asset.id))throw Error('Invalid source asset id');assets.set(asset.id,{asset,group});}
  }
  if(assets.size>96)throw Error('This kit exceeds the 96-source-layer review budget');
  for(const [slot,name]of Object.entries(slotGroups)){
    const group=config.groups.find(group=>group.name===name);
    if(!/^[0-5]$/.test(slot)||!group||mappedGroups.has(name)||(Number(slot)===4?group.role!=='background':!['overlay','underlay'].includes(group.role)))throw Error('A wearable slot cannot replace the character identity layer');
    mappedGroups.add(name);
  }
  for(const definition of definitions){
    const source=assets.get(definition.sourceId);
    if(!source||source.group.name!==slotGroups[definition.slot]||source.asset.file===null)throw Error('Trait source does not belong to its equipment slot');
    if(definition.creatorTier!==undefined&&!['common','rare','epic','legendary'].includes(definition.creatorTier))throw Error('Unknown creator rarity tier');
  }
  const media=new Map(),sourceHashes=Object.create(null),maskSourceHashes=Object.create(null);let sourcePixels=0,sourceBytes=0;
  async function imageFile(file,kind){
    if(typeof file!=='string'||!file||file.startsWith('/')||file.includes('\\')||file.split('/').some(part=>!part||part==='..'||part.startsWith('.')||reserved.has(part)))throw Error('Images need plain relative file names');
    if(media.has(file))return media.get(file);
    const actual=await resolveAssetPath(file,assetRoot),info=await stat(actual);
    if(info.size>20_000_000)throw Error('A source image exceeds 20 MB');
    const bytes=await readFile(actual),metadata=await sharp(bytes,{limitInputPixels:16_777_216}).metadata();
    await sharp(bytes,{limitInputPixels:16_777_216}).stats();
    if(!['png','webp'].includes(metadata.format)||metadata.pages>1)throw Error('Use static PNG or WebP images');
    const result={file,kind,mime:metadata.format==='png'?'image/png':'image/webp',sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,width:metadata.width,height:metadata.height};
    media.set(file,result);return result;
  }
  for(const {asset,group}of assets.values()){
    if(asset.file===null)continue;
    const entry=await imageFile(asset.file,'layer');
    sourcePixels+=entry.width*entry.height;sourceBytes+=entry.bytes;
    if(sourcePixels>64_000_000||sourceBytes>64_000_000)throw Error('The layer set exceeds its decoded-image or source-byte budget');
    const source=await loadPngSource(asset.file,assetRoot,{transparent:group.role!=='background'});sourceHashes[asset.id]=source.sha256;
    if(asset.occlusion){
      const mask=await imageFile(asset.occlusion.maskFile,'mask');
      if(!Object.hasOwn(maskSourceHashes,mask.file)){sourcePixels+=mask.width*mask.height;sourceBytes+=mask.bytes;if(sourcePixels>64_000_000||sourceBytes>64_000_000)throw Error('The mask set exceeds its source budget');}
      const verified=await loadPngSource(asset.occlusion.maskFile,assetRoot,{transparent:true,canvas:config.canvas});maskSourceHashes[mask.file]=verified.sha256;
    }
  }
  const appearance=draft.appearance??{},title=appearance.title??'Trait Booster',subtitle=appearance.subtitle??'';
  if(typeof title!=='string'||!title.trim()||[...title].length>40||typeof subtitle!=='string'||[...subtitle].length>80||/[\x00-\x1f]/.test(title+subtitle))throw Error('Use a short plain-text pack title and subtitle');
  if(appearance.accent!==undefined&&!/^#[0-9a-fA-F]{6}$/.test(appearance.accent))throw Error('Use a six-digit accent colour');
  if(appearance.coverFile)await imageFile(appearance.coverFile,'cover');
  if(appearance.logoFile)await imageFile(appearance.logoFile,'logo');
  const checked=new Set(),relevant=new Set();let combinations=0;
  for(const group of config.groups)for(const asset of group.assets)for(const rule of ['requires','excludes'])for(const target of Object.keys(asset[rule]??{})){relevant.add(group.name);relevant.add(target);}
  const edition=[];
  for(const [position,item]of items.entries()){
    if(item.index!==position+1||typeof item.dressable!=='boolean'||(item.dressable&&(!Number.isInteger(item.bodyClass)||item.bodyClass<0||item.bodyClass>7)))throw Error('Each item needs its index, body class and explicit outfit eligibility');
    const base=await imageFile(item.file,'base');
    if(base.width!==config.canvas.width||base.height!==config.canvas.height)throw Error('Base image dimensions do not match the layer canvas');
    if(base.sha256!==item.sha256)throw Error('Base image hash does not match its recipe');
    if(item.dressable){
      if(!Array.isArray(item.sourceDna))throw Error('Flattened art has no editable layer recipe');
      selectFinalArt(config,item.sourceDna);
      const signature=JSON.stringify([item.bodyClass,...config.groups.flatMap((group,index)=>relevant.has(group.name)?[item.sourceDna[index]]:[])]);
      if(relevant.size&&!checked.has(signature)){
        checked.add(signature);
        const choices=Array.from({length:6},(_,slot)=>[null,...definitions.filter(definition=>definition.slot===slot&&definition.supply>0&&(definition.bodyMask&(1<<item.bodyClass)))]);
        const visit=(slot,selected)=>{
          if(slot<6){for(const choice of choices[slot])visit(slot+1,[...selected,choice]);return;}
          if(selected.some(definition=>definition&&(definition.requiredSlot??255)!==255&&selected[definition.requiredSlot]?.id!==definition.requiredDefinition))return;
          if(++combinations>100000)throw Error('Compatibility review exceeded its budget; simplify the kit or split body classes');
          const overrides=Object.fromEntries(selected.filter(Boolean).map(definition=>[slotGroups[definition.slot],definition.sourceId]));
          try{selectFinalArt(config,item.sourceDna,overrides);}catch{throw Error('An allowed equipment combination cannot render; correct its prerequisites or body compatibility');}
        };
        visit(0,[]);
      }
    }
    edition.push({id:item.index,name:item.name,bodyClass:item.dressable?item.bodyClass:null,dressable:item.dressable,sha256:base.sha256,file:item.file,sourceDna:item.dressable?JSON.stringify(item.sourceDna):null});
  }
  if(!edition.some(item=>item.dressable))throw Error('A trait-enabled collection needs at least one compatible item');
  for(const definition of definitions)if(definition.supply>0&&!edition.some(item=>item.dressable&&(definition.bodyMask&(1<<item.bodyClass))))throw Error('An issued trait fits no eligible item in this collection');
  const result={schema:'iq-trait-kit/1',config,edition:{sourceHashes,maskSourceHashes,items:edition},catalog:{schema:'iq-trait-kit/1',slotGroups,definitions},appearance:{title:title.trim(),subtitle:subtitle.trim(),accent:appearance.accent??'#00ef00',coverFile:appearance.coverFile??null,logoFile:appearance.logoFile??null},files:[...media.values()],compatibilityChecks:combinations};
  preparedKits.set(result,JSON.stringify(result));return result;
}
