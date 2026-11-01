# Transferable sealed packs — local candidate

This is a separate local branch, not an update to public PR #6 or frontend #15.
It has not been deployed to devnet/mainnet, published or externally reviewed.

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

Browser preview: http://127.0.0.1:4590/ . Test accounts are Collector A/B; the local confirmation dialog is deliberately not a Phantom prompt.

## Remaining acceptance

- Browser desktop/mobile review and screenshots when local browser control is enabled.
- Integrating this new sealed mode into the actual IQ creator/market screens with real Wallet Standard signing and persistent indexer discovery. The isolated QA page demonstrates the protocol flow, not completion of that production UI integration.
- Review the escrow-until-open policy, operations capital, permanent pack media, recovery economics and public upgrade authority before any release.
- Multiple separate releases for one existing collection remain a future pool-versioning change; this prototype supports one fresh sealed pool/release per collection.
- Public oracle and marketplace ingestion/device acceptance are outside local Surfpool proof. No outcome/rareness/value guarantee is made.
