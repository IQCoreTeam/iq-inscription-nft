import {PublicKey} from '@solana/web3.js';
import {signWalletMessage} from './wallet.mjs';
import bs58 from 'bs58';
import {packWindowMessage} from './window-message.mjs';

// A signed intent requests one budgeted operator window. It is not a purchase,
// payment, delegation or permission to sign later transactions for this wallet.
export async function requestPackWindow({wallet,account,chain,program,collection,endpoint}) {
  const url=new URL(endpoint),owner=account.address;
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||(url.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))||url.pathname!=='/packs/'+collection+'/window')throw Error('Invalid configured sale-window endpoint');
  const feature=wallet.features['solana:signMessage'];
  function current(){
    if(account.address!==owner||!account.chains.includes(chain)||!account.features.includes('solana:signMessage')||!wallet.accounts.some(value=>value.address===owner&&value.chains.includes(chain))||new PublicKey(account.publicKey).toBase58()!==owner)throw Error('Wallet changed before sale-window approval');
  }
  if(!feature?.signMessage)throw Error('This wallet cannot sign a sale-window request. Use a wallet with message signing.');
  current();
  async function post(body){
    const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},credentials:'omit',redirect:'error',signal:AbortSignal.timeout(20000),body:JSON.stringify(body)}),result=await response.json();
    if(!response.ok)throw Error(typeof result.error==='string'?result.error:'Sale-window request failed');
    return result;
  }
  const {challenge,message}=await post({owner});current();
  if(!challenge||challenge.origin!==url.origin||challenge.chain!==chain||challenge.program!==program||challenge.collection!==collection||challenge.owner!==owner||!Number.isSafeInteger(challenge.expiresAt)||challenge.expiresAt<=Date.now()||challenge.expiresAt>Date.now()+120000||typeof challenge.nonce!=='string'||!(/^[a-f0-9]{64}$/).test(challenge.nonce)||message!==packWindowMessage(challenge))throw Error('Sale-window approval terms changed');
  const signature=await signWalletMessage({wallet,account,chain,message});current();
  const accepted=await post({owner,message,signature:bs58.encode(signature)});current();
  if(accepted.accepted!==true)throw Error('The operator did not accept this sale-window request');
  return accepted;
}
