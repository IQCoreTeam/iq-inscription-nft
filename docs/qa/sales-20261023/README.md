# Sales-sync verification — 2026-10-23

Refreshed locally on 2026-10-25 against base `8b1755df2eab34caf0d194778a2604fc5248a547`, including the shared devnet/mainnet network preset.

Run `bun test tests/tensor.test.ts`: six tests pass using the real temporary SQLite schema, generated fixture records and stubbed HTTP responses. No credentials, wallet files, chain writes or live Tensor calls are needed.

Checks cover registered-asset matching, collection-ID caching and sale deduplication, network-free cached reads, outage preservation, shared concurrent syncs, timeout cancellation/recovery, and devnet/missing-key gating. The timeout test checks the configured 10-second deadline while shortening the test timer to 5ms.

`bun build backend/src/server.ts --target bun --outfile /tmp/iq-nft-backend.js` passes. Live Tensor ingestion and deployed acceptance were not tested.
