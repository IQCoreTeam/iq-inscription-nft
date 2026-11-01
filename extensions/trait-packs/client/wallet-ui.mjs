import { compatibleWallets, createWalletSession } from "./wallet.mjs";

// Mount inside the existing pack page. Registry/client are the host's existing
// instances. This mode contains no test actors or server-side buyer signing.
export function mountPackWalletUI(root, { registry, client, chain, requestWindow, purchaseRoot = root }) {
  const document = root.ownerDocument;
  const dialog = document.createElement("dialog");
  dialog.className = "pack-wallet-dialog";
  dialog.setAttribute("aria-label", "Connect wallet");
  const heading = document.createElement("h2");
  heading.textContent = "Connect wallet";
  const choices = document.createElement("div");
  choices.className = "wallet-options";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancel";
  cancel.className = "text-button";
  cancel.addEventListener("click", () => dialog.close(""));
  dialog.append(heading, choices, cancel);
  const connect = document.createElement("button");
  connect.textContent = "Connect wallet";
  connect.type = "button";
  const disconnect = document.createElement("button");
  disconnect.textContent = "Disconnect";
  disconnect.type = "button";
  const refresh = document.createElement("button");
  refresh.textContent = "Refresh price";
  refresh.type = "button";
  const buy = document.createElement("button");
  buy.textContent = "Buy pack";
  buy.type = "button";
  const quote = document.createElement("p"),
    status = document.createElement("p");
  status.setAttribute("role", "status");
  const address = document.createElement("span"); address.className = "wallet-address";
  buy.className = "primary-button"; refresh.className = "text-button";
  connect.className = "quiet-button"; disconnect.className = "text-button";
  quote.className = "checkout-price"; status.className = "checkout-status";
  const fees = document.createElement("small"); fees.className = "checkout-fees";
  const pricing = document.createElement("div"); pricing.className = "checkout-main"; pricing.append(quote, buy);
  root.replaceChildren(connect, address, disconnect, dialog);
  const checkout = document.createElement("div"); checkout.className = "pack-checkout";
  checkout.append(pricing, fees, refresh, status);
  if (purchaseRoot === root) root.append(checkout); else purchaseRoot.replaceChildren(checkout);
  let wallets = [],
    session = null,
    wallet = null,
    sale = null,
    busy = false,
    disposed = false,
    unresolved = null,
    purchaseStep = null;
  const sol = (n) => {
    const value = BigInt(n),
      fraction = (value % 1000000000n)
        .toString()
        .padStart(9, "0")
        .replace(/0+$/, "");
    return (value / 1000000000n).toString() + (fraction ? "." + fraction : "");
  };
  const emit = (name, detail) =>
    root.dispatchEvent(
      new document.defaultView.CustomEvent(name, { bubbles: true, detail }),
    );
  function canPrepare() {
    return !!requestWindow && [5,6].includes(sale?.epoch?.status) &&
      (sale.pool.definitions ?? []).reduce((sum,row)=>sum+row.remaining,0)>=4;
  }
  function render() {
    address.hidden = !session?.account;
    address.textContent = session?.account ? session.account.address.slice(0, 4) + "…" + session.account.address.slice(-4) : "";
    connect.hidden = !!session?.account;
    disconnect.hidden = !session?.account;
    connect.disabled = busy || !wallets.length;
    disconnect.disabled = busy || !session?.account;

    refresh.disabled = busy;
    buy.textContent = purchaseStep ?? "Buy pack";
    buy.disabled = busy || !!unresolved || !session?.account ||
      !(sale?.canPurchase || canPrepare() && wallet?.features["solana:signMessage"] && session.account.features.includes("solana:signMessage"));
    quote.textContent = sale ? sol(sale.pool.totalPrice) + " SOL" : "Loading price…";
    fees.textContent = sale ? "Includes " + sol(sale.pool.platformFee) + " SOL IQ fee · network fees extra" : "";
    quote.title = sale ? "Creator " + sol(sale.pool.price) + " SOL + IQ " + sol(sale.pool.platformFee) + " SOL" : "";
    if (purchaseRoot !== root) status.hidden = !purchaseStep && status.dataset.kind !== "error";

  }
  function discover() {
    wallets = compatibleWallets(registry, chain);
    choices.replaceChildren(...wallets.map((value, index) => {
      const option = document.createElement("button");
      option.type = "button";
      option.textContent = value.name;
      option.addEventListener("click", () => dialog.close(String(index)));
      return option;
    }));
    if (wallet && !wallets.includes(wallet)) {
      session?.dispose();
      session = null;
      wallet = null;
      emit("iqpacks:wallet", { wallet: null, account: null });
      status.textContent = "Wallet is unavailable. Connect again.";
    }
    render();
  }
  async function run(operation) {
    if (busy || disposed) return;
    busy = true;
    status.dataset.kind = "";
    render();
    try {
      await operation();
    } catch (error) {
      status.dataset.kind = "error";
      if (error.signature) unresolved = error.signature;
      if (!disposed)
        status.textContent = error.signature
          ? `Confirmation unresolved. Check ${error.signature} before retrying.`
          : error.message;
    } finally {
      busy = false;
      purchaseStep = null;
      if (!disposed) render();
    }
  }
  connect.addEventListener("click", () =>
    run(async () => {
      let selected = wallets[0];
      if (wallets.length > 1) {
        const chosen = await new Promise(resolve => {
          dialog.returnValue = "";
          dialog.addEventListener("close", () => resolve(dialog.returnValue), { once: true });
          dialog.showModal();
        });
        if (chosen === "" || disposed) return;
        selected = wallets[Number(chosen)];
      }
      if (!selected || !compatibleWallets(registry, chain).includes(selected))
        throw Error("Wallet is unavailable. Connect again.");
      session?.dispose();
      wallet = selected;
      session = createWalletSession(wallet, chain, (account) => {
        emit("iqpacks:wallet", { wallet, account });
        status.textContent = account
          ? "Wallet connected."
          : "Wallet disconnected. Connect again.";
        render();
      });
      const account = await session.connect();
      const previous = await client.reconcilePurchase(account);
      unresolved = previous.state === "unresolved" ? previous.signature : null;
      if (unresolved)
        status.textContent = `Confirmation unresolved. Check ${unresolved} before retrying.`;
    }),
  );
  disconnect.addEventListener("click", () =>
    run(async () => {
      await session?.disconnect();
    }),
  );
  const refreshSale = () => run(async () => {
      client.invalidate();
      sale = null;
      if (session?.account) {
        const previous = await client.reconcilePurchase(session.account);
        unresolved =
          previous.state === "unresolved" ? previous.signature : null;
      }
      sale = await client.readSale();
      status.textContent = unresolved
        ? `Confirmation unresolved. Check ${unresolved} before retrying.`
        : sale.canPurchase
          ? "Price refreshed."
          : "Sale is not currently available.";
    });
  refresh.addEventListener("click", refreshSale);
  root.addEventListener("iqpacks:refresh-sale", refreshSale);
  buy.addEventListener("click", () =>
    run(async () => {
      const current = session?.account;
      if (!current || !sale)
        throw Error("Connect a wallet and review the price");
      const selectedWallet = wallet, reviewedTotal = sale.pool.totalPrice, address = current.address;
      const assertCurrent = () => {
        if (disposed || wallet !== selectedWallet || session?.account?.address !== address ||
            !selectedWallet.accounts.some(account=>account.address===address && account.chains.includes(chain)))
          throw Error("Wallet changed. Review the price and try again.");
        if (BigInt(sale.pool.totalPrice) !== BigInt(reviewedTotal))
          throw Error("The price changed. Review the new total before buying.");
      };
      client.invalidate();sale=await client.readSale();assertCurrent();
      if (!sale.canPurchase && canPrepare()) {
        purchaseStep="Preparing…";
        status.textContent="Approve a message to prepare the sale. No payment yet.";
        render();
        await requestWindow(selectedWallet,current);assertCurrent();
        status.textContent="Preparing your purchase…";render();
        for(let attempt=0;attempt<15;attempt++) {
          client.invalidate();sale=await client.readSale();assertCurrent();
          if(sale.canPurchase)break;
          await new Promise(resolve=>document.defaultView.setTimeout(resolve,2000));
          assertCurrent();
        }
      }
      if (!sale.canPurchase) throw Error("The sale is not ready yet. Nothing was charged. Try again shortly.");
      assertCurrent();purchaseStep="Confirm payment";
      status.textContent="Confirm the pack payment in your wallet.";render();
      const result = await client.purchase({
        wallet: selectedWallet,
        account: current,
        expectedTotal: reviewedTotal,
      });
      status.textContent = "Purchase confirmed. Preparing your pack…";
      emit("iqpacks:purchase", result);
      sale = await client.readSale();
    }),
  );
  const off = [
    registry.on("register", discover),
    registry.on("unregister", discover),
  ];
  discover();
  run(async () => {
    sale = await client.readSale();
  });
  return () => {
    disposed = true;
    root.removeEventListener("iqpacks:refresh-sale", refreshSale);
    if (dialog.open) dialog.close("");
    session?.dispose();
    for (const dispose of off) dispose();
    root.replaceChildren();
    if (purchaseRoot !== root) purchaseRoot.replaceChildren();
  };
}
