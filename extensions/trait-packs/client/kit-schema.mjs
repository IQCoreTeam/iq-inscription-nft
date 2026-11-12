export function validateKitSchema(input) {
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
