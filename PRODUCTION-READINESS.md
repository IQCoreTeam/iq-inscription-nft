# Packs production follow-up — local, unshipped

The prior local review build remains on its original branches. This branch starts a new production-facing phase; it is not a claim that the application or deployment is finished. No remote PR, public program, public Nubbies media or mainnet write has changed.

## Implemented and checked

- V5 pools/epochs have separate addresses and format tags. Deploy V5 under a separate pack-program ID; do not replace an active V4 program in place, since this decoder intentionally rejects V4 sale accounts. Keep any V4 program available for its outstanding claims/refunds. The paired IQ hook supports both formats.
- Creator price plus the existing IQ convention of a fixed 5% surcharge. The recipient matches the IQ NFT program's constant. Both amounts stay in escrow; successful complete delivery pays the creator and IQ, while failed delivery refunds the entire pack payment. Network transaction fees are separate.
- The signed V5 purchase encodes the expected total. Omitting the surcharge or submitting a mismatched total fails on chain. The client also requires the displayed quote before requesting a signature.
- The real Wallet Standard client path uses the existing sender, with chain/genesis binding, account-change detection, simulation/preflight, exact message/signature checks, confirmation and no automatic replay after uncertain submission.
- Sale quotes use two dependent confirmed RPC reads with minimum-context-slot ordering; concurrent/warm reads coalesce for one second, invalidation follows writes, and there is no background polling. Mutable program/Core state belongs on RPC; IQ's existing gateway remains the cache for immutable media/recipes. Do not send arbitrary Core/pack transactions to IQ table `/notify`.
- Paired IQ hook accepts correctly bound V4 and V5 pool addresses. Existing V4 consent still passes on Surfpool.

Private, generated-key evidence: `/Users/nubs/Documents/ChatGPT/test/artifacts/iq-packs-production-20261030/`. The V5 money-flow proof includes a real Wallet Standard-shaped signed purchase on isolated Surfpool, successful creator/IQ payouts, total-payment mismatch rejection, full-payment refund, early/duplicate payout rejection and wrong-recipient rejection. This is not physical Phantom/mobile or public-devnet acceptance.

## Funding model to make explicit

The creator must fund the program's operations PDA for Core trait-account rent before buyers can purchase; the chain and the sale quote both reject insufficient reserve. The buyer's escrow must never be borrowed to pay operations. A production relay would use the existing backend's operator identity for network/oracle expenses and later receive the fixed platform fee after delivery. Running that relay and funding its initial balance require the operator's agreement; the fee is gross revenue, not guaranteed profit. Actual provider fees, account rent and setup/network costs must be quoted before funding. Do not quietly subsidize this from a user's wallet or introduce a backend-held buyer key.

## Additional local evidence

- Chrome wallet component and allowlisted HTTP sale API: generated Surfpool wallet, 0.105 test-SOL purchase, confirmed receipt and disconnect. Not Phantom/mobile acceptance. The private QA signer route must never be published.
- Durable purchase checkpoint before broadcast; unresolved signatures block retries. Operator payout recovery reloads its checkpoint and reconciles without a second payout. Lost-response and expired-unknown cases have unit tests.
- IQ SDK media writing used a wallet signer interface without a secretKey field, synthetic JSON and exact cached readback. Repeated reads used one chain lookup. No public/private Nubbies media was uploaded.
- Moderate npm advisories inherited through web3.js/Jayson/uuid remain documented. The advertised web3 fix is a major upgrade, so no blind breaking change was made.

## Still to finish

1. Mount the tested wallet component and allowlisted sale API into the final app/backend bootstrap, including the existing page lifecycle and styling; remove the test-actor transport from that mode. Confirm with a real extension/device on the intended network.
2. Connect the tested epoch-decision/recovery modules to the existing backend database lease/job lifecycle and production instruction/provider adapters. Do not put a creator's or buyer's private key on that backend. Read ORAO's actual network treasury/fee configuration for each cluster, prepare resumable requests/claims/refunds, and test operational recovery before a public rollout.
3. Mount the tested wallet-signer media context in the creator page with the approved kit, explicit publication consent and durable checkpoints. The verified full-kit wallet-signer proof still runs in the local host harness, not permission to upload a user's keys to a server. Preserve read-back hashes, durable receipts, unknown-outcome recovery and explicit source-layer publication consent. Keep Nubbies source layers private until separately approved.
4. Prepare exact cluster/program/authority/media manifests and live rent/funding estimates. The devnet IQ program currently requires upgrade authority `8QWrZjNNFzngKWCLCrFkAy7ydnagrBSVYdJFyEvw9agh` (read using `solana program show`, 2026-10-30). Deployment needs that authority or a clearly separate, approved test deployment; do not silently change IQ's official program.
5. Final paired review, reproducible build/evidence package and approval before any PR/code/media update.

## Build diagnostic retained

Metaplex 0.11.2 emits a compile diagnostic for `registry_records_to_plugin_list`. That function is absent from the linked unstripped pack ELF; its `.text` bytes match the stripped deployed artifact, and inspected direct R10 displacements are at most 4096. See LINK-CHECK.json and the build/disassembly records. These checks do not constitute a general memory-safety audit; the diagnostic is not hidden or claimed fixed by the fee change.

## Upstream references

- Current IQ backend main: `98781d4bedffbef194ff0f144d65fdce1509068b`.
- Existing feature discussion draft: IQCoreTeam/iq-inscription-nft #6, still at `f04ddba` when checked.
- Official ORAO integration: https://github.com/orao-network/solana-vrf (network treasury comes from its configuration; local fixture settings are not production settings).
