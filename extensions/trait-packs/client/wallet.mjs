import {PublicKey} from '@solana/web3.js';
import nacl from 'tweetnacl';
// Share the app's @wallet-standard/app singleton across creator and packs.
// Do not create another registry or inject a Phantom-specific global fallback.
export function compatibleWallets(registry, chain) {
  return registry
    .get()
    .filter(
      (wallet) =>
        wallet.chains.includes(chain) &&
        wallet.features["standard:connect"] &&
        wallet.features["standard:events"] &&
        wallet.features[
          "solana:signTransaction"
        ]?.supportedTransactionVersions.includes("legacy"),
    );
}

export function createWalletSession(wallet, chain, onChange) {
  let account = null,
    version = 0,
    disposed = false;
  const off = wallet.features["standard:events"].on("change", () => {
    if (
      account &&
      !wallet.accounts.some(
        (a) =>
          a.address === account.address &&
          a.chains.includes(chain) &&
          a.features.includes("solana:signTransaction"),
      )
    ) {
      account = null;
      version++;
      onChange(null);
    }
  });
  return {
    get account() {
      return account;
    },
    async connect() {
      if (disposed) throw Error("Wallet session is disposed");
      const attempt = ++version;
      const connected = await wallet.features["standard:connect"].connect();
      if (attempt !== version) throw Error("Connection was cancelled");
      const selected = connected.accounts.find(
        (a) =>
          a.chains.includes(chain) &&
          a.features.includes("solana:signTransaction"),
      );
      if (
        !selected ||
        !wallet.accounts.some((a) => a.address === selected.address)
      )
        throw Error("No account supports the requested chain");
      account = selected;
      onChange(account);
      return account;
    },
    async disconnect() {
      account = null;
      version++;
      onChange(null);
      await wallet.features["standard:disconnect"]?.disconnect();
    },
    dispose() {
      account = null;
      version++;
      disposed = true;
      off();
    },
  };
}

// Both creator login and sale-window intent require the same exact-message and
// current-account checks. This signs a message only, never a transaction.
export async function signWalletMessage({wallet,account,chain,message}) {
  const address=account.address;
  const current=()=>{
    if(account.address!==address||!account.chains.includes(chain)||!account.features.includes('solana:signMessage')||!wallet.accounts.some(a=>a.address===account.address&&a.chains.includes(chain))||new PublicKey(account.publicKey).toBase58()!==account.address)throw Error('Wallet changed before message approval');
  };
  current();const feature=wallet.features['solana:signMessage'];
  if(!feature?.signMessage)throw Error('This wallet needs message signing');
  const bytes=new TextEncoder().encode(message),results=await feature.signMessage({account,message:bytes});current();const value=results?.[0];
  if(results?.length!==1||!value||!(value.signedMessage instanceof Uint8Array)||value.signedMessage.length!==bytes.length||value.signedMessage.some((v,i)=>v!==bytes[i])||!(value.signature instanceof Uint8Array)||value.signature.length!==64||!nacl.sign.detached.verify(bytes,value.signature,account.publicKey))throw Error('Wallet returned a different message approval');
  return value.signature;
}
