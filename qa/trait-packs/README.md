# Synthetic offline packs reproduction

This optional QA package reproduces the paid-pack contract/client/backend job flow without private workspaces, source art or wallets. It is excluded from the default app/build path. All signers and provider-quorum keys are generated in memory; no private key, wallet seed or user RPC is accepted. The test uses `Surfnet.startWithConfig({offline:true})`, validates loopback RPC and deploys supplied binaries **only into that disposable local chain**. It never calls `solana program deploy`, sends a public transaction or contacts a faucet.

## Install and build

From the repository root, install the locked extension packages needed by the tested source:

```sh
npm ci --ignore-scripts
npm ci --ignore-scripts --prefix extensions/trait-packs/client
npm ci --ignore-scripts --prefix extensions/trait-packs/creator
npm ci --ignore-scripts --prefix extensions/trait-packs/operator
npm ci --ignore-scripts --prefix extensions/trait-packs/service
npm ci --ignore-scripts --prefix qa/trait-packs
cargo build-sbf --manifest-path extensions/trait-packs/program/Cargo.toml --sbf-out-dir extensions/trait-packs/program/target/deploy
cargo build-sbf --manifest-path programs/iq-inscription-nft/Cargo.toml --sbf-out-dir target/deploy
```

The tracked compiled IDL at `target/idl/iq_inscription_nft.json` must match the built IQ program. This smoke uses explicit IDL/connection/provider construction, never `Anchor.workspace`, TOML loading, a saved wallet or `AnchorProvider.env()`.

Tested runtime: Bun 1.3.14 on macOS arm64, `@solana/surfpool` 1.6.1, ORAO SDK 0.8.0, Anchor 0.32.1, Core JS 1.5.0, Umi 1.0.0 and web3.js 1.99.0. The Umi adapter overrides pin the same compatible 1.0.0 adapter family used by the backend; allowing those adapters to float to 1.6.0 alongside Umi 1.0.0 breaks their export contract. The lockfile contains registry packages only, not local links.

## External binary inputs

Core and ORAO are external programs. Supply public ELF snapshots plus their reviewed SHA256 values. Optionally obtain snapshots using these **read-only** commands; they do not deploy or sign transactions:

```sh
mkdir -p qa/trait-packs/inputs
solana --url https://api.devnet.solana.com program dump CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d qa/trait-packs/inputs/core.so
solana --url https://api.devnet.solana.com program dump VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y qa/trait-packs/inputs/orao.so
shasum -a 256 qa/trait-packs/inputs/core.so qa/trait-packs/inputs/orao.so target/deploy/iq_inscription_nft.so extensions/trait-packs/program/target/deploy/nubbies_paid_v6.so
```

Review the output and set the expected hashes explicitly. Never bypass a mismatch by silently accepting a different program. Public devnet programs can be upgraded, so a fresh dump may differ from the snapshots used for a particular result. Inputs are ignored by Git; no `.so`, snapshots, keypairs or environment files belong in the PR.

Known public snapshots used in the local proof:

| Input | Program | SHA256 |
| --- | --- | --- |
| Core | `CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d` | `7e033fd24ce189d9e7dc2600152c6c88ce80d662deeeb7ecc64f0c8437867cf7` |
| ORAO V2 | `VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y` | `f7603b1a993e7853a209a4d04e93e7b05cb41264580bb62030be0bd36889fafe` |

## Run

From `qa/trait-packs`, set these task-specific variables, replacing each hash placeholder with the reviewed output above:

```sh
export IQ_QA_CORE_BINARY="$PWD/inputs/core.so"
export IQ_QA_CORE_SHA256="<reviewed core SHA256>"
export IQ_QA_ORAO_BINARY="$PWD/inputs/orao.so"
export IQ_QA_ORAO_SHA256="<reviewed ORAO SHA256>"
export IQ_QA_IQ_SHA256="<reviewed built IQ SHA256>"
export IQ_QA_PACKS_SHA256="<reviewed built packs SHA256>"
bun smoke.ts
```

Built IQ/pack binary paths default to the repository's `target/deploy` directories. `IQ_QA_IQ_BINARY` and `IQ_QA_PACKS_BINARY` can select other reviewed local builds. The fixture verifies all four bounded ELF files before starting and rechecks their hashes around local deployment.

## What the smoke proves

