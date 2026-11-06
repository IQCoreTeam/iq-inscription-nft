import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Keypair} from '@solana/web3.js';
import nacl from 'tweetnacl';
import {createPackCreatorAuth,packCreatorMessage} from '../creator-auth.mjs';
function fixture(t,mode) {
 const key=Keypair.generate(),account={address:key.publicKey.toBase58(),publicKey:key.publicKey.toBytes(),chains:['solana:devnet'],features:['solana:signMessage']};let prompts=0,requests=0;
 const program=Keypair.generate().publicKey.toBase58(),site='https://site.example',endpoint='https://api.example/creator/packs/auth',chain='solana:devnet',genesis='pinned';
 const wallet={accounts:[account],features:{'solana:signMessage':{async signMessage({message}){prompts++;if(mode==='null')return[null];if(mode==='switch')wallet.accounts=[];const signedMessage=mode==='message'?new TextEncoder().encode('other'):message;return[{signedMessage,signature:nacl.sign.detached(signedMessage,key.secretKey)}];}}}};
 const old=global.fetch;t.after(()=>global.fetch=old);
 global.fetch=async(url,options)=>{
  requests++;assert.equal(String(url),endpoint);assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');
  const b=JSON.parse(options.body);if(b.signature)return Response.json({token:'a'.repeat(43),expiresAt:Date.now()+900000});
  const challenge={origin:'https://api.example',site,chain,program,genesis,owner:account.address,nonce:'a'.repeat(64),expiresAt:Date.now()+60000};if(mode==='scope')challenge.program=Keypair.generate().publicKey.toBase58();
  return Response.json({challenge,message:packCreatorMessage(challenge)});
 };
 return{auth:createPackCreatorAuth({wallet,account,chain,program,genesis,site,endpoint}),wallet,prompts:()=>prompts,requests:()=>requests};
}
test('creator session coalesces concurrent login, retains token only in memory and stops after wallet removal',async t=>{
 const f=fixture(t),[a,b]=await Promise.all([f.auth.headers(),f.auth.headers()]);assert.equal(a.Authorization,'Bearer '+'a'.repeat(43));assert.deepEqual(a,b);assert.equal(f.prompts(),1);assert.equal(f.requests(),2);
 await f.auth.headers();assert.equal(f.requests(),2);f.wallet.accounts=[];await assert.rejects(()=>f.auth.headers(),/wallet changed/i);
});
test('foreign deployment challenge is refused before signing',async t=>{const f=fixture(t,'scope');await assert.rejects(()=>f.auth.headers(),/terms changed/);assert.equal(f.prompts(),0);});
test('wallet change and a different signed message never submit creator proof',async t=>{
 for(const mode of ['switch','message','null']){const f=fixture(t,mode);await assert.rejects(()=>f.auth.headers(),/Wallet changed|different message/);assert.equal(f.requests(),1);}
});
