# Tensor sync verification — November 14, 2026

Reconciled onto `b004abc6ee1c1b8d4131a2c890d2c785e8e33797`.

Only production changes: a 10-second request deadline and one shared in-flight `syncAll` promise. Existing fifty-event history cap, sales coverage, listing snapshots, inscription links and activity remain intact.

`bun test tests/tensor.test.ts`: 7 pass, 0 fail, 39 assertions. Uses the actual temporary SQLite schema with fixture HTTP responses. Checks collection ID caching, sale deduplication, cache-only reads, outage retention, overlapping calls, timeout recovery, devnet/no-key skipping, listing snapshots and the history limit. The timeout test confirms the configured 10,000ms and accelerates the abort to 5ms.

`bun build backend/src/server.ts --target=bun --outfile=/tmp/iq-tensor-backend-20261114.js`: passed, 1,952 modules. Dependencies reused from the existing local checkout; no dependency or lockfile changes.

`git diff --check`: passed. No live Tensor requests, chain writes, or production ingestion verification in this run.
