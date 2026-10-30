import {Transaction} from '@solana/web3.js';
import bs58 from 'bs58';

// Host persists compare-and-set records in its existing database. A prepared
// signed transaction is durable before broadcast; private signer material is
// never persisted. One host lock owns a job across this operation.
export async function recoverOperatorTransaction({connection,expectedGenesis,job,save}) {
  if(await connection.getGenesisHash()!==expectedGenesis)throw Error('Operator RPC chain mismatch');
  if(!job||typeof job.signature!=='string'||!Number.isSafeInteger(job.lastValidBlockHeight))throw Error('Invalid operator checkpoint');
  const tx=Transaction.from(Buffer.from(job.signedTransaction,'base64'));
  if(!tx.verifySignatures()||bs58.encode(tx.signature)!==job.signature||tx.recentBlockhash!==job.blockhash)
    throw Error('Operator checkpoint signature mismatch');
  if(['confirmed','failed','expired'].includes(job.state))return job;
  const status=(await connection.getSignatureStatuses([job.signature],{searchTransactionHistory:true})).value[0];
  if(status?.err){job.state='failed';job.error=status.err;await save(job);return job;}
  if(status&&['confirmed','finalized'].includes(status.confirmationStatus)){
    job.state='confirmed';await save(job);return job;
  }
  // Absence after expiry is ambiguous across RPC nodes. Preserve the identity
  // for reconciliation; never rebuild a different payment or claim here.
  if(await connection.getBlockHeight('confirmed')>job.lastValidBlockHeight){
    job.state='unresolved';await save(job);return job;
  }
  job.state='submitting';await save(job);
  try{
    const actual=await connection.sendRawTransaction(tx.serialize(),{skipPreflight:false,maxRetries:0});
    if(actual!==job.signature)throw Error('Operator RPC returned a different signature');
    job.state='submitted';await save(job);
  }catch(error){job.state='unresolved';await save(job);throw Object.assign(Error('Operator submission unresolved; reconcile the saved signature'),{signature:job.signature,cause:error});}
  return job;
}
