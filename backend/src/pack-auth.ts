import {createHash,randomBytes} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import {packCreatorMessage} from '../../extensions/trait-packs/client/creator-auth.mjs';

const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
const fault=(s:string,status=403)=>Object.assign(Error(s),{status});

// Same SQLite + one-use wallet-message pattern as pack-window.ts. Tokens are
// hashed at rest and never grant transaction signing or collection authority.
export function createPackCreatorAuthApi({db,origin,requestOrigins,chain,program,genesis,now=Date.now}: {db:any;origin:string;requestOrigins:string[];chain:string;program:string;genesis:string;now?:()=>number}) {
  const allowed=new Set(requestOrigins);
  if(!allowed.size||allowed.size>16)throw Error('Configure creator request origins');
  for(const site of allowed)packCreatorMessage({origin,site,chain,program,genesis,owner:PublicKey.default.toBase58(),nonce:'0'.repeat(64),expiresAt:1});
  const scope=digest(JSON.stringify({origin,chain,program,genesis}));
  db.exec(`CREATE TABLE IF NOT EXISTS pack_creator_challenge(hash TEXT PRIMARY KEY,scope TEXT NOT NULL,owner TEXT NOT NULL,site TEXT NOT NULL,message TEXT NOT NULL,expires_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS pack_creator_session(hash TEXT PRIMARY KEY,scope TEXT NOT NULL,owner TEXT NOT NULL,site TEXT NOT NULL,expires_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS pack_creator_session_expiry ON pack_creator_session(expires_at);
  CREATE INDEX IF NOT EXISTS pack_creator_challenge_expiry ON pack_creator_challenge(expires_at);`);
  function site(request:Request) {
    const value=request.headers.get('origin')??'';
    if(!allowed.has(value))throw fault('Configured creator origin required');
    return value;
  }
  function prune() {
    db.query('DELETE FROM pack_creator_challenge WHERE expires_at<=?1').run(now());
    db.query('DELETE FROM pack_creator_session WHERE expires_at<=?1').run(now());
  }
  return {
    owner(request:Request) {
      const host=site(request),token=request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
      if(!token)throw fault('Sign in with the creator wallet',401);
      const row=db.query('SELECT owner FROM pack_creator_session WHERE hash=?1 AND scope=?2 AND site=?3 AND expires_at>?4').get(digest(token),scope,host,now());
      if(!row)throw fault('Creator session expired; sign in again',401);
      return row.owner as string;
    },
    async handle(request:Request) {
      const host=site(request),u=new URL(request.url);
      if(request.method!=='POST'||u.search||request.headers.get('content-type')?.split(';')[0]!=='application/json')throw fault('Creator sign-in requires JSON POST',400);
      const reader=request.body?.getReader();if(!reader)throw fault('JSON body required',400);
      const parts=[];let size=0;
      try {for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>4096)throw fault('Creator sign-in exceeds its bound',413);parts.push(value);}}finally{await reader.cancel();}
      let b:any;try{b=JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{throw fault('Invalid creator sign-in JSON',400);}
      if(!b||Array.isArray(b)||Object.keys(b).some(k=>!['owner','message','signature'].includes(k)))throw fault('Unexpected creator sign-in fields',400);
      let owner:string;try{owner=new PublicKey(b.owner).toBase58();if(owner!==b.owner)throw Error();}catch{throw fault('Invalid creator wallet',400);}
      prune();
      if(b.message===undefined&&b.signature===undefined) {
        if(db.query('SELECT COUNT(*) AS n FROM pack_creator_challenge').get().n>=256||db.query('SELECT COUNT(*) AS n FROM pack_creator_challenge WHERE owner=?1').get(owner).n>=4)throw fault('Too many creator challenges',429);
        const challenge={origin,site:host,chain,program,genesis,owner,nonce:randomBytes(32).toString('hex'),expiresAt:now()+60000},message=packCreatorMessage(challenge);
        db.query('INSERT INTO pack_creator_challenge VALUES(?1,?2,?3,?4,?5,?6)').run(digest(message),scope,owner,host,message,challenge.expiresAt);
        return {challenge,message};
      }
      if(typeof b.message!=='string'||b.message.length>1500||typeof b.signature!=='string'||b.signature.length>90)throw fault('Invalid creator proof',400);
      const row=db.query('SELECT * FROM pack_creator_challenge WHERE hash=?1 AND scope=?2 AND site=?3 AND owner=?4 AND expires_at>?5').get(digest(b.message),scope,host,owner,now());
      if(!row||row.message!==b.message)throw fault('Creator challenge expired or already used',409);
      let signature:Uint8Array;try{signature=bs58.decode(b.signature);}catch{throw fault('Invalid creator proof');}
      if(signature.length!==64||!nacl.sign.detached.verify(new TextEncoder().encode(row.message),signature,new PublicKey(owner).toBytes()))throw fault('Creator proof does not match this wallet');
      const token=randomBytes(32).toString('base64url'),expiresAt=now()+900000;
      db.transaction(()=>{
        if(db.query('SELECT COUNT(*) AS n FROM pack_creator_session').get().n>=256)throw fault('Creator sessions are busy',429);
        if(db.query('DELETE FROM pack_creator_challenge WHERE hash=?1 AND scope=?2 AND expires_at>?3').run(digest(b.message),scope,now()).changes!==1)throw fault('Creator challenge already used',409);
        db.query('INSERT INTO pack_creator_session VALUES(?1,?2,?3,?4,?5)').run(digest(token),scope,owner,host,expiresAt);
      }).immediate();
      return {token,expiresAt};
    }
  };
}
