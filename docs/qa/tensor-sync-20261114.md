# Tensor sync verification — November 14, 2026

Reconciled onto `b004abc6ee1c1b8d4131a2c890d2c785e8e33797`.

Only production changes: a 10-second request deadline and one shared in-flight `syncAll` promise. Existing fifty-event history cap, sales coverage, listing snapshots, inscription links and activity remain intact.

`bun test tests/tensor.test.ts`: 7 pass, 0 fail, 39 assertions. Uses the actual temporary SQLite schema with fixture HTTP responses. Checks collection ID caching, sale deduplication, cache-only reads, outage retention, overlapping calls, timeout recovery, devnet/no-key skipping, listing snapshots and the history limit. The timeout test confirms the configured 10,000ms and accelerates the abort to 5ms.

`bun build backend/src/server.ts --target=bun --outfile=/tmp/iq-tensor-backend-20261114.js`: passed, 1,952 modules. Dependencies reused from the existing local checkout; no dependency or lockfile changes.

`git diff --check`: passed. No live Tensor requests, chain writes, or production ingestion verification in this run.

## Follow-up on November 23, 2026

Retested PR #3 with main at `45ff6bd` using fixture HTTP responses and a temporary SQLite database. Seven tests passed with 65 assertions. A 102-item collection issued batches of 100 and two, retained all 101 stock listings priced in its collection token, and excluded the SOL-priced listing. A stalled second batch aborted at the configured request deadline and kept the previous complete snapshot. Concurrent calls shared the same sync, and the next successful run refreshed the listings. The test accelerated the deadline while checking the configured 10,000 ms value. The Bun server build passed.
