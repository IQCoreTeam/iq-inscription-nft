import{test}from'node:test';import assert from'node:assert/strict';import{Keypair,Transaction}from'@solana/web3.js';import bs58 from'bs58';import*as built from'../dist/browser.js';
test('built browser artifact decodes consent and signs the exact purchase wire message',async()=>{
 const payer=Keypair.generate(),program=Keypair.generate().publicKey,collection=Keypair.generate().publicKey,asset=Keypair.generate().publicKey,signature=bs58.encode(Keypair.generate().secretKey);
 const consent=built.outfitConsentInstructions({program,nftProgram:program,collection,admin:payer.publicKey,owner:payer.publicKey,asset,inscription:signature,bodyClass:0,metadataUri:'http://127.0.0.1/wardrobe/metadata/'+asset});assert.equal(consent.length,2);
 const account={address:payer.publicKey.toBase58(),publicKey:payer.publicKey.toBytes(),chains:['solana:localnet'],features:['solana:signTransaction']};
 const wallet={accounts:[account],chains:['solana:localnet'],features:{'solana:signTransaction':{supportedTransactionVersions:['legacy'],async signTransaction(input){const tx=Transaction.from(input.transaction);tx.partialSign(payer);return[{signedTransaction:tx.serialize()}];}}}};
 let sent=0;const connection={getGenesisHash:async()=> 'local',getLatestBlockhash:async()=>({blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:1}),simulateTransaction:async()=>({value:{err:null}}),sendRawTransaction:async bytes=>{sent++;return bs58.encode(Transaction.from(bytes).signature);},confirmTransaction:async()=>({value:{err:null}})};
 const transaction=new built.Transaction().add(built.packPurchase(program,collection,payer.publicKey,0,0,105000000));
 const landed=await built.sendWalletTransaction({wallet,account,connection,transaction,chain:'solana:localnet',localGenesis:'local'});assert.equal(typeof landed,'string');assert.equal(sent,1);
});
test('built browser consent rejects a different selected NFT before RPC or signing',async()=>{
 const key=()=>Keypair.generate().publicKey.toBase58();
 const deployment={program:key(),nftProgram:key()},collection=key();
 await assert.rejects(()=>built.enableOutfits({context:{...deployment,collection,asset:key()},deployment,collection,expectedAsset:key()}),/Selected NFT changed/);
});
