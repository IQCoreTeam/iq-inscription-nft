import {PublicKey} from '@solana/web3.js';
import {signWalletMessage} from './wallet.mjs';
import bs58 from 'bs58';

// Shared by the HTTP verifier and browser. This is a login, never a transfer
// approval, burner derivation or authority to sign future transactions.
export function packCreatorMessage(c) {
  if(!c || Object.keys(c).sort().join(',')!=='chain,expiresAt,genesis,nonce,origin,owner,program,site')throw Error('Invalid creator challenge');
  for(const field of ['site','origin']) {
    const u=new URL(c[field]);
    if(u.origin!==c[field]||u.username||u.password||!(u.protocol==='https:'||u.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(u.hostname)))throw Error('Invalid creator origin');
  }
  if(!['solana:localnet','solana:devnet','solana:mainnet'].includes(c.chain)||typeof c.genesis!=='string'||!c.genesis||c.genesis.length>100||/[\r\n]/.test(c.genesis))throw Error('Invalid creator network');
  for(const field of ['program','owner'])if(typeof c[field]!=='string'||new PublicKey(c[field]).toBase58()!==c[field])throw Error('Invalid creator identity');
  if(!/^[a-f0-9]{64}$/.test(c.nonce)||!Number.isSafeInteger(c.expiresAt)||c.expiresAt<=0)throw Error('Invalid creator lifetime');
  return ['Sign in to IQ pack creator','Site: '+c.site,'API: '+c.origin,'Chain: '+c.chain,'Genesis: '+c.genesis,'Pack program: '+c.program,'Wallet: '+c.owner,'Nonce: '+c.nonce,'Expires (Unix ms): '+c.expiresAt,'Allows temporary kit staging and setup requests only. No transaction or spending approval.'].join('\n');
}

export function createPackCreatorAuth({wallet,account,chain,program,genesis,endpoint,site}) {
  const url=new URL(endpoint);if(url.username||url.password||url.pathname!=='/creator/packs/auth'||url.search||url.hash)throw Error('Invalid creator login endpoint');
  const owner=account.address;
  packCreatorMessage({origin:url.origin,site,chain,program,genesis,owner,nonce:'0'.repeat(64),expiresAt:1});
  let session=null,pending=null;
  const current=()=>{if(account.address!==owner||!wallet.accounts.some(a=>a.address===account.address&&a.chains.includes(chain))||!account.features.includes('solana:signMessage')||new PublicKey(account.publicKey).toBase58()!==account.address)throw Error('Creator wallet changed; reconnect');};
  async function post(body) {
    const r=await fetch(url,{method:'POST',credentials:'omit',redirect:'error',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(20000),body:JSON.stringify(body)}),v=await r.json();
    if(!r.ok)throw Error(v.error||'Creator sign-in failed');return v;
  }
  return {async headers() {
    current();if(session&&session.expiresAt>Date.now()+10000)return {'Authorization':'Bearer '+session.token};
    if(!pending)pending=(async()=>{
      const {challenge,message}=await post({owner:account.address});current();
      if(!challenge||challenge.site!==site||challenge.origin!==url.origin||challenge.owner!==account.address||challenge.chain!==chain||challenge.program!==program||challenge.genesis!==genesis||challenge.expiresAt<=Date.now()||challenge.expiresAt>Date.now()+120000||message!==packCreatorMessage(challenge))throw Error('Creator sign-in terms changed');
      const signature=await signWalletMessage({wallet,account,chain,message});current();
      const accepted=await post({owner:account.address,message,signature:bs58.encode(signature)});current();
      if(!/^[A-Za-z0-9_-]{43}$/.test(accepted.token)||!Number.isSafeInteger(accepted.expiresAt)||accepted.expiresAt<=Date.now()||accepted.expiresAt>Date.now()+1800000)throw Error('Invalid creator session');
      session=accepted;
    })().finally(()=>{pending=null;});
    await pending;current();return {'Authorization':'Bearer '+session.token};
  }};
}
