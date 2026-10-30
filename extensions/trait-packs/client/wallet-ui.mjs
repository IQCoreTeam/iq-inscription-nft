import {compatibleWallets,createWalletSession} from './wallet.mjs';

// Mount inside the existing pack page. Registry/client are the host's existing
// instances. This mode contains no test actors or server-side buyer signing.
export function mountPackWalletUI(root,{registry,client,chain}) {
  const document=root.ownerDocument;
  const select=document.createElement('select');select.setAttribute('aria-label','Wallet');
  const connect=document.createElement('button');connect.textContent='Connect wallet';connect.type='button';
  const disconnect=document.createElement('button');disconnect.textContent='Disconnect';disconnect.type='button';
  const refresh=document.createElement('button');refresh.textContent='Refresh price';refresh.type='button';
  const buy=document.createElement('button');buy.textContent='Buy pack';buy.type='button';
  const quote=document.createElement('p'),status=document.createElement('p');status.setAttribute('role','status');
  root.replaceChildren(select,connect,disconnect,quote,buy,refresh,status);
  let wallets=[],session=null,wallet=null,sale=null,busy=false,disposed=false,unresolved=null;
  const sol=n=>{const value=BigInt(n),fraction=(value%1000000000n).toString().padStart(9,'0').replace(/0+$/,'');return (value/1000000000n).toString()+(fraction?'.'+fraction:'');};
  function render(){
    connect.disabled=busy||!wallets.length;disconnect.disabled=busy||!session?.account;
    select.disabled=busy;refresh.disabled=busy;buy.disabled=busy||!!unresolved||!session?.account||!sale?.canPurchase;
    quote.textContent=sale?`Creator ${sol(sale.pool.price)} SOL + IQ ${sol(sale.pool.platformFee)} SOL = ${sol(sale.pool.totalPrice)} SOL. Network fees are additional.`:'Price not loaded.';
  }
  function discover(){
    const selected=select.value;wallets=compatibleWallets(registry,chain);
    select.replaceChildren(...wallets.map((value,index)=>{const option=document.createElement('option');option.value=String(index);option.textContent=value.name;return option;}));
    if(wallet&&wallets.includes(wallet))select.value=String(wallets.indexOf(wallet));
    else if(wallets[Number(selected)])select.value=selected;
    if(wallet&&!wallets.includes(wallet)){session?.dispose();session=null;wallet=null;status.textContent='Wallet is unavailable. Connect again.';}
    render();
  }
  async function run(operation){
    if(busy||disposed)return;busy=true;render();
    try{await operation();}catch(error){if(error.signature)unresolved=error.signature;if(!disposed)status.textContent=error.signature?`Confirmation unresolved. Check ${error.signature} before retrying.`:error.message;}
    finally{busy=false;if(!disposed)render();}
  }
  connect.addEventListener('click',()=>run(async()=>{
    session?.dispose();wallet=wallets[Number(select.value)];if(!wallet)throw Error('Choose an available wallet');
    session=createWalletSession(wallet,chain,account=>{status.textContent=account?'Wallet connected.':'Wallet disconnected. Connect again.';render();});
    const account=await session.connect();
    const previous=await client.reconcilePurchase(account);
    unresolved=previous.state==='unresolved'?previous.signature:null;
    if(unresolved)status.textContent=`Confirmation unresolved. Check ${unresolved} before retrying.`;
  }));
  disconnect.addEventListener('click',()=>run(async()=>{await session?.disconnect();}));
  select.addEventListener('change',()=>{session?.dispose();session=null;wallet=null;render();});
  refresh.addEventListener('click',()=>run(async()=>{client.invalidate();sale=null;if(session?.account){const previous=await client.reconcilePurchase(session.account);unresolved=previous.state==='unresolved'?previous.signature:null;}sale=await client.readSale();status.textContent=unresolved?`Confirmation unresolved. Check ${unresolved} before retrying.`:sale.canPurchase?'Price refreshed.':'Sale is not currently available.';}));
  buy.addEventListener('click',()=>run(async()=>{
    const current=session?.account;if(!current||!sale)throw Error('Connect a wallet and review the price');
    const result=await client.purchase({wallet,account:current,expectedTotal:sale.pool.totalPrice});
    status.textContent=`Purchase confirmed: ${result.signature}. Rewards appear after settlement.`;
    sale=await client.readSale();
  }));
  const off=[registry.on('register',discover),registry.on('unregister',discover)];discover();
  run(async()=>{sale=await client.readSale();});
  return ()=>{disposed=true;session?.dispose();for(const dispose of off)dispose();root.replaceChildren();};
}
