# Optional packs — local review candidate

Optional follow-up to discussion draft #6. The production factories are mounted behind explicit host configuration; ordinary collections remain the default. This is a local technical-review candidate, not approval to deploy or publish private artwork.

## Implemented

- V5 uses distinct pool/epoch seeds and format tags. Deploy under a separate pack-program ID; keep V4 available for outstanding claims/refunds. The paired IQ hook accepts both correctly bound formats.
- Creator-selected fixed price plus a fixed 5% IQ surcharge, matching the NFT program treasury. Both amounts remain escrowed until complete delivery. Timeout refunds include the surcharge; network fees are separate. The signed purchase pins the displayed total.
- Creator HTTP ingress uses an origin/network/program-bound one-use wallet challenge, then a 15-minute bearer session held only in browser memory and hashed in the existing SQLite DB. Protected requests must match the authenticated owner. On-chain creator/holder checks remain independent; login cannot sign transactions.
- Actual creator and packs page integration: explicit reviewed-layer publication consent, original image hashes, wallet-signed permanent IQ publication, receipt recovery, unsigned catalog setup and confirmed finalization. Unused publication funding has a separate resumable refund.
- Wallet Standard purchase/equipment controls: explicit chain/genesis and deployment/collection/selected-NFT pins, simulation/preflight, exact signed-message checks, durable pending receipt before broadcast, and no automatic replay of uncertain submissions.
- Existing backend SQLite lifecycle: bounded leased jobs, signed bytes persisted before broadcast, restart/lost-response reconciliation, actual ORAO adapter, allocation cursors, claims, payouts, refunds and sponsor-surplus recovery. Empty pools do not endlessly create sale windows.
- Bounded job rotation prevents idle collections from starving later collections. Expired unfinished creator drafts release their quota; finalized recovery records remain intact. Pack runtime setup checks the existing SDK reader's cluster without changing the ordinary NFT reader's RPC.
- Previous epochs must finish delivery/payout or refunds and return requester surplus before the next epoch opens. Atomic sponsor sweep plus open handles donated dust without redirecting the refund.
- Holder and creator jointly approve each NFT's editable metadata. Equip/remove checks actual Core ownership. Original metadata recovery preserves the immutable burn-safety hook; re-enabling does not duplicate it.
- Finalized consent context recovers permanent recipe/trait bytes after temporary staged images are removed, using retained reviewed manifest/hash records. This is not a total-database-loss recovery claim.
- Confirmed mutable state reads are bounded, coalesced and short-lived; immutable media/recipes use IQ's gateway cache and readback hashes. No browser background polling. Core/pack transactions are not submitted to IQ's table `/notify` endpoint.

## Reproducible proof

See `qa/trait-packs/README.md` for the portable synthetic Surfpool fixture, exact binary hashes, pinned dependencies and execution steps. It checks nine Wallet Standard purchases, two allocation batches, 36 Core rewards, actual SQLite reopen/lost-response recovery, creator/IQ payouts, sponsor refunds and provider-timeout full refunds. Creator, client, operator, service and mounted-page regression suites cover the remaining boundaries. The native fixture also rejects unsigned/replayed/wrong-owner HTTP staging and traverses three real sale epochs, preserving and removing equipment issued on an older page.

Private local browser evidence covers the actual creator and packs pages: ten source artifacts published and read back, confirmed-write recovery after a cold-cache timeout and reload, unused burner balance refund, ordinary NFT mint, three paid purchases, twelve delivered Core traits, four-card reveal, holder approval, equip/remove, original metadata restoration, wallet switching and narrow-phone detail views. The original image was also decoded byte-for-byte from its inscription while the NFT used an outfit URI.

Browser QA uses generated keys, private approved preview art and a test ORAO quorum on offline Surfpool. Its private SDK shim selects the existing heavy throughput mode only for loopback; production SDK speed and wallet guards are unchanged. This is functional proof, not a public RPC throughput benchmark. The ordinary NFT upload adapter uses local immutable staging, so this does not establish live Irys acceptance. The portable fixture uses synthetic art and requires neither private Nubbies layers nor personal keys.

## Dressed NFT sales: verified foundation, unfinished product flow

Equipped traits follow the avatar's current owner through custody; they do not require separate asset transfers in the avatar sale. A fresh native Surfpool proof composes the existing outfit assertion, exact seller/royalty payments and Core transfer in one transaction. Changed outfits reject with the guard's exact error before payment; a valid sale transfers avatar control, prevents the old holder withdrawing equipped gear and allows the new holder to withdraw it.

This is a bilateral, co-signed direct-sale proof. It is not a persistent listing, offline-seller orderbook or external-marketplace integration. A production listing UI and chosen venue adapter must bind the asset, seller, price/royalties, expiry and exact loadout snapshot. The buyer must receive that outfit or reject the trade; arbitrary third-party orders do not automatically include this assertion. Reuse a compatible Core venue rather than silently treating a payment helper as a marketplace.

## Decisions and acceptance before public activation

1. Approve program ownership, upgrade authorities, V5 deployment IDs, configured cluster, permanent gateway origins, ORAO network config and relay identity. V5 is not an in-place upgrade of active V4 sales.
2. Fund explicit operations rent separately from buyer escrow. The creator funds Core reward rent; the relay sponsors network/oracle work and receives requester surplus back. The fixed IQ fee is gross revenue, not guaranteed profit. Quote current rent/provider/network costs before funding.
3. Approve the creator/holder co-sign UX. This implementation does not delegate collection-wide metadata authority or promise unattended consent.
4. Configure HTTPS/trusted-proxy ingress, staging retention and rate/demand budgets. Creator routes now require wallet-authenticated sessions; a draft ID and owner string alone are insufficient. The existing IP limiter covers sign-in/staging, sale-window requests and history reads. Host proxy/header and retention policies still require deployment review.
5. History now uses bounded, cursor-based epoch pages rather than a collection-wide cap. Two epochs yield at most 64 packs and 256 traits per page; up to six off-page equipped traits remain available. Older pages remain reachable, and operator windows/catalog validation no longer stop at the old totals. The local regression covers 70 epochs/280 traits; real-provider load/latency at intended scale remains an activation check, not proof of an unlimited indexer.
6. Complete actual extension/mobile-wallet, public-network ORAO/operator, gateway-host availability and external marketplace acceptance. Surfpool and browser-generated wallets do not establish those results. The native fixture separately verifies freshly minted Core asset routing before registered-slot reconciliation.
7. Review source, fresh screenshots/video and paired frontend/backend packaging before any remote update. Private art/layers/keys and local signer/provider harnesses stay excluded.

## Dependency/build notes

Sharp is pinned to 0.35.5. Client dependencies retain four moderate web3/Jayson/uuid advisories rather than taking an unreviewed breaking major upgrade. The optional QA dependency audit also reports Anchor's TOML workspace-loader advisories; the fixture uses an explicit IDL and never loads an untrusted workspace/TOML file. These are documented residuals, not a zero-advisory claim.

Metaplex 0.11.2 emits a stack diagnostic for `registry_records_to_plugin_list`. The fresh offline build's linked-ELF check found that function absent and direct negative R10 displacements no larger than 4096 bytes; the same binary executes in the portable smoke and native lifecycle. Neither check is a general memory-safety audit or a claim that the upstream diagnostic is fixed.

Baseline: backend main `98781d4bedffbef194ff0f144d65fdce1509068b`; the original discussion commit `f04ddba` is preserved in #6's history.
