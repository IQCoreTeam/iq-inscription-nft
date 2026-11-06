# Optional sealed trait packs — local readiness

Local review, November 5, 2026. Backend draft #6 is at `219d421` and paired frontend draft #15 is at `1d63fe1`. The local follow-up adds startup, image packaging and provider funding checks for the optional feature.

## Implemented local product

- Creator explicitly opts in, validates compatible layers and supplies, consents to permanent IQ media publication and signs collection-specific setup. Ordinary collection creation stays the default.
- Packs discovery uses a dedicated PACKS tab, supported collection cards/pages and MANAGE OUTFIT under supported holdings. No pack entry is shown for an ordinary collection or absent deployment configuration.
- V6 sealed packs are fixed-supply Core NFTs: buy, hold, transfer, list/cancel/buy through the Tensor adapter, then current-holder opening consumes the sealed pack and delivers four trait NFTs. One sealed release per collection is implemented; multiple future seasons are not.
- Creator sets the base price. A proposed fixed 5% IQ surcharge is added. The original purchase payment stays escrowed until delivery; timeout refunds cover that payment, not a secondary buyer's resale markup. Network/account costs are separate. These economics need maintainer approval.
- The existing operator/job runner handles preparation, provider randomness, delivery, payout and interrupted-operation recovery. Purchase/open/signing actions pin network, collection, current wallet, message and pending receipt before broadcast.
- Creator authentication uses one-use wallet challenges and short-lived sessions. Ownership and on-chain consent are independently checked. History/state reads are bounded and cached; immutable media is hash-verified through the gateway. Ordinary Core transfers are not sent to the IQ table notify endpoint.
- Holder opt-in, compatible equip/remove, original metadata restoration and the transfer-safe outfit guard are implemented. An equipped outfit remains bound to its avatar custody. Guarded sale assertions must be supported by the chosen venue; arbitrary external orders do not automatically promise an exact loadout.

## Evidence and limits

The portable offline Surfpool fixtures in `qa/trait-packs/README.md` cover generated-wallet purchases, sealed resale/opening, operator recovery, payouts/refunds, native IQ publication and holder outfit operations. Receipts identify binary hashes and source snapshots. Historical results must not be presented as a fresh run. Synthetic provider fulfillment proves the integration locally, not public-network ORAO availability.

November 3 fresh regression runs: client 73, creator 30, operator 20, service 25, paired UI 57 and paired site 146 pass. The site suite also passes in parallel after replacing the attachment fixture's FileReader timing assumption with completion-based waiting. The UI's ordinary-collection comparison now uses the current owner-holdings API. These two test corrections are local.

No independent marketplace is required for pack checkout, opening or outfit management. Existing external-market adapters remain distinct from marketplace indexing/acceptance. The separate ordinary in-site marketplace experiment is parked.

## Before public activation

1. Maintainer approval of program IDs/upgrade authority, IQ hook compatibility, cluster/genesis, ORAO configuration, operator identity and HTTPS/proxy/request-origin policy.
2. Approve creator/platform economics and fund explicit media, account-rent and operator reserves. Buyer escrow cannot be treated as available operating revenue.
3. Publish each collection's final reviewed trait layers, masks, metadata and recovery recipe to permanent IQ storage; configure reachable gateways and verify readback. Nubbies artwork remains private and unfinished.
4. Test physical extension/mobile wallets, live provider/operator recovery and external marketplace transfer/indexing behavior. Local generated-wallet tests do not establish these.
5. Review final source and evidence before updating drafts. No deployment, mainnet spending, private art or personal keys are authorized by this document.

### Runtime configuration

The normal backend starts with packs disabled. To activate packs on an approved deployment, mount an operator keypair separately from the NFT registrar and set `PACK_OPERATOR_KEYPAIR` to its absolute path. Set `PACK_RUNTIME_CONFIG` to the absolute path of a mounted JSON file with the following reviewed values:

| Field | Value to review |
| --- | --- |
| `program` | Deployed pack program ID and verified upgrade authority |
| `providerTreasury` | Treasury read from the ORAO deployment |
| `origin`, `requestOrigins` | Exact backend origin and HTTPS browser origins |
| `stagingRoot`, `renderRoot` | Absolute paths on storage writable by the backend |
| `window`, `timeout` | Approved sale window and provider timeout, in slots |
| `operationsReserveLamports` | Creator reserve target, with the contract enforcing per-pack collateral |
| `requestFundingLamports` | Per-request budget covering the current provider fee and pending-account rent |
| `maxWindowsPerDay` | Operator window budget from 1 to 32 |

The backend uses the existing cluster's RPC, gateway and NFT program. Startup checks the RPC genesis, executable programs and provider terms. The operator checks fee and rent before signing new windows or randomness requests. Monitor pending requests and verify recovery on a second RPC with the same genesis before activation.

If a media write fails without a transaction signature, publication preserves its checkpoint and stops. Resolve the transaction outcome before starting a replacement publication. The creator can resume by supplying a confirmed signature whose bytes match the interrupted inscription.

## Deferred features

Multiple releases/seasons per collection and an IQ-owned general marketplace are outside the current completed local flow. Do not expose unsupported controls or promise either capability.

## Dependency limits

Pinned packages and vendor licenses are retained. Inherited web3/Jayson/uuid advisories and QA-only Anchor workspace-loader advisories remain documented; this is not a zero-advisory or comprehensive security-audit claim. Metaplex build diagnostics must be assessed alongside exact ELF hashes and native execution receipts rather than hidden or treated as proof of safety.
