import{sha256}from'@noble/hashes/sha256';import{Buffer}from'buffer';import{validateKitSchema}from'./kit-schema.mjs';
function terms(input){
 if(input.edition)return {config:input.config,slotGroups:input.catalog.slotGroups,definitions:input.catalog.definitions,items:input.edition.items,appearance:input.appearance};
 validateKitSchema(input);const appearance=input.appearance??{};
 return {config:input.config,slotGroups:input.slotGroups,definitions:input.definitions,items:input.items.map(item=>({id:item.index,name:item.name,bodyClass:item.dressable?item.bodyClass:null,dressable:item.dressable,sha256:item.sha256,file:item.file,sourceDna:item.dressable?JSON.stringify(item.sourceDna):null})),appearance:{title:(appearance.title??'Trait Booster').trim(),subtitle:(appearance.subtitle??'').trim(),accent:appearance.accent??'#00ef00',coverFile:appearance.coverFile??null,logoFile:appearance.logoFile??null}};
}
export function reviewedKitDigest(input){return Buffer.from(sha256(new TextEncoder().encode(JSON.stringify(terms(input))))).toString('hex');}
export function assertReviewedKit(input,kit){
 if(kit.schema!==input.schema||reviewedKitDigest(input)!==reviewedKitDigest(kit))throw Error('The publication plan differs from the reviewed recipe');
 if(Object.keys(kit.edition).some(key=>!['items','sourceHashes','maskSourceHashes'].includes(key)))throw Error('The publication plan contains unreviewed fields');
 const names=new Set(),layers={},masks={};
 for(const group of input.config.groups)for(const asset of group.assets){if(asset.file)names.add(asset.file);if(asset.occlusion)names.add(asset.occlusion.maskFile);}
 for(const item of input.items)names.add(item.file);for(const field of ['coverFile','logoFile'])if(input.appearance?.[field])names.add(input.appearance[field]);
 const files=new Map(kit.files.map(file=>[file.file,file]));if(files.size!==names.size||kit.files.length!==files.size||kit.files.some(file=>!names.has(file.file)||!['image/png','image/webp'].includes(file.mime)))throw Error('The publication plan contains unreviewed source images');
 for(const group of input.config.groups)for(const asset of group.assets){if(asset.file){if(files.get(asset.file)?.kind==='base')throw Error('A reviewed layer cannot be hidden as a base');layers[asset.id]=files.get(asset.file).sha256;}if(asset.occlusion)masks[asset.occlusion.maskFile]=files.get(asset.occlusion.maskFile).sha256;}
 if(JSON.stringify(layers)!==JSON.stringify(kit.edition.sourceHashes)||JSON.stringify(masks)!==JSON.stringify(kit.edition.maskSourceHashes))throw Error('The publication source hashes changed');
 for(const item of input.items)if(files.get(item.file)?.sha256!==item.sha256)throw Error('The reviewed base image changed');
}
