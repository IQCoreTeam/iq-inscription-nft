// Conservative funding cap, using the existing application's IQ cost model.
// These are funding bounds, not fees or quoted sale prices. Unused SOL sweeps.
export function mediaFundingBudget(kit,accountRent,estimateCost){
 const files=kit.files.filter(file=>file.kind!=='base'||file.file===kit.appearance.coverFile||file.file===kit.appearance.logoFile);
 const sizes=files.map(file=>Math.ceil(file.bytes*4/3)+512);
 sizes.push(new TextEncoder().encode(JSON.stringify(kit)).length+files.length*1024+4096);
 sizes.push(...kit.catalog.definitions.map(()=>4096));
 const target=sizes.reduce((sum,size,index)=>sum+estimateCost(size,{accountRent:index?0:accountRent}).total+Math.ceil(size/500)*5000,0);
 if(!Number.isSafeInteger(target)||target<=0)throw Error('Invalid pack media funding estimate');
 return target;
}
