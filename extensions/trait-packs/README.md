# Optional trait packs — discussion candidate

This extension is independent of ordinary collection minting. It is not enabled by default and must not be deployed as part of an existing NFT backend rollout.

- `program`: separate paid-pack program, epoch/provider/refund/claim flow and Core trait custody. The legacy `nubbies_paid_v6` crate name and ABI magic are retained to keep existing source/binary receipts addressable; the added outfit assertion is opcode 25.
- `client`: reusable instruction builders, Wallet Standard session/sender, direct-trade payments and bounded account reader. It accepts the app's existing wallet registry and explicit chain. It contains no fixture signer or personal wallet key.
- `service`: derived outfit metadata/image adapter and reused layer renderer. Host supplies its existing Core/IQ readers, RPC/request budgets and a verified collection render kit. No private artwork is included. Immutable IQ responses keep their existing paths/meaning.
- The existing IQ NFT program adds explicit registered-creator/current-holder approval for the burn-only hook and derived metadata, plus current-holder-only recovery of the first original URI. Restoring the URI leaves the hook installed; it does not grant transfer authority.

Local checks:

```sh
cd extensions/trait-packs/client
npm ci --ignore-scripts
npm test
npm run build
cd ../service
npm ci --ignore-scripts
npm test
```

The standalone pack program is excluded from the root Cargo workspace to avoid changing existing builds. Build/test it from its own manifest when reviewing that separate program; no automatic deployment is configured.

Evidence from the private integration lab covers real Surfpool IQ/Core/provider transactions, browser-held-key buy/open/equip/remove, guarded direct trades and royalties, the existing 16-trait UI at 390px, synthetic media/cache-loss recovery, and byte-exact private render-kit recovery. Those QA harnesses are not production services and are not copied here. No external marketplace listing/ingestion, physical-wallet or mainnet acceptance is implied.

Before production: agree on program ownership/upgrades, venue-specific order/delegate/royalty handling, permanent artwork/recipe publication and HTTP hosting, personal/mobile-wallet acceptance, and final price/odds/schedule. A buyer must compose the outfit assertion with the intended settlement instructions. Arbitrary third-party venue buys do not automatically gain this guarantee. The generic direct-trade payment helper does not enforce royalties on external marketplaces.

Nubbies' 6,900-item static edition is private and can launch without this extension. Only 16 optional wearable definitions were exercised; two authored portraits remain unenrolled because they have no interchangeable layer recipes.
