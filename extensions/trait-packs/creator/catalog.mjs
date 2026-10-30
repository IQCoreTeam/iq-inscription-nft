import { PublicKey, SystemProgram } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha256';
import { Buffer } from 'buffer';
import { addresses, account, instruction, encodeDefinitions, readPool, u64 } from '../client/protocol.mjs';

// Validate before creating an irreversible header. Names are bounded by UTF-8
// bytes and dependency chains must be expressible by the deployed program.
export function validateCatalog(definitions) {
  if (!Array.isArray(definitions) || definitions.length < 1 || definitions.length > 16) throw Error('A pack catalog supports 1–16 traits');
  let total=0;
  for (const [id,definition] of definitions.entries()) {
    if (definition.id!==id || !Number.isInteger(definition.slot) || definition.slot<0 || definition.slot>5 || !Number.isInteger(definition.bodyMask) || definition.bodyMask<1 || definition.bodyMask>255) throw Error('Invalid trait id, slot or body compatibility');
    if (typeof definition.name!=='string' || typeof definition.uri!=='string' || !/^[0-9a-f]{64}$/.test(definition.hash) || /^0+$/.test(definition.hash)) throw Error('Trait metadata must have a name, URI and content hash');
    if (!Number.isInteger(definition.supply) || definition.supply<0 || definition.supply>1_000_000) throw Error('Invalid trait supply');
    total+=definition.supply;
  }
  if(total<4 || total>1_000_000)throw Error('The pool needs 4–1,000,000 traits');
  for(const definition of definitions){
    const slots=new Set();let cursor=definition;
    for(let depth=0;depth<=definitions.length;depth++){
      if(slots.has(cursor.slot))throw Error('Trait prerequisites cannot repeat a slot or form a cycle');
      slots.add(cursor.slot);
      const slot=cursor.requiredSlot??255,target=cursor.requiredDefinition??255;
      if(slot===255){if(target!==255)throw Error('A prerequisite trait needs a slot');break;}
      const required=definitions[target];
      if(!Number.isInteger(slot)||slot<0||slot>5||!Number.isInteger(target)||!required||required.slot!==slot||(cursor.bodyMask&~required.bodyMask)!==0||(definition.supply>0&&required.supply===0))throw Error('Invalid or unavailable prerequisite trait');
      cursor=required;
    }
  }
  // Reuse the holder/protocol encoder; it owns string lengths and byte layout.
  return encodeDefinitions(definitions);
}

export function catalogSetup(spec, existingPool) {
  const program=new PublicKey(spec.program),collection=new PublicKey(spec.collection),authority=new PublicKey(spec.authority),nftProgram=new PublicKey(spec.nftProgram),registry=new PublicKey(spec.registry);
  const expectedRegistry=PublicKey.findProgramAddressSync([Buffer.from('registry'),collection.toBuffer()],nftProgram)[0];
  if(!registry.equals(expectedRegistry))throw Error('Registry does not belong to this collection');
  for(const field of ['price','window','timeout'])if(!Number.isSafeInteger(spec[field])||spec[field]<0)throw Error('Invalid '+field);
  if(spec.window===0||spec.timeout===0)throw Error('Sale windows must be positive');
  const encoded=validateCatalog(spec.definitions),hash=Buffer.from(sha256(encoded)),k=addresses(program,collection),plan=[];
  let appended=0;
  if(existingPool){
    if(!new PublicKey(existingPool.owner).equals(program))throw Error('Unexpected pool owner');
    const data=Buffer.from(existingPool.data),pool=readPool(data);
    if(!pool.collection.equals(collection)||!pool.authority.equals(authority)||pool.catalogHash!==hash.toString('hex')||pool.price!==spec.price||pool.window!==spec.window||pool.timeout!==spec.timeout||!pool.treasury.equals(new PublicKey(spec.treasury))||!pool.provider.equals(new PublicKey(spec.provider))||!pool.providerTreasury.equals(new PublicKey(spec.providerTreasury)))throw Error('Existing pool does not match this creator draft');
    appended=data[251];
    if(appended>spec.definitions.length||data[250]>1)throw Error('Invalid catalog progress');
    if(data[250]===1){if(appended!==spec.definitions.length)throw Error('Incomplete sealed catalog');return [];}
    if(!data.subarray(384,384+appended*240).equals(encoded.subarray(0,appended*240)))throw Error('Existing catalog prefix does not match this draft');
  }else{
    plan.push({stage:'initialize',instruction:instruction(program,15,[account(authority,true,true),account(k.pool,true),account(collection),account(registry),account(nftProgram),account(new PublicKey(spec.treasury)),account(new PublicKey(spec.provider)),account(new PublicKey(spec.providerTreasury)),account(SystemProgram.programId)],Buffer.concat([u64(spec.price),u64(spec.window),u64(spec.timeout),Buffer.from([spec.definitions.length]),hash]))});
  }
  const admin=[account(authority,false,true),account(k.pool,true),account(collection),account(registry)];
  for(let start=appended;start<spec.definitions.length;start+=2){const count=Math.min(2,spec.definitions.length-start);plan.push({stage:'append',start,count,instruction:instruction(program,11,admin,Buffer.concat([Buffer.from([start,count]),encoded.subarray(start*240,(start+count)*240)]))});}
  plan.push({stage:'seal',instruction:instruction(program,12,admin,Buffer.alloc(0))});
  return plan;
}
