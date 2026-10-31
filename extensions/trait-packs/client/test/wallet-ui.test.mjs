import {test} from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
import {mountPackWalletUI} from '../wallet-ui.mjs';
const {JSDOM}=process.env.IQ_STUDIO_TEST_DEPS?createRequire(process.env.IQ_STUDIO_TEST_DEPS+'/package.json')('jsdom'):await import('jsdom');
async function settle(){for(let i=0;i<8;i++)await new Promise(setImmediate);}
test('wallet UI uses host registry, displays fee, disconnects and blocks unresolved retry',async()=>{
 const dom=new JSDOM('<section></section>');const root=dom.window.document.querySelector('section');
 const account={address:'public-address',chains:['solana:devnet'],features:['solana:signTransaction']};let onChange;
 const wallet={name:'Test Wallet',chains:['solana:devnet'],accounts:[account],features:{'standard:connect':{connect:async()=>({accounts:[account]})},'standard:events':{on:(_,cb)=>{onChange=cb;return()=>{};}},'standard:disconnect':{disconnect:async()=>{}},'solana:signTransaction':{supportedTransactionVersions:['legacy']}}};
 let buys=0;const client={reconcilePurchase:async()=>({state:buys?'unresolved':'none',signature:'saved-signature'}),invalidate(){},readSale:async()=>({canPurchase:true,pool:{price:100000000,platformFee:5000000,totalPrice:105000000}}),purchase:async input=>{buys++;assert.equal(input.expectedTotal,105000000);throw Object.assign(Error('lost response'),{signature:'saved-signature'});}};
 const dispose=mountPackWalletUI(root,{registry:{get:()=>[wallet],on:()=>()=>{}},client,chain:'solana:devnet'});await settle();assert.equal(root.querySelector('select').selectedIndex,0);
 const button=name=>[...root.querySelectorAll('button')].find(b=>b.textContent===name);
 assert.match(root.textContent,/Creator 0.1 SOL \+ IQ 0.005 SOL = 0.105 SOL/);assert.equal(button('Buy pack').disabled,true);
 button('Connect wallet').click();await settle();assert.equal(button('Buy pack').disabled,false);assert.equal(button('Connect wallet').hidden,true);assert.equal(button('Disconnect').hidden,false);
 button('Buy pack').click();await settle();assert.equal(buys,1);assert.equal(button('Buy pack').disabled,true);assert.match(root.textContent,/saved-signature/);
 button('Refresh price').click();await settle();assert.equal(button('Buy pack').disabled,true);
 wallet.accounts=[];onChange();assert.equal(button('Disconnect').disabled,true);dispose();assert.equal(root.children.length,0);dom.window.close();
});

test('sale-window intent is gated by terminal stock and message support, never purchases, and rereads price',async t=>{
 const dom=new JSDOM('<section></section>'),root=dom.window.document.querySelector('section');t.after(()=>dom.window.close());
 const account={address:'public-window-owner',chains:['solana:devnet'],features:['solana:signTransaction','solana:signMessage']};
 const messageFeature={signMessage:async()=>{throw Error('The wallet component must delegate the intent callback');}};
 const wallet={name:'Window Wallet',chains:['solana:devnet'],accounts:[account],features:{'standard:connect':{connect:async()=>({accounts:[account]})},'standard:events':{on:()=>()=>{}},'standard:disconnect':{disconnect:async()=>{}},'solana:signTransaction':{supportedTransactionVersions:['legacy']},'solana:signMessage':messageFeature}};
 let phase=1,remaining=8,priceReads=0,invalidations=0,purchases=0,requests=0,release;
 const client={reconcilePurchase:async()=>({state:'none'}),invalidate(){invalidations++;},readSale:async()=>{priceReads++;return{canPurchase:false,epoch:{status:phase},pool:{price:100000000,platformFee:5000000,totalPrice:105000000,definitions:[{remaining}]}};},purchase:async()=>{purchases++;throw Error('A window request cannot buy a pack');}};
 const registry={get:()=>[wallet],on:()=>()=>{}};
 const dispose=mountPackWalletUI(root,{registry,client,chain:'solana:devnet',requestWindow:async(selectedWallet,selectedAccount)=>{assert.equal(selectedWallet,wallet);assert.equal(selectedAccount,account);requests++;await new Promise(resolve=>release=resolve);return{accepted:true};}});t.after(dispose);
 const button=name=>[...root.querySelectorAll('button')].find(node=>node.textContent===name),windowButton=button('Request sale window');
 await settle();assert.equal(windowButton.hidden,true);assert.equal(priceReads,1);
 button('Connect wallet').click();await settle();assert.equal(windowButton.hidden,true); // Open phase cannot demand another epoch.
 phase=5;button('Refresh price').click();await settle();assert.equal(windowButton.hidden,false);assert.equal(windowButton.disabled,false);
 account.features=['solana:signTransaction'];button('Refresh price').click();await settle();assert.equal(windowButton.disabled,true);assert.match(windowButton.title,/message signing/);
 account.features.push('solana:signMessage');delete wallet.features['solana:signMessage'];button('Refresh price').click();await settle();assert.equal(windowButton.disabled,true);
 wallet.features['solana:signMessage']=messageFeature;phase=6;remaining=3;button('Refresh price').click();await settle();assert.equal(windowButton.hidden,true);
 remaining=4;phase=7;button('Refresh price').click();await settle();assert.equal(windowButton.hidden,true);
 phase=6;button('Refresh price').click();await settle();assert.equal(windowButton.hidden,false);assert.equal(windowButton.disabled,false);
 const readsBefore=priceReads,invalidationsBefore=invalidations;windowButton.click();windowButton.click();await settle();assert.equal(requests,1);assert.equal(windowButton.disabled,true);assert.equal(purchases,0);
 release();await settle();assert.equal(requests,1);assert.equal(purchases,0);assert.equal(priceReads,readsBefore+1);assert.equal(invalidations,invalidationsBefore+1);assert.match(root.textContent,/Sale window requested/);
 button('Disconnect').click();await settle();assert.equal(windowButton.hidden,true);
 const noCallbackDom=new JSDOM('<section></section>'),noCallbackRoot=noCallbackDom.window.document.querySelector('section');t.after(()=>noCallbackDom.window.close());
 const stop=mountPackWalletUI(noCallbackRoot,{registry,client,chain:'solana:devnet'});t.after(stop);await settle();[...noCallbackRoot.querySelectorAll('button')].find(node=>node.textContent==='Connect wallet').click();await settle();assert.equal([...noCallbackRoot.querySelectorAll('button')].find(node=>node.textContent==='Request sale window').hidden,true);
});
