// One bounded decision from confirmed state. The host constructs the existing
// program instructions, journals signed bytes and re-reads after each action.
// No timer, chain scan, secret signer, or client-generated outcome lives here.
export function nextEpochTask({pool,epoch,slot,providerStatus}) {
  if(!Number.isSafeInteger(slot)||slot<0||epoch.id!==pool.activeEpoch||(!Number.isInteger(epoch.ticketCount)||epoch.ticketCount<0||epoch.ticketCount>32)||epoch.tickets.length!==epoch.ticketCount)
    throw Error('Invalid confirmed epoch state');
  switch(epoch.status){
    case 1:{
      const stock=pool.definitions.reduce((sum,trait)=>sum+trait.remaining,0);
      return slot>=epoch.closeSlot||epoch.ticketCount===32||stock<(epoch.ticketCount+1)*4?{kind:'freeze'}:null;
    }
    case 2:return slot>epoch.deadlineSlot?{kind:'void'}:{kind:'request'};
    case 3:
      if(providerStatus==='fulfilled')return {kind:'capture'};
      if(providerStatus==='pending'&&slot>epoch.deadlineSlot)return {kind:'void'};
      return null; // Unknown provider state must never be treated as failure.
    case 7:return {kind:'allocate',limit:8};
    case 4:
      for(const [ticket,row] of epoch.tickets.entries())for(let pull=0;pull<4;pull++)
        if(!(row.claimMask&(1<<pull)))return {kind:'claim',ticket,pull};
      return {kind:'payout'};
    case 5:{
      const ticket=epoch.tickets.findIndex(row=>!row.refunded);
      return ticket<0?null:{kind:'refund',ticket};
    }
    case 6:return null;
    default:throw Error('Unsupported epoch phase');
  }
}
