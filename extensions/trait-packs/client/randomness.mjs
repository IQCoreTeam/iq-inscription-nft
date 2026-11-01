import { PublicKey } from '@solana/web3.js';
import { Buffer } from 'buffer';
import { sha256 } from '@noble/hashes/sha256';
import { addresses, readPool, readEpoch, u32 } from './protocol.mjs';
import { assertConnectionChain } from './transactions.mjs';

const ORAO = new PublicKey('VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y');
const hash = (...parts) => Buffer.from(sha256(Buffer.concat(parts)));

// Public, on-demand replay of a completed epoch. This checks the fulfilled
// provider account trusted by the program, not the oracle quorum signatures.
export async function verifyPackRandomness({ connection, program, collection, chain, localGenesis, epochId, ticket }) {
  if (!Number.isSafeInteger(epochId) || epochId < 0 || !Number.isInteger(ticket) || ticket < 0 || ticket >= 32)
    throw Error('Invalid pack proof identity');
  await assertConnectionChain(connection, chain, localGenesis);
  program = new PublicKey(program); collection = new PublicKey(collection);
  const keys = addresses(program, collection, epochId);
  const first = await connection.getMultipleAccountsInfoAndContext([keys.pool, keys.epoch], { commitment:'confirmed' });
  if (!Number.isSafeInteger(first.context?.slot) || first.value.length !== 2 || first.value.some(info=>!info?.owner.equals(program)))
    throw Error('Invalid confirmed pack proof accounts');
  const pool = readPool(first.value[0].data), epoch = readEpoch(first.value[1].data);
  if (!pool.collection.equals(collection) || !pool.sealed || !pool.provider.equals(ORAO) || pool.definitionCount<1 || pool.definitionCount>16 || pool.pulls!==4 ||
      !epoch.pool.equals(keys.pool) || epoch.id!==epochId || epoch.ticketCount>32 || ticket>=epoch.ticketCount || !epoch.requested ||
      epoch.cursor!==epoch.ticketCount || ![4,6].includes(epoch.status) || epoch.tickets[ticket].claimMask!==15)
    throw Error('The opening is not fully settled or its proof identity differs');
  const request = PublicKey.findProgramAddressSync([Buffer.from('orao-vrf-randomness-request'), epoch.seed], ORAO)[0];
  const record = await connection.getAccountInfoAndContext(request, { commitment:'confirmed', minContextSlot:first.context.slot });
  const bytes = Buffer.from(record.value?.data ?? []);
  if (!Number.isSafeInteger(record.context?.slot) || record.context.slot<first.context.slot || !record.value?.owner.equals(ORAO) || bytes.length<137 ||
      !bytes.subarray(0,8).equals(Buffer.from([139,239,184,215,227,86,191,226])) || bytes[8]!==1 ||
      !new PublicKey(bytes.subarray(9,41)).equals(keys.requester) || !bytes.subarray(41,73).equals(epoch.seed))
    throw Error('The oracle request is missing, unfulfilled or belongs to another opening');
  const entropy = hash(Buffer.from('NUBBIES_ORAO_RESULT_V4'),bytes.subarray(73,137));
  if (!entropy.equals(epoch.entropy)) throw Error('Oracle result does not match the recorded draw entropy');
  // Allocation consumes the epoch snapshot in place. Restore its initial
  // counts by adding the completed allocations, then replay every draw in order.
  const counts = epoch.inventory.slice(0,pool.definitionCount);
  for (const row of epoch.tickets) for (const id of row.definitions) {
    if (!Number.isInteger(id) || id<0 || id>=counts.length) throw Error('Invalid recorded trait definition');
    counts[id]++;
    if (counts[id]>0xffffffff) throw Error('Initial inventory exceeds the program range');
  }
  const initialInventory=[...counts], draws=[];
  for (let i=0;i<epoch.ticketCount;i++) for (let pull=0;pull<4;pull++) {
    const total=counts.reduce((sum,n)=>sum+BigInt(n),0n);
    if (!total) throw Error('Draw inventory is empty');
    const max=0xffffffffffffffffn, ceiling=max-max%total;
    let pick=null;
    for (let retry=0;retry<=128;retry++) {
      const value=hash(Buffer.from('nubbies-draw-v4'),entropy,epoch.seed,u32(i),u32(pull),u32(retry)).readBigUInt64LE(0);
      if(value<ceiling){pick=value%total;break;}
    }
    if(pick===null)throw Error('Draw rejection limit exceeded');
    let chosen=-1;
    for(let id=0;id<counts.length;id++) {if(pick<BigInt(counts[id])){chosen=id;break;}pick-=BigInt(counts[id]);}
    if(chosen!==epoch.tickets[i].definitions[pull])throw Error('Recorded traits do not match the random draw');
    counts[chosen]--;
    if(i===ticket)draws.push({pull,definition:chosen,name:pool.definitions[chosen].name});
  }
  if(counts.some((n,i)=>n!==epoch.inventory[i]))throw Error('Remaining inventory does not match the replay');
  return { matches:true, simulation:chain==='solana:localnet', chain, slot:record.context.slot,
    pool:keys.pool.toBase58(), epoch:keys.epoch.toBase58(), request:request.toBase58(), epochId,ticket,
    seed:epoch.seed.toString('hex'),resultHash:entropy.toString('hex'),initialInventory,draws };
}
