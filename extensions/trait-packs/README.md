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

### Later pack releases (future work, not implemented)

The current `sale-v5` PDA is derived from the collection alone. Its catalog is
sealed before sales. Reopening epochs sells the remaining stock; it does not
create a new release or add new traits. Do not present a frontend-only “new
release” control over this ABI.

A future version should keep the collection as the stable identity and give
each release a separate pool keyed by collection + release ID, with its own
immutable catalog/media commitment, inventory, price, odds and sales history.
Old purchases must continue resolving against their original pool. Discovery
should paginate releases for a collection, and outfit compatibility must verify
the collection and approved release pool rather than assume one pool address.

This requires coordinated program, IQ holder-consent/wardrobe verification,
client, operator and indexer changes; existing `sale-v5` pools need an explicit
legacy path. Before production launch, either implement and test that version
or explicitly accept this version's single-release limitation. A program
upgrade or new deployment cannot silently grant existing NFTs new delegates.
No upgrade compatibility or automatic migration is promised by this draft.

### On-demand draw verification

`verifyPackRandomness` reads the configured pool and completed epoch in one
confirmed batch, then the derived ORAO request at the same or newer slot. It
checks the request owner, discriminator, requester, seed and fulfilled result;
recomputes the domain-separated entropy hash; reconstructs the epoch's initial
counts from final counts plus recorded allocations; and replays every draw with
the contract's rejection sampling and ticket order. It performs no writes and
uses two account-read requests plus the existing genesis check per invocation.

This checks consistency of on-chain records obtained from the configured RPC.
It does not independently validate the ORAO quorum signatures, prove historical
program immutability, or remove oracle/RPC trust assumptions. Localnet output is
explicitly labeled simulated. Unfinished allocation or missing claim data never
produces a success result.
