import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFile,writeFile,mkdir,mkdtemp,rename,rm,access,realpath} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const sharp=createRequire(import.meta.url)('sharp');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
// Master layers and full-canvas occlusion masks share file/PNG/alpha validation.
export async function loadPngSource(fileName,assetRoot,{transparent=false,canvas}={}) {
  const root=await realpath(assetRoot),file=path.resolve(root,fileName);
  const inside=p=>{const relative=path.relative(root,p);return relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);};
  if(!inside(file))throw Error('Asset outside configured root.');
  const actual=await realpath(file);if(!inside(actual))throw Error('Asset outside configured root.');
  const bytes=await readFile(actual),metadata=await sharp(bytes).metadata();
  if(metadata.format!=='png'||metadata.pages>1)throw Error('Master layers and masks must be static PNG.');
  if(canvas&&(metadata.width!==canvas.width||metadata.height!==canvas.height))throw Error('Occlusion mask must match canvas dimensions.');
  if(transparent) {
    const stats=await sharp(bytes).stats();
    if(!metadata.hasAlpha||stats.channels.at(-1).min!==0||stats.channels.at(-1).max===0)throw Error('Transparent layers and masks need real transparency.');
  }
  return {bytes,metadata,sha256:hash(bytes)};
}
export function plan(config) {
  if(!config.seed || !Number.isInteger(config.count) || config.count<1) throw Error('A seed and positive integer count are required.');
  if(config.outputFormat!==undefined&&!['png','webp'].includes(config.outputFormat))throw Error('Output format must be png or webp.');
  if(!config.canvas || ![config.canvas.width,config.canvas.height].every(n=>Number.isInteger(n)&&n>0&&n<=4096)) throw Error('Invalid canvas.');
  if(!Array.isArray(config.groups)||!config.groups.length) throw Error('No trait groups.');
  const characterIndex=config.groups.findIndex(g=>g.role==='character');
  if(config.groups[0].role!=='background'||characterIndex<1||config.groups.filter(g=>g.role==='background').length!==1||config.groups.filter(g=>g.role==='character').length!==1||config.groups.slice(1,characterIndex).some(g=>g.role!=='underlay')||config.groups.slice(characterIndex+1).some(g=>g.role!=='overlay')) throw Error('Use one background first, optional underlays, one coherent character bundle, then overlays.');
  const exact=config.groups.some(g=>g.assets?.some(a=>Object.hasOwn(a,'count')));
  if(exact&&config.count>10000)throw Error('Exact-count planning is bounded to 10000 items.');
  const names=new Set(),ids=new Set();
  for(const group of config.groups) {
    if(!group.name||names.has(group.name)||!group.assets?.length) throw Error('Invalid or duplicate trait group.');
    if(Object.hasOwn(group,'emitTrait')&&typeof group.emitTrait!=='boolean')throw Error('emitTrait must be boolean when provided.');
    names.add(group.name);
    if(group.assets.filter(a=>a.file===null).length>1)throw Error('An overlay group may have at most one None asset.');
    for(const asset of group.assets) {
      if(asset.file===null&&group.role!=='overlay')throw Error('Only overlay assets may use file: null for None.');
      if(!asset.id||ids.has(asset.id)||(asset.file!==null&&(typeof asset.file!=='string'||!asset.file.trim()))||!asset.label||(!exact&&(!(asset.weight>0)||!Number.isFinite(asset.weight)))) throw Error('Invalid or duplicate asset.');
      if(exact&&(!Number.isInteger(asset.count)||asset.count<0))throw Error('Exact-count mode requires a nonnegative integer count on every asset.');
      ids.add(asset.id);
    }
    if(exact&&new Set(group.assets.map(a=>a.label)).size!==group.assets.length)throw Error('Exact-count mode requires distinct labels within each group so metadata counts are unambiguous.');
    if(exact&&group.assets.reduce((n,a)=>n+a.count,0)!==config.count)throw Error('Exact counts in each group must sum to collection count.');
  }
  for(const group of config.groups)for(const asset of group.assets)for(const rule of ['requires','excludes']) {
    for(const [name,allowed] of Object.entries(asset[rule]||{})) {
      const target=config.groups.find(g=>g.name===name);
      if(!target||!Array.isArray(allowed)||!allowed.length||allowed.some(id=>!target.assets.some(a=>a.id===id))) throw Error('Invalid compatibility rule.');
    }
  }
  for(const [index,group] of config.groups.entries())for(const asset of group.assets)if(Object.hasOwn(asset,'occlusion')) {
    const mask=asset.occlusion,targetIndex=config.groups.findIndex(g=>g.name===mask?.targetGroup);
    if(group.role!=='overlay'||asset.file===null||!mask||typeof mask!=='object'||Array.isArray(mask)||Object.keys(mask).some(k=>!['targetGroup','maskFile'].includes(k))||typeof mask.maskFile!=='string'||!mask.maskFile.trim()||targetIndex<0||targetIndex>=index||config.groups[targetIndex].role!=='overlay')throw Error('Occlusion requires a visible overlay and an earlier overlay target.');
  }
  const compatible=chosen=>Object.values(chosen).every(asset=>
    Object.entries(asset.requires||{}).every(([group,allowed])=>allowed.includes(chosen[group].id))&&
    Object.entries(asset.excludes||{}).every(([group,blocked])=>!blocked.includes(chosen[group].id)));
  const dnaFor=chosen=>JSON.stringify(config.groups.map(g=>chosen[g.name].id));
  const capacity=config.groups.reduce((n,g)=>n*g.assets.filter(a=>!exact||a.count>0).length,1);
  if(capacity<config.count)throw Error('Requested '+config.count+' unique items, but only '+capacity+' combinations exist.');
  const combinations=[],seen=new Set();let counter=0;
  const roll=()=>Number.parseInt(hash(config.seed+'|'+counter++).slice(0,13),16)/2**52;
  if(exact) {
    // Quota decks preserve every count; bounded swaps seek unique compatible tuples.
    // Failure is a search-budget result, not a proof that arbitrary constraints are infeasible.
    for(const group of config.groups)for(const asset of group.assets) {
      const otherCapacity=config.groups.filter(g=>g!==group).reduce((n,g)=>n*g.assets.filter(a=>a.count>0).length,1);
      if(asset.count>otherCapacity)throw Error('Exact count for '+asset.id+' exceeds its unique combination capacity.');
    }
    const rows=Array.from({length:config.count},()=>({}));
    for(const group of config.groups) {
      const deck=group.assets.flatMap(a=>Array(a.count).fill(a));
      for(let i=deck.length-1;i>0;i--){const j=Math.floor(roll()*(i+1));[deck[i],deck[j]]=[deck[j],deck[i]];}
      for(let i=0;i<rows.length;i++)rows[i][group.name]=deck[i];
    }
    const dna=rows.map(dnaFor),multiplicity=new Map();
    for(const key of dna)multiplicity.set(key,(multiplicity.get(key)||0)+1);
    let conflicts=rows.filter(row=>!compatible(row)).length+[...multiplicity.values()].reduce((n,count)=>n+Math.max(0,count-1),0);
    const mutableGroups=config.groups.filter(g=>g.assets.filter(a=>a.count>0).length>1);
    const budget=Math.min(500000,Math.max(10000,config.count*200));let attempts=0;
    for(let sweep=0;sweep<16&&conflicts>0&&attempts<budget;sweep++) {
      let accepted=0;
      for(let i=0;i<rows.length&&conflicts>0&&attempts<budget;i++) {
        if(compatible(rows[i])&&multiplicity.get(dna[i])===1)continue;
        for(let trial=0;trial<80&&conflicts>0&&attempts<budget;trial++) {
          attempts++;
          if(!mutableGroups.length)break;
          const j=Math.floor(roll()*rows.length),group=mutableGroups[Math.floor(roll()*mutableGroups.length)].name;
          if(i===j||rows[i][group]===rows[j][group])continue;
          const oldA=dna[i],oldB=dna[j],oldIncompatible=Number(!compatible(rows[i]))+Number(!compatible(rows[j]));
          [rows[i][group],rows[j][group]]=[rows[j][group],rows[i][group]];
          const nextA=dnaFor(rows[i]),nextB=dnaFor(rows[j]),keys=new Set([oldA,oldB,nextA,nextB]);
          const beforeCounts=new Map([...keys].map(key=>[key,multiplicity.get(key)||0]));
          const before=oldIncompatible+[...beforeCounts.values()].reduce((n,count)=>n+Math.max(0,count-1),0);
          for(const key of [oldA,oldB])multiplicity.set(key,multiplicity.get(key)-1);
          for(const key of [nextA,nextB])multiplicity.set(key,(multiplicity.get(key)||0)+1);
          const after=Number(!compatible(rows[i]))+Number(!compatible(rows[j]))+[...keys].reduce((n,key)=>n+Math.max(0,multiplicity.get(key)-1),0);
          if(after<before||(after===before&&roll()<0.08)) {
            conflicts+=after-before;accepted++;dna[i]=nextA;dna[j]=nextB;
            for(const key of keys)if(multiplicity.get(key)===0)multiplicity.delete(key);
            if(compatible(rows[i])&&multiplicity.get(dna[i])===1)break;
          } else {
            [rows[i][group],rows[j][group]]=[rows[j][group],rows[i][group]];
            for(const [key,count] of beforeCounts)if(count)multiplicity.set(key,count);else multiplicity.delete(key);
          }
        }
      }
      if(!accepted)break;
    }
    // A complete Cartesian catalog has a direct solution when every active asset
    // requests its uniform share. This handles dense grids the swap search can miss.
    if(conflicts&&capacity===config.count&&config.groups.every(g=>g.assets.every(a=>a.count===0||a.count===config.count/g.assets.filter(x=>x.count>0).length))){
      let full=[{}];
      for(const group of config.groups)full=full.flatMap(row=>group.assets.filter(a=>a.count>0).map(asset=>({...row,[group.name]:asset})));
      if(full.every(compatible)){
        for(let i=full.length-1;i>0;i--){const j=Math.floor(roll()*(i+1));[full[i],full[j]]=[full[j],full[i]];}
        for(let i=0;i<rows.length;i++){rows[i]=full[i];dna[i]=dnaFor(full[i]);}
        conflicts=0;
      }
    }
    if(conflicts)throw Error('Exact-count planner could not find unique compatible recipes within its bounded search budget; feasibility is unproven. Adjust quotas or compatibility.');
    // Certify actual output rather than trusting the repair counter.
    if(new Set(dna).size!==config.count||rows.some(row=>!compatible(row)))throw Error('Exact-count certification failed.');
    for(const group of config.groups)for(const asset of group.assets)if(rows.filter(row=>row[group.name]===asset).length!==asset.count)throw Error('Exact-count certification failed.');
    return rows.map((chosen,i)=>({dna:dna[i],chosen}));
  }
  for(let attempt=0;combinations.length<config.count&&attempt<Math.max(10000,config.count*100);attempt++) {
    const chosen={};
    for(const group of config.groups) {
      let ticket=roll()*group.assets.reduce((n,a)=>n+a.weight,0);
      chosen[group.name]=group.assets.find(a=>{ticket-=a.weight;return ticket<0;})||group.assets.at(-1);
    }
    const dna=dnaFor(chosen);
    if(compatible(chosen)&&!seen.has(dna)){seen.add(dna);combinations.push({dna,chosen});}
  }
  if(combinations.length<config.count)throw Error('Requested '+config.count+' unique items; found only '+combinations.length+' compatible combinations within the bounded sampling budget. Check compatibility, weights and supply.');
  return combinations;
}
export async function renderCollection(config,assetRoot,outDir) {
  const recipes=plan(config);
  const format=config.outputFormat??'webp';
  try {await access(outDir);throw Error('Output already exists; use a new versioned folder.');} catch(e){if(e.code!=='ENOENT')throw e;}
  const loaded=new Map(),sources={},masks=new Map();
  for(const group of config.groups)for(const asset of group.assets) {
    if(asset.count===0||asset.file===null)continue;
    const {bytes,metadata,sha256}=await loadPngSource(asset.file,assetRoot,{transparent:group.role!=='background'});
    let layer;
    if(asset.registration) {
      const {source,target}=asset.registration;
      const validRect=r=>r&&['left','top','width','height'].every(k=>Number.isInteger(r[k])&&r[k]>=(k==='width'||k==='height'?1:0));
      if(!validRect(source)||!validRect(target)||source.left+source.width>metadata.width||source.top+source.height>metadata.height||target.left+target.width>config.canvas.width||target.top+target.height>config.canvas.height)throw Error('Invalid layer registration.');
      const registered=await sharp(bytes).extract(source).resize(target.width,target.height,{fit:'fill'}).png().toBuffer();
      layer=await sharp({create:{width:config.canvas.width,height:config.canvas.height,channels:4,background:{r:0,g:0,b:0,alpha:0}}}).composite([{input:registered,left:target.left,top:target.top}]).png().toBuffer();
    } else layer=await sharp(bytes).resize(config.canvas.width,config.canvas.height,{fit:group.role==='background'?'cover':'contain',background:{r:0,g:0,b:0,alpha:0}}).png().toBuffer();
    loaded.set(asset.id,layer);sources[asset.id]=sha256;
    if(asset.occlusion&&!masks.has(asset.occlusion.maskFile))masks.set(asset.occlusion.maskFile,await loadPngSource(asset.occlusion.maskFile,assetRoot,{transparent:true,canvas:config.canvas}));
  }
  const outputs=[],imageHashes=new Set(),counts={},maskSources={},maskedLayers=new Map();
  await mkdir(path.dirname(outDir),{recursive:true});
  const stage=await mkdtemp(path.join(path.dirname(outDir),'.nubbies-stage-'));
  try {
  for(const [index,recipe] of recipes.entries()) {
    const selected=new Map(config.groups.filter(g=>recipe.chosen[g.name].file!==null).map(g=>[g.name,loaded.get(recipe.chosen[g.name].id)])),sequences=new Map();
    for(const group of config.groups) {
      const asset=recipe.chosen[group.name],rule=asset.occlusion;
      if(asset.file===null||!rule||!selected.has(rule.targetGroup))continue;
      const mask=masks.get(rule.maskFile),target=recipe.chosen[rule.targetGroup];
      const sequence=[...(sequences.get(rule.targetGroup)||[]),mask.sha256];sequences.set(rule.targetGroup,sequence);
      const key=JSON.stringify([target.id,...sequence]);
      if(!maskedLayers.has(key))maskedLayers.set(key,await sharp(selected.get(rule.targetGroup)).composite([{input:mask.bytes,blend:'dest-in'}]).png().toBuffer());
      selected.set(rule.targetGroup,maskedLayers.get(key));maskSources[rule.maskFile]=mask.sha256;
    }
    const layers=[...selected.values()].map(input=>({input}));
    const composite=sharp({create:{width:config.canvas.width,height:config.canvas.height,channels:4,background:{r:0,g:0,b:0,alpha:0}}}).composite(layers);
    const bytes=await (format==='png'?composite.png():composite.webp({quality:85})).toBuffer();
    const digest=hash(bytes);
    if(imageHashes.has(digest))throw Error('Different recipes produced identical images.');
    imageHashes.add(digest);
    const attributes=config.groups.filter(g=>g.emitTrait!==false).map(g=>({trait_type:g.name,value:recipe.chosen[g.name].label}));
    for(const asset of Object.values(recipe.chosen))for(const attribute of asset.fixedAttributes||[]) {
      if(typeof attribute.trait_type!=='string'||typeof attribute.value!=='string'||attributes.some(a=>a.trait_type===attribute.trait_type))throw Error('Invalid or duplicate fixed attribute.');
      attributes.push(attribute);
    }
    for(const attribute of attributes)counts[attribute.trait_type+': '+attribute.value]=(counts[attribute.trait_type+': '+attribute.value]||0)+1;
    const image=(index+1)+'.'+format;
    const metadata={name:config.name+' #'+(index+1),description:config.description,image,attributes,properties:{files:[{uri:image,type:'image/'+format}],category:'image'}};
    await writeFile(path.join(stage,image),bytes);
    const metadataFile=(index+1)+'.json';
    await writeFile(path.join(stage,metadataFile),JSON.stringify(metadata,null,2));
    outputs.push({image,metadata:metadataFile,dna:recipe.dna,sha256:digest,bytes:bytes.length});
  }
    const manifest={state:'local preview only; no mint or upload',seed:config.seed,canvas:config.canvas,sourceHashes:sources,...(Object.keys(maskSources).length?{maskSourceHashes:maskSources}:{}),actualTraitCounts:counts,rarityNote:config.groups.some(g=>g.assets.some(a=>Object.hasOwn(a,'count')))?'Explicit per-asset counts were certified for each trait group; counts do not represent medical prevalence.':'Selection weights are relative generation controls, not promised final percentages or medical prevalence.',items:outputs};
    await writeFile(path.join(stage,'preview-manifest.json'),JSON.stringify(manifest,null,2));
    await rename(stage,outDir);return manifest;
  } catch(e) {await rm(stage,{recursive:true,force:true});throw e;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const [file,out]=process.argv.slice(2);
  if(!file||!out)throw Error('Usage: node render-collection.mjs config.json NEW_OUTPUT_FOLDER');
  const config=JSON.parse(await readFile(file,'utf8'));
  const manifest=await renderCollection(config,path.dirname(path.resolve(file)),path.resolve(out));
  console.log(JSON.stringify({count:manifest.items.length,out,bytes:manifest.items.map(i=>i.bytes)},null,2));
}
