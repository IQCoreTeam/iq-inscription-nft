// One selection path for private trait review and the offline wardrobe preview.
export function isFinalArtCompatible(chosen){
 return Object.values(chosen).every(asset=>
  Object.entries(asset.requires||{}).every(([group,allowed])=>allowed.includes(chosen[group]?.id))&&
  Object.entries(asset.excludes||{}).every(([group,blocked])=>!blocked.includes(chosen[group]?.id)));
}

export function selectFinalArt(config,baseIds,overrides={}){
 if(baseIds.length!==config.groups.length)throw Error('Final art DNA does not match the layer catalog');
 const chosen=Object.fromEntries(config.groups.map((group,index)=>{
  const id=overrides[group.name]??baseIds[index],asset=group.assets.find(item=>item.id===id);
  if(!asset)throw Error('Unknown final-art layer '+group.name+': '+id);
  return [group.name,asset];
 }));
 if(!isFinalArtCompatible(chosen))throw Error('Incompatible final-art selection');
 return chosen;
}

export function singleFinalArtConfig(config,chosen,seed){
 const groups=config.groups.map(group=>{
  const selected=chosen[group.name];
  const requires=Object.fromEntries(Object.entries(selected.requires||{}).map(([target,ids])=>{
   if(!ids.includes(chosen[target]?.id))throw Error('Incompatible required layer');
   return [target,[chosen[target].id]];
  }));
  const {excludes,...asset}=selected;
  return {...group,assets:[{...asset,requires,count:1}]};
 });
 return {...config,count:1,seed,groups};
}
