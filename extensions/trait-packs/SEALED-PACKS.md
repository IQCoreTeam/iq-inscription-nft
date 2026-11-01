# Transferable sealed packs — optional draft

This optional extension is proposed in backend PR #6 and paired frontend PR #15.
It has not been deployed to devnet/mainnet or independently reviewed.

## Behavior

1. Before a fresh pool's first epoch, its creator can enable a fixed-supply sealed release. A separate Core collection identifies the pack NFTs. It cannot be enabled on an already active legacy pool.
2. Buying creates a real transferable Core pack NFT plus a program-owned receipt/escrow. Price, receipt identity and monotonically increasing mint serial are checked on chain. Supply is capped by the sealed trait stock. A catalog cannot be silently expanded.
3. Unopened packs transfer normally. Tensor's existing Core listing/cancellation/purchase instructions are reused, with the venue's actual binary exercised offline. No custom orderbook or invented market price is introduced.
4. Opening requires the current Core owner as signer. The program verifies the exact issued asset/receipt/release and burns the pack, then admits a prepaid ticket into the existing epoch engine. Failure of any later step rolls back the burn and escrow movement. A listed/escrowed pack cannot be opened by its seller.
5. The existing ORAO flow allocates four traits, delivers them to the opener and settles the original creator/IQ payment. Transfer of a pack after redemption and double redemption fail because the NFT is consumed and the receipt is permanently marked.
6. On a provider timeout, the existing full prepaid-price refund goes to the opener. This does not refund resale markup or external marketplace fees. No replacement pack or reroll is issued.

## Economics and supply

- Original price: creator-selected price plus the same 5% IQ surcharge used by the current candidate. The original payment is escrowed until delivery, even if a sealed pack is held for years. This is an explicit prototype policy, not an assumed standard for collectible packs.
- Resale: seller sets an asking price; buyer decides whether to pay it. Marketplace/network fees remain additional. No pack-level resale royalty was silently invented. A public collection's royalty policy would need review.
- Sealed count is minted minus opened; unminted count is cap minus minted. Opening lowers sealed supply; it never guarantees appreciation. Unminted packs must not be described as already in circulation.
- Operations collateral reserves four eventual trait claims for every sold sealed pack. Creator withdrawals and pool retirement cannot bypass that obligation. The current conservative reserve is 0.048 SOL per sold/unsettled pack plus the shared 0.1 SOL provider reserve. This is collateral, not a promise that it will all be spent. NFT/receipt/collection rent and transaction fees are separate.
- An ordinary external burn is blocked by the immutable Core Oracle adapter. Redemption temporarily permits the burn within the atomic opening transaction. Owner/delegate metadata edits do not authorize redemption.

## Source boundaries

- `program/src/sealed.rs`: release, mint and redeem opcodes 30–32; new account discriminators/seeds isolate this extension.
- `program/src/epoch.rs`: one shared ticket-admission path for direct purchases and validated prepaid redemption. Legacy direct purchases retain the old path; sealed-only pools reject it.
- `client/sealed.mjs`: canonical sealed account decoders and instruction builders. Wallets should use the existing explicit-chain sender and pending-transaction storage, not server-provided signing keys.
- `client/tensor-market.mjs`: reused optional venue adapter with pinned SDK dependencies. No live marketplace UI/indexing acceptance is claimed.
- `qa/trait-packs/sealed-preview.*`: loopback-only generated-key QA host and UI. These are not production wallet authentication or a public service. No real keys, source art or public uploads are used.

## Local proof

`qa/trait-packs/sealed-smoke.ts` builds actual Core pack assets and executes supply cap, ordinary burn rejection, Tensor list/cancel/relist/buy, escrow ownership, old-owner rejection, ticket bypass rejection, exact-price checks, rollback after burn, double-open rejection, four delivered Core traits and timeout refund. Creator and IQ payout amounts and reserved operations collateral are checked. Original direct-pack smoke tests also run against the changed ELF.

`sealed-ui.test.mjs` tests confirmation/cancellation, duplicate-action locking and actor continuity in a DOM fixture. The HTTP rehearsal exercises the retained Surfpool preview. Neither substitutes for visual browser acceptance.

Standalone protocol preview: http://127.0.0.1:4590/ . Test accounts are Collector A/B; the local confirmation dialog is deliberately not a Phantom prompt. The actual-source IQ page is also hosted at http://127.0.0.1:4592/ with generated Wallet Standard adapters. Its current collection is returned by `/qa/config`; the adapters keep generated secrets in the QA host and expose only signatures.

## Remaining acceptance

- Desktop/mobile source-page checks and screenshots have been captured locally; physical-wallet acceptance remains separate.
- The paired local frontend now includes the actual creator opt-in, packs page, Wallet Standard sender and persistent receipt index. This mounting is covered by DOM/HTTP/Surfpool tests; local browser review is complete, while physical wallets/public indexing have not been accepted.
- Review the escrow-until-open policy, operations capital, permanent pack media, recovery economics and public upgrade authority before any release.
- Multiple separate releases for one existing collection remain a future pool-versioning change; this prototype supports one fresh sealed pool/release per collection.
- Public oracle and marketplace ingestion/device acceptance are outside local Surfpool proof. No outcome/rareness/value guarantee is made.

## Integrated source and caching

The paired frontend branch is `codex/sealed-packs-ui-local-20261101` in
`iq6900-sealed-local-20261101`. `nft_sealed_packs.mjs` mounts only when both the
confirmed state and host config explicitly enable sealed mode. The creator
checkbox is likewise hidden without that host capability. It publishes a
separate fixed-supply pack collection before the first epoch; existing active
legacy pools are not silently migrated. Pack metadata must already be an IQ
inscription on the configured gateway. Source-art consent remains separate.

`sealed-state.mjs` uses the incumbent SQLite database for asset discovery. A
notification accepts only bounded lists of receipts verified on the configured
chain/program; it never accepts owner/payment claims from the caller. Reads
page at 24 assets and reread Core ownership at a confirmed slot. A restart
retains indexed asset IDs. An external minting client must notify this endpoint
or supply a separately verified indexer backfill; no global RPC scan runs.

`sealed-wallet.mjs` reuses the incumbent explicit-chain sender and durable
purchase checkpoint. Lost confirmations or indexing failures retain the signed
identity; the UI cannot silently replay a purchase. On-demand opening can wait
for a budgeted window, then burns the pack without charging another primary
purchase price. Historical openings use their epoch cursor, and pending reads
are bounded to two minutes.

Tensor's SDK is in a separate lazy browser bundle. The build keeps IQ's web3 v1
wallet boundary while allowing Tensor's pinned v2 resolver imports, rather than
rewriting them with a global alias. Ordinary collections remain unmodified.
