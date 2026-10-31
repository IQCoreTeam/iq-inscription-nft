import{test}from'node:test';import assert from'node:assert/strict';import{Keypair}from'@solana/web3.js';import{assertPackDeployment}from'../protocol.mjs';import{publishPackSetup}from'../creator.mjs';
const key=()=>Keypair.generate().publicKey.toBase58();
test('server terms cannot redirect creator signing to another program, provider or collection',()=>{
 const deployment={program:key(),nftProgram:key(),provider:key(),providerTreasury:key()},collection=key(),spec={...deployment,collection};assert.doesNotThrow(()=>assertPackDeployment(spec,deployment,collection));
 for(const field of Object.keys(deployment))assert.throws(()=>assertPackDeployment({...spec,[field]:key()},deployment,collection),/program or provider changed/);
 assert.throws(()=>assertPackDeployment({...spec,collection:key()},deployment,collection),/collection changed/);assert.throws(()=>assertPackDeployment(spec,null,collection),/Verified pack deployment/);
});
test('creator setup fails before any wallet/RPC interaction when deployment is missing or mismatched',async()=>{
 const deployment={program:key(),nftProgram:key()},collection=key(),setup={spec:{...deployment,program:key(),collection}};
 await assert.rejects(()=>publishPackSetup({setup,deployment,expectedCollection:collection}),/program or provider changed/);
 await assert.rejects(()=>publishPackSetup({setup}),/Verified pack deployment/);
});

test('outfit consent pins the selected NFT before any RPC or wallet interaction',async()=>{
 const {enableOutfits}=await import('../outfits.mjs');
 const deployment={program:key(),nftProgram:key()},collection=key(),asset=key(),context={...deployment,collection,asset};
 await assert.rejects(()=>enableOutfits({context,deployment,collection,expectedAsset:key()}),/Selected NFT changed/);
 await assert.rejects(()=>enableOutfits({context,deployment,collection}),/Selected NFT changed/);
});
