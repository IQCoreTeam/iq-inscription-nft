# iq-inscription-nft

Registry program for IQ inscription NFTs: one plain Metaplex Core asset per verified IQ inscription, collections whose update authority is a program PDA, and a registrar co-signature as the only door in. A fork of bible-nft's registrar generalized from "one Bible verse" to "one creator item".

Spec: IQCoreTeam/iq6900 issue #11.

## What the program enforces

- an item index is usable at most once per collection (`ItemSlot` PDA init)
- an inscription is usable at most once anywhere (`InscriptionRecord` PDA init)
- only the registrar may admit an asset into a collection (co-signature)
- the collection authority is a PDA, so no key exists to forge membership
- the price (minus the deposit paid at reservation) goes to the creator; the platform fee (a program constant, bps of the price) goes to the platform treasury

What it does not enforce: that the inscription behind `inscription_sig` holds the bytes recorded in the collection manifest. A program cannot read another transaction, so the registrar verifies that before co-signing; the manifest hash and sig stay committed in the registry so anyone can re-verify.

## Instructions

| ix | who signs | what |
|---|---|---|
| `initialize_registry` | payer (the creator's burner) | one registry per Core collection; `admin` is an arg so the creator wallet holds the admin rights |
| `register_item` | minter (burner, fee payer) + registrar | slot + inscription record + Core asset to `owner`; Attributes `index`, `inscription`, `metadata`, `std` |
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
