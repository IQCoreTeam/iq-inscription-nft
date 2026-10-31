# Optional packs client — private candidate

This client contains holder operations, not fixture signers, program administration or an oracle operator. Install its pinned dependencies with `npm ci`, run `npm test`, and build the browser entry with `npm run build`.

- `packPurchase` and `outfitChange` build the existing program's instructions. The host must read current ticket/epoch/owner state and show the action/cost before requesting a signature.
- `sendWalletTransaction` takes an existing Wallet Standard wallet/account and explicit chain. It checks the RPC genesis, account support, unchanged signed message, all required signatures, exact signed-byte simulation, returned signature and confirmation. Uncertain confirmation retains the signature and never automatically rebuilds/replays the transaction. A localnet caller must pin its own local genesis; this isn't permission to substitute a public RPC.
- `compatibleWallets` uses the app's existing Wallet Standard registry. `createWalletSession` handles account removal, cancelled connection and disconnect. It neither exports keys nor uses a backend signer.
- `createWardrobeReader` fetches pool/loadout together, validates ownership/identity and shares in-flight reads. Reads are bounded to 64 entries and one second after completion. There is no background poll. Invalidate the affected avatar after a confirmed write; a stale read cannot replace the transaction's on-chain assertion.
- Equipped Core traits remain in avatar-bound custody. Transferring the avatar transfers control of those equipped traits to its new current holder; the former holder cannot withdraw them. Detached traits remain independently owned assets.
- `guardedTrade` prepends the exact outfit assertion to host-provided settlement instructions. It does not validate arbitrary venue orders. The buyer must verify seller, asset, price, fees, transfer and royalty terms in its trusted venue adapter.
- `tradePayments` prepares explicit direct-sale payments using bigint lamports and declared royalty recipients. It isn't enforcement for external marketplace orders or a promise that third-party venues honor royalties. Fractional lamport remainders stay with the seller. Free traits must leave equipment custody before sale.

`browser-entry.mjs` bundles without Node-only filesystem/crypto dependencies or absolute paths. Only supported APIs are exported. The sibling local test harness uses generated keys and synthetic SOL; it is excluded from the reusable client package. The hand-built disposable browser wallet is evidence for the signing boundary, not Phantom/mobile acceptance.

The paired IQ metadata opt-in and V7 pack program are experimental local contracts. No mainnet deployment, external listing, publication or remote PR is authorized by this package. The original 6,900-item edition can launch separately.

## V5 local follow-up

`createPackClient` requires host-provided durable pending-purchase storage. It saves signed identity before broadcast and blocks another purchase until reconciliation sees a confirmed/failed chain result. The signed expected total includes the IQ surcharge. Quotes bind the explicit network and V5 account format.

`mountPackWalletUI` mounts wallet/quote controls into an existing pack page using the host's Wallet Standard registry. It supports disconnect and disposes listeners. Production-page bootstrap and physical-wallet acceptance remain separate gates.

`createIqMediaContext` uses the host's existing IQ SDK and browser wallet/burner signer. It reads JSON inscriptions via the pinned cached gateway, with bounded/coalesced reads. No private-key upload or table notify for unrelated Core transactions. The host still supplies explicit source-publication consent and durable publication checkpoints. The publisher verifies source/readback hashes.
