import {test} from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
import {mountPackWalletUI} from '../wallet-ui.mjs';
const {JSDOM}=process.env.IQ_STUDIO_TEST_DEPS?createRequire(process.env.IQ_STUDIO_TEST_DEPS+'/package.json')('jsdom'):await import('jsdom');
async function settle(){for(let i=0;i<8;i++)await new Promise(setImmediate);}
test('wallet UI uses host registry, displays fee, disconnects and blocks unresolved retry',async()=>{
 const dom=new JSDOM('<section></section>');const root=dom.window.document.querySelector('section');
 const account={address:'public-address',chains:['solana:devnet'],features:['solana:signTransaction']};let onChange;
 const wallet={name:'Test Wallet',chains:['solana:devnet'],accounts:[account],features:{'standard:connect':{connect:async()=>({accounts:[account]})},'standard:events':{on:(_,cb)=>{onChange=cb;return()=>{};}},'standard:disconnect':{disconnect:async()=>{}},'solana:signTransaction':{supportedTransactionVersions:['legacy']}}};
 let buys=0;const client={reconcilePurchase:async()=>({state:buys?'unresolved':'none',signature:'saved-signature'}),invalidate(){},readSale:async()=>({canPurchase:true,pool:{price:100000000,platformFee:5000000,totalPrice:105000000}}),purchase:async input=>{buys++;assert.equal(input.expectedTotal,105000000);throw Object.assign(Error('lost response'),{signature:'saved-signature'});}};
 const dispose=mountPackWalletUI(root,{registry:{get:()=>[wallet],on:()=>()=>{}},client,chain:'solana:devnet'});await settle();
 const button=name=>[...root.querySelectorAll('button')].find(b=>b.textContent===name);
 assert.match(root.textContent,/Creator 0.1 SOL \+ IQ 0.005 SOL = 0.105 SOL/);assert.equal(button('Buy pack').disabled,true);
 button('Connect wallet').click();await settle();assert.equal(button('Buy pack').disabled,false);
 button('Buy pack').click();await settle();assert.equal(buys,1);assert.equal(button('Buy pack').disabled,true);assert.match(root.textContent,/saved-signature/);
 button('Refresh price').click();await settle();assert.equal(button('Buy pack').disabled,true);
 wallet.accounts=[];onChange();assert.equal(button('Disconnect').disabled,true);dispose();assert.equal(root.children.length,0);dom.window.close();
});