- A synthetic Core collection and IQ registry/base NFT are created under the real built IQ program. Placeholder inscription references in that synthetic base are intentionally not a permanent-media test.
- A sealed synthetic trait catalog is created with the existing shared creator encoder. A Wallet Standard-shaped generated buyer signs nine actual 0.105 test-SOL purchases.
- The production operator adapter and **real Bun SQLite job store** settle the flow, reopening the database on every tick and recovering a lost response after a real broadcast.
- Nine tickets require two allocation jobs at confirmed cursors 0 and 8, then 36 actual Core rewards. Creator/IQ payout is 0.9/0.045 test SOL.
- A second isolated scenario leaves the provider request pending, advances the **local-only** test clock and proves full 0.105 buyer refund and sponsor-surplus recovery.
- The operator differs from creator/buyer. Its exact balance loss is the request funding minus recovered surplus plus recorded transaction fees. Requester balance ends at zero.
- The production page-state reader verifies the actual Core rewards, metadata hashes and ownership without generated actors or unbounded program-wide scans.

Each run writes ignored `.evidence/<run>/RESULTS.json`, SQLite journals and signed receipt identities. Generated private keys are never written. Keep raw receipts private until reviewing an explicit evidence export. Separate adversarial transition, permanent-media, real-extension and mobile evidence must not be inferred from this smoke; those remain distinct checks.

Both fixtures record hashes of the backend, pack extensions, IQ program source, QA source and compiled IDL before execution and compare them again before reporting success. The receipt therefore identifies the source tested and fails if those files change during a run. Frontend browser evidence is bound separately to its own checkout and served bundle.

## Dependency audit scope

This QA-only dependency set is pinned for the tested ORAO/Anchor ABI. npm reports inherited web3/Jayson/uuid moderate advisories and high advisories through Anchor's `toml` workspace loader. The smoke does not invoke that loader, read TOML, parse untrusted configuration, expose an HTTP server or accept untrusted input. It passes only the repository's explicit compiled IDL and generated local identities. This is an exposure boundary, **not a clean-audit claim** or a claim that those upstream advisories are fixed. Do not apply a breaking SDK downgrade/upgrade just to hide audit output; review and retest SDK changes separately. These QA dependencies are not added to the production backend's default runtime.


## Native application lifecycle

`bun native-smoke.ts` additionally exercises the optional real backend runtime against the same offline chain. It creates a second actual Core/IQ collection, inscribes a standard manifest, synthetic base image and the shared trait kit with the real IQ SDK, then invokes creator validation, wallet-native publication/setup and finalization. The incumbent SQLite schema is reused directly from the trusted repository source; no private preview registration callback is substituted. It verifies automatic sale/state/operator/outfit registration, fresh Core routing before slot reconciliation, provider-backed pack delivery, holder consent/equip/render/remove/restore, and recovery after staging and renderer caches are deleted. Validation without publication consent cannot publish. A second signed, budgeted sale window delivers the remaining four traits; totals match the two sealed definitions exactly and a signed request is refused after stock is exhausted.

This optional test also needs the reviewed **public CodeIn program ELF**, supplied explicitly as `IQ_QA_CODE_IN_BINARY` and `IQ_QA_CODE_IN_SHA256`. It never deploys this binary to a public cluster. To obtain it read-only:

```sh
solana --url https://api.devnet.solana.com program dump 9KLLchQVJpGkw4jPuUmnvqESdR7mtNCYr3qS4iQLabs qa/trait-packs/inputs/code-in.so
shasum -a 256 qa/trait-packs/inputs/code-in.so
```

The local proof used CodeIn SHA256 `db8c1025118bcb75d29105d71c2cb043c81c822bb713395ddaf131429b0244e8`. Review a new dump rather than automatically trusting an upgraded program. Set the two CodeIn variables alongside the four program inputs above, then run `bun native-smoke.ts` from this directory. All output is under ignored `.evidence/native-*/`; source contains no private absolute paths, artwork or input keys. The synthetic source PNGs are generated through the existing creator fixture.

## Authenticated ingress and large-history regression

The native lifecycle now uses the real creator HTTP handler and a generated-wallet login. It rejects unsigned staging, replay and another authenticated owner, then exercises three actual sale epochs, pages to the earlier epoch and removes a trait equipped from outside the latest page. Session expiry, origin/deployment binding and token persistence/hashing have separate regression tests.

`bun history-smoke.ts` uses the same four reviewed ELF inputs and offline fixture to create and close 70 real empty epochs (no public transactions). It then traverses all 35 two-epoch pages, including epochs 0 and 69, and verifies warm-cache coalescing. The separate account-layout regression covers 70 epochs and 280 issued trait records, with off-page equipment. The empty-epoch Surfpool proof must not be described as 280 on-chain reward mints. Both source hashes and the actual local transaction receipts are retained in ignored `.evidence/history-*/RESULTS.json`.
