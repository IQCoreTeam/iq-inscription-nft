# iq-inscription-nft

Registry program for IQ inscription NFTs: one plain Metaplex Core asset per verified IQ inscription, collections whose update authority is a program PDA, and a registrar co-signature as the only door in. A fork of bible-nft's registrar generalized from "one Bible verse" to "one creator item".

Spec: IQCoreTeam/iq6900 issue #11.

## What the program enforces

- an item index is usable at most once per collection (a minted bitmap in the registry: one bit per index, set by `register_item`, refused if already set)
- an inscription is usable at most once anywhere (`InscriptionRecord` PDA init)
- only the registrar may admit an asset into a collection (co-signature)
- the collection authority is a PDA, so no key exists to forge membership
- the price (minus the deposit paid at reservation) goes to the creator; the platform fee (a program constant, bps of the price) goes to the platform treasury

What it does not enforce: that the inscription behind `inscription_sig` holds the bytes recorded in the collection manifest. A program cannot read another transaction, so the registrar verifies that before co-signing; the manifest hash and sig stay committed in the registry so anyone can re-verify.

## Instructions

| ix | who signs | what |
|---|---|---|
| `initialize_registry` | payer (the creator's burner) | one registry per Core collection; `admin` is an arg so the creator wallet holds the admin rights |
| `register_item` | minter (burner, fee payer) + registrar | sets the index bit + inscription record + Core asset to `owner`; Attributes `index`, `inscription`, `metadata`, `std` |
| `register_single` | minter + registrar | single NFT into a registry with `max_supply` 0; inscription record only |
| `set_price`, `set_frozen`, `rotate_registrar` | admin | |
| `set_royalties` | admin | rewrites the collection's Royalties plugin through the PDA |
| `update_asset_uri`, `update_collection_uri` | admin | uri only, never the name or the Attributes (gateway host moves) |

## Build and test

```
anchor build
anchor test --skip-build
```

`anchor test` starts a local validator with mpl-core and the platform treasury cloned from mainnet (Anchor.toml). The test table lives in `tests/registry.test.ts`.

On this Mac the host-side build scripts need the CommandLineTools toolchain:

```
export DEVELOPER_DIR=/Library/Developer/CommandLineTools
```

## Backend

Full description with diagrams: [backend/README.md](backend/README.md).

`backend/` is the reserve / verify / co-sign service (Bun + Hono + SQLite), a fork of bible-nft's backend generalized to many collections. One process serves every collection; collections and their item manifests live in SQLite, the registrar key and the RPC pool stay in the process.

```
cp backend/.env.example backend/.env   # fill in REGISTRAR_KEYPAIR, RPC_URLS, ...
bun install && (cd backend && bun install)
bun --env-file=backend/.env backend/src/server.ts
```

Routes: `GET /c`, `GET /c/:slug`, `GET /c/:slug/items`, `POST /c/:slug/reserve` (wallet, burner, depositSig), `POST /c/:slug/reserve/touch`, `POST /c/:slug/reserve/cancel`, `GET /c/:slug/json/:index?c=C` (the canonical metadata the minter inscribes as M), `POST /c/:slug/mint` (reservationId, inscriptionSig, metaSig, asset; returns the registrar-signed tx), `POST /single/mint`, `GET /c/:slug/verify/:index`, `GET /c/:slug/recent`, `GET /stats`.

Scripts (run with `bun --env-file=backend/.env.<cluster> backend/scripts/<name>.ts`):

- `deploy-collection.ts --dir <folder> --slug ... --creator <keypair>`: folder of `N.png` (+ optional `N.json`) -> Arweave -> manifest + collection.json inscriptions -> Core collection under the program PDA -> `initialize_registry` -> backend DB -> feed row. `--single` makes a max_supply 0 registry for single NFTs.
- `mint-e2e.ts --slug ... --funder <keypair>`: a script wallet with a site-style burner goes through deposit, reserve, image inscription, metadata inscription, verify + co-sign, landing, reconcile, public verify, the rejection path, and a DB-wipe rebuild.
- `rules-e2e.ts --funder <keypair>`: deploys its own 6-item collection with a short TTL and checks the rules, cancel, touch, expiry, a multi-chunk image, the limits, the read routes and the single-NFT route (12 checks).

## Devnet (2026-10-17)

| | |
|---|---|
| program | `FCGhsCf5sMM7Z5APta1hi76WGTvrfMJnBr4QSR3w13Fu` (upgrade authority: the deploy wallet) |
| test collection `test-monks` | Core collection `GGATdiggheD9GiGd4PYuwigJDqGTWS1Gg5fGWR3EuaN7`, registry `H53fr5GmxmUVhKeLa3eECL9jgk9FKuN7fE6MPTz54Bt4`, 5 items, price 0.01 SOL, deposit 0.002 SOL |
| single-NFT collection `iq6900-inscriptions` | Core collection `HjnPauwiZ4xnPCH5vWbiiDiRG8pPn9Mgi5Q9uJ266ZjD`, registry `33oFdBncytyYNXg1V578crE9Du6Y3Xp2QRsU5W9rzBFU` |

`mint-e2e.ts` passes 12 checks against `test-monks` on devnet.
