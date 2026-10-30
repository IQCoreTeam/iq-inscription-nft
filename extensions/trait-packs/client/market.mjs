import {Transaction,PublicKey} from '@solana/web3.js';
import {createWardrobeReader} from './state.mjs';
import {packPurchase,sendWalletTransaction,assertConnectionChain} from './transactions.mjs';

// The host supplies its existing Wallet Standard wallet/account and explicit
// network. No wallet discovery singleton, fixture signer or backend buyer key.
export function createPackClient({connection,program,collection,chain,localGenesis}) {
  program=new PublicKey(program);collection=new PublicKey(collection);
  const reader=createWardrobeReader({connection,program,collection});
  let chainCheck;
  async function readSale() {
    chainCheck ??= assertConnectionChain(connection,chain,localGenesis).catch(error=>{chainCheck=null;throw error;});
    await chainCheck;
    return reader.sale();
  }
  return {
    readSale,
    invalidate:reader.invalidate,
    async purchase({wallet,account,expectedTotal}) {
      reader.invalidate();
      const sale=await readSale();
      if(!sale.canPurchase)throw Error('This pack sale is not open');
      if(expectedTotal!==sale.pool.totalPrice)
        throw Error('Review the current pack price and IQ fee before signing');
      const transaction=new Transaction().add(packPurchase(
        program,collection,new PublicKey(account.address),sale.epoch.ticketCount,
        sale.epoch.id,expectedTotal,
      ));
      try {
        const signature=await sendWalletTransaction({
          wallet,account,connection,transaction,chain,localGenesis,
        });
        return {signature,epoch:sale.epoch.id,ticket:sale.epoch.ticketCount,
          creatorPrice:sale.pool.price,platformFee:sale.pool.platformFee,totalPrice:expectedTotal};
      } finally {
        reader.invalidate();
      }
    },
  };
}
