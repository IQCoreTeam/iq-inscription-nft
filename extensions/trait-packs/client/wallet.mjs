// Discovery registry comes from the app's existing @wallet-standard/app instance.
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
