import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {Keypair} from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import {createPackCreatorAuthApi} from './pack-auth.ts';

function fixture() {
 const db=new Database(':memory:'),wallet=Keypair.generate(),owner=wallet.publicKey.toBase58();let at=1000000;
 const config={db,origin:'https://api.example',requestOrigins:['https://site.example'],chain:'solana:devnet',program:Keypair.generate().publicKey.toBase58(),genesis:'pinned',now:()=>at};
 const api=createPackCreatorAuthApi(config);
 const request=(body:any,extra:any={})=>new Request('https://api.example/creator/packs/auth',{method:'POST',headers:{origin:'https://site.example','content-type':'application/json',...extra},body:JSON.stringify(body)});
 async function login() {
  const c=await api.handle(request({owner}));
  const proof={owner,message:c.message,signature:bs58.encode(nacl.sign.detached(new TextEncoder().encode(c.message),wallet.secretKey))};
  const session=await api.handle(request(proof));return{proof,session};
 }
 return {db,wallet,owner,config,api,request,login,setTime:(v:number)=>at=v};
}
test('creator auth is one-use, persisted, origin/deployment-bound and tokens are hashed at rest',async()=>{
 const f=fixture();try{
  expect(()=>f.api.owner(f.request({}))).toThrow('Sign in');
  const {proof,session}=await f.login(),req=f.request({},{authorization:'Bearer '+session.token});
  expect(f.api.owner(req)).toBe(f.owner);
  expect(createPackCreatorAuthApi(f.config).owner(req)).toBe(f.owner);
  expect(f.db.query('SELECT hash FROM pack_creator_session').get().hash).not.toBe(session.token);
  await expect(f.api.handle(f.request(proof))).rejects.toThrow('already used');
  expect(()=>f.api.owner(f.request({},{origin:'https://evil.example',authorization:'Bearer '+session.token}))).toThrow('origin');
  expect(()=>createPackCreatorAuthApi({...f.config,genesis:'other'}).owner(req)).toThrow('expired');
  f.setTime(2000000);expect(()=>f.api.owner(req)).toThrow('expired');
 }finally{f.db.close();}
});
test('wrong-wallet and altered challenge proofs cannot create a session; expired challenge fails',async()=>{
 const f=fixture();try{
  const {message}=await f.api.handle(f.request({owner:f.owner}));
  const wrong=bs58.encode(nacl.sign.detached(new TextEncoder().encode(message),Keypair.generate().secretKey));
  await expect(f.api.handle(f.request({owner:f.owner,message,signature:wrong}))).rejects.toThrow('does not match');
  await expect(f.api.handle(f.request({owner:f.owner,message:message+'x',signature:wrong}))).rejects.toThrow('expired');
  expect(f.db.query('SELECT COUNT(*) AS n FROM pack_creator_session').get().n).toBe(0);
  f.setTime(1060001);await expect(f.api.handle(f.request({owner:f.owner,message,signature:wrong}))).rejects.toThrow('expired');
 }finally{f.db.close();}
});
test('challenge and request budgets apply before expensive work',async()=>{
 const f=fixture();try{
  for(let i=0;i<4;i++)await f.api.handle(f.request({owner:f.owner}));
  await expect(f.api.handle(f.request({owner:f.owner}))).rejects.toThrow('Too many');
  await expect(f.api.handle(f.request({owner:f.owner,extra:true}))).rejects.toThrow('Unexpected');
  await expect(f.api.handle(f.request({owner:f.owner,padding:'x'.repeat(5000)}))).rejects.toThrow('bound');
 }finally{f.db.close();}
});
