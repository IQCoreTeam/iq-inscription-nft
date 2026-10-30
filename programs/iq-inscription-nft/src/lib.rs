// iq-inscription-nft: the only door into an IQ inscription NFT collection.
//
// A fork of bible-registrar generalized from "one Bible verse" to "one creator
// item". What the program enforces on-chain:
//   - an item index is usable at most once per collection (a minted bitmap in
//     the registry: one bit per index, set by register_item, refused if set)
//   - an inscription is usable at most once anywhere (InscriptionRecord PDA init)
//   - only the registrar may admit an asset into a collection (co-signature)
//   - the collection authority is a PDA, so no key exists to forge membership
//   - the price (minus the deposit paid at reservation) goes to the creator and
//     the platform fee, a program constant, goes to the platform treasury
//
// What it deliberately does not enforce: that the inscription behind
// inscription_sig holds the bytes recorded in the collection manifest. A program
// cannot read another transaction, so that is the registrar's job before it
// co-signs; the manifest hash stays committed here so anyone can re-verify.
use anchor_lang::prelude::*;
use anchor_lang::system_program;
use mpl_core::instructions::{
    CreateV2CpiBuilder, UpdateCollectionPluginV1CpiBuilder, UpdateCollectionV1CpiBuilder,
    UpdateV2CpiBuilder,
};
use mpl_core::types::{
    Attribute, Attributes, Creator, Plugin, PluginAuthorityPair, Royalties, RuleSet,
};

use mpl_core::instructions::AddExternalPluginAdapterV1CpiBuilder;
use mpl_core::types::{
    ExternalCheckResult, ExternalPluginAdapterInitInfo, ExtraAccount, HookableLifecycleEvent,
    Key as CoreKey, OracleInitInfo, PluginAuthority, Seed, UpdateAuthority, ValidationResultsOffset,
};

declare_id!("FCGhsCf5sMM7Z5APta1hi76WGTvrfMJnBr4QSR3w13Fu");

const REGISTRY_SEED: &[u8] = b"registry";
const INSCRIPTION_SEED: &[u8] = b"inscription";
const COLLECTION_AUTH_SEED: &[u8] = b"collection-auth";
const MAX_NAME_BYTES: usize = 80;
const MAX_URI_BYTES: usize = 160;
const STD: &str = "iqnft-0.1";

// Platform fee on every paid mint, charged to the minter on top of the price so a
// creator cannot dodge it through the deposit split. Constants, not registry
// fields: the creator signs initialize_registry and must not be able to zero it.
const PLATFORM_FEE_BPS: u64 = 500;
const PLATFORM_TREASURY: Pubkey = pubkey!("EWNSTD8tikwqHMcRNuuNbZrnYJUiJdKq9UXLXSEU4wZ1");

#[program]
pub mod iq_inscription_nft {
    use super::*;

    // One registry per Core collection. The signer (the creator's burner in the
    // wizard) only pays; `admin` is passed explicitly so the creator's wallet,
    // not the burner, holds set_price / set_frozen / set_royalties.
    #[allow(clippy::too_many_arguments)]
    pub fn initialize_registry(
        ctx: Context<InitializeRegistry>,
        max_supply: u32,
        manifest_hash: [u8; 32],
        manifest_sig: [u8; 64],
        shuffle_commit: [u8; 32],
        registrar: Pubkey,
        admin: Pubkey,
        price_lamports: u64,
        deposit_lamports: u64,
        treasury: Pubkey,
    ) -> Result<()> {
        require!(deposit_lamports <= price_lamports, ErrorCode::DepositOverPrice);
        // The collection must already be under our PDA, otherwise the whole
        // "no key exists to forge membership" property is a lie.
        require_keys_eq!(
            collection_update_authority(&ctx.accounts.collection)?,
            ctx.accounts.collection_auth.key(),
            ErrorCode::CollectionNotUnderProgramAuthority
        );

        let registry = &mut ctx.accounts.registry;
        registry.bump = ctx.bumps.registry;
        registry.collection_auth_bump = ctx.bumps.collection_auth;
        registry.collection = ctx.accounts.collection.key();
        registry.registrar = registrar;
        registry.admin = admin;
        registry.treasury = treasury;
        registry.max_supply = max_supply;
        registry.minted = 0;
        registry.price_lamports = price_lamports;
        registry.deposit_lamports = deposit_lamports;
        registry.manifest_hash = manifest_hash;
        registry.manifest_sig = manifest_sig;
        registry.shuffle_commit = shuffle_commit;
        registry.frozen = false;
        registry.minted_bitmap = vec![0u8; Registry::bitmap_len(max_supply)];
        Ok(())
    }

    // Collection item: flip the index's bit + global inscription record + Core asset.
    // The minter account is the fee payer (the user's burner); the asset goes to
    // `owner` (the user's wallet).
    pub fn register_item(
        ctx: Context<RegisterItem>,
        index: u32,
        content_hash: [u8; 32],
        inscription_sig: [u8; 64],
        meta_sig: [u8; 64],
        name: String,
        uri: String,
    ) -> Result<()> {
        let registry = &ctx.accounts.registry;
        require!(!registry.frozen, ErrorCode::Frozen);
        require_keys_eq!(
            ctx.accounts.registrar.key(),
            registry.registrar,
            ErrorCode::UnauthorizedRegistrar
        );
        require!(
            index >= 1 && index <= registry.max_supply,
            ErrorCode::IndexOutOfRange
        );
        require!(name.len() <= MAX_NAME_BYTES, ErrorCode::NameTooLong);
        require!(uri.len() <= MAX_URI_BYTES, ErrorCode::UriTooLong);
        let price = registry.price_lamports;
        // The deposit was paid to the creator at reservation (off-chain, plain
        // transfer), so only the remainder moves here. The platform fee is on the
        // full price and comes from the minter on top.
        let due = price.saturating_sub(registry.deposit_lamports);
        let collection = registry.collection;

        // The "one token per number" mark. The runtime cannot know whether #57
        // exists, so the registry remembers: bit set means sold.
        let (byte, mask) = Registry::bit(index);
        let registry = &mut ctx.accounts.registry;
        require!(registry.minted_bitmap[byte] & mask == 0, ErrorCode::IndexAlreadyMinted);
        registry.minted_bitmap[byte] |= mask;
        registry.minted = registry.minted.checked_add(1).unwrap();

        let record = &mut ctx.accounts.inscription_record;
        record.bump = ctx.bumps.inscription_record;
        record.asset = ctx.accounts.asset.key();
        record.collection = collection;
        record.index = index;
        record.content_hash = content_hash;
        record.meta_sig = meta_sig;

        pay(
            &ctx.accounts.system_program,
            &ctx.accounts.minter,
            &ctx.accounts.treasury,
            &ctx.accounts.platform_treasury,
            due,
            price,
        )?;

        // On-chain identity, derived from args so it costs no transaction bytes:
        // index as decimal, sigs as lowercase hex (base58 is an expensive bignum
        // loop on-chain, hex is a table lookup).
        let attribute_list = vec![
            Attribute { key: "index".to_string(), value: index.to_string() },
            Attribute { key: "inscription".to_string(), value: hex_lower(&inscription_sig) },
            Attribute { key: "metadata".to_string(), value: hex_lower(&meta_sig) },
            Attribute { key: "std".to_string(), value: STD.to_string() },
        ];
        create_asset(
            &ctx.accounts.mpl_core_program,
            &ctx.accounts.asset,
            &ctx.accounts.collection,
            &ctx.accounts.collection_auth,
            &ctx.accounts.minter,
            &ctx.accounts.owner,
            &ctx.accounts.system_program,
            ctx.accounts.registry.key(),
            ctx.accounts.registry.collection_auth_bump,
            name,
            uri,
            attribute_list,
        )
    }

    // Single NFT from the user's own inscription into a registry that has no item
    // manifest (max_supply 0). No slot, no deposit; the inscription record alone
    // keeps "one NFT per inscription".
    pub fn register_single(
        ctx: Context<RegisterSingle>,
        inscription_sig: [u8; 64],
        meta_sig: [u8; 64],
        name: String,
        uri: String,
    ) -> Result<()> {
        let registry = &ctx.accounts.registry;
        require!(!registry.frozen, ErrorCode::Frozen);
        require_keys_eq!(
            ctx.accounts.registrar.key(),
            registry.registrar,
            ErrorCode::UnauthorizedRegistrar
        );
        require!(registry.max_supply == 0, ErrorCode::NotASingleRegistry);
        require!(name.len() <= MAX_NAME_BYTES, ErrorCode::NameTooLong);
        require!(uri.len() <= MAX_URI_BYTES, ErrorCode::UriTooLong);

        let record = &mut ctx.accounts.inscription_record;
        record.bump = ctx.bumps.inscription_record;
        record.asset = ctx.accounts.asset.key();
        record.collection = registry.collection;
        record.index = 0;
        record.content_hash = [0u8; 32];
        record.meta_sig = meta_sig;

        let price = registry.price_lamports;
        pay(
            &ctx.accounts.system_program,
            &ctx.accounts.minter,
            &ctx.accounts.treasury,
            &ctx.accounts.platform_treasury,
            price,
            price,
        )?;

        let registry = &mut ctx.accounts.registry;
        registry.minted = registry.minted.checked_add(1).unwrap();

        let attribute_list = vec![
            Attribute { key: "inscription".to_string(), value: hex_lower(&inscription_sig) },
            Attribute { key: "metadata".to_string(), value: hex_lower(&meta_sig) },
            Attribute { key: "std".to_string(), value: STD.to_string() },
        ];
        create_asset(
            &ctx.accounts.mpl_core_program,
            &ctx.accounts.asset,
            &ctx.accounts.collection,
            &ctx.accounts.collection_auth,
            &ctx.accounts.minter,
            &ctx.accounts.owner,
            &ctx.accounts.system_program,
            ctx.accounts.registry.key(),
            ctx.accounts.registry.collection_auth_bump,
            name,
            uri,
            attribute_list,
        )
    }

    pub fn rotate_registrar(ctx: Context<AdminOnly>, new_registrar: Pubkey) -> Result<()> {
        ctx.accounts.registry.registrar = new_registrar;
        Ok(())
    }

    pub fn set_frozen(ctx: Context<AdminOnly>, frozen: bool) -> Result<()> {
        ctx.accounts.registry.frozen = frozen;
        Ok(())
    }

    pub fn set_price(
        ctx: Context<AdminOnly>,
        price_lamports: u64,
        deposit_lamports: u64,
        treasury: Pubkey,
    ) -> Result<()> {
        require!(deposit_lamports <= price_lamports, ErrorCode::DepositOverPrice);
        let registry = &mut ctx.accounts.registry;
        registry.price_lamports = price_lamports;
        registry.deposit_lamports = deposit_lamports;
        registry.treasury = treasury;
        Ok(())
    }

    // Secondary-sale royalties live in the collection's Royalties plugin. The
    // collection authority is our PDA, so the creator's wallet changes them here.
    pub fn set_royalties(
        ctx: Context<UpdateCollection>,
        basis_points: u16,
        creators: Vec<RoyaltyCreator>,
    ) -> Result<()> {
        let registry_key = ctx.accounts.registry.key();
        let auth_seeds: &[&[u8]] = &[
            COLLECTION_AUTH_SEED,
            registry_key.as_ref(),
            &[ctx.accounts.registry.collection_auth_bump],
        ];
        UpdateCollectionPluginV1CpiBuilder::new(&ctx.accounts.mpl_core_program)
            .collection(&ctx.accounts.collection.to_account_info())
            .authority(Some(&ctx.accounts.collection_auth.to_account_info()))
            .payer(&ctx.accounts.admin.to_account_info())
            .system_program(&ctx.accounts.system_program.to_account_info())
            .plugin(Plugin::Royalties(Royalties {
                basis_points,
                creators: creators
                    .into_iter()
                    .map(|c| Creator { address: c.address, percentage: c.percentage })
                    .collect(),
                rule_set: RuleSet::None,
            }))
            .invoke_signed(&[auth_seeds])?;
        Ok(())
    }

    // uri only, never the name or the Attributes: the identity of an asset can
    // never be edited, even by us. For gateway host moves.
    pub fn update_asset_uri(ctx: Context<UpdateAssetUri>, new_uri: String) -> Result<()> {
        write_asset_uri(
            &ctx.accounts.registry,
            &ctx.accounts.asset.to_account_info(),
            &ctx.accounts.collection.to_account_info(),
            &ctx.accounts.collection_auth.to_account_info(),
            &ctx.accounts.admin.to_account_info(),
            &ctx.accounts.mpl_core_program.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            new_uri,
        )
    }

    /// Both the creator and the asset's current holder approve a derived view.
    /// The original inscription Attributes, name and owner remain unchanged.
    pub fn opt_in_wardrobe_metadata(
        ctx: Context<OptInWardrobeMetadata>,
        new_uri: String,
    ) -> Result<()> {
        let asset_info = &ctx.accounts.update.asset;
        require_keys_eq!(*asset_info.owner, mpl_core::ID, ErrorCode::WrongAsset);
        let asset = mpl_core::accounts::BaseAssetV1::from_bytes(&asset_info.try_borrow_data()?)
            .map_err(|_| error!(ErrorCode::WrongAsset))?;
        require!(asset.key == CoreKey::AssetV1, ErrorCode::WrongAsset);
        require_keys_eq!(asset.owner, ctx.accounts.owner.key(), ErrorCode::WrongAsset);
        require!(
            asset.update_authority
                == UpdateAuthority::Collection(ctx.accounts.update.collection.key()),
            ErrorCode::WrongAsset
        );
        let recovery = &mut ctx.accounts.recovery;
        if recovery.asset == Pubkey::default() {
            recovery.asset = ctx.accounts.update.asset.key();
            recovery.collection = ctx.accounts.update.collection.key();
            recovery.original_uri = asset.uri.clone();
        }
        require_keys_eq!(
            recovery.asset,
            ctx.accounts.update.asset.key(),
            ErrorCode::WrongAsset
        );
        require_keys_eq!(
            recovery.collection,
            ctx.accounts.update.collection.key(),
            ErrorCode::WrongAsset
        );
        write_asset_uri(
            &ctx.accounts.update.registry,
            &ctx.accounts.update.asset.to_account_info(),
            &ctx.accounts.update.collection.to_account_info(),
            &ctx.accounts.update.collection_auth.to_account_info(),
            &ctx.accounts.owner.to_account_info(),
            &ctx.accounts.update.mpl_core_program.to_account_info(),
            &ctx.accounts.update.system_program.to_account_info(),
            new_uri,
        )
    }

    /// Restores only the immutable pre-opt-in URI, authorized by today's owner.
    pub fn restore_wardrobe_metadata(ctx: Context<RestoreWardrobeMetadata>) -> Result<()> {
        let asset =
            mpl_core::accounts::BaseAssetV1::from_bytes(&ctx.accounts.asset.try_borrow_data()?)
                .map_err(|_| error!(ErrorCode::WrongAsset))?;
        require_keys_eq!(asset.owner, ctx.accounts.owner.key(), ErrorCode::WrongAsset);
        require!(
            asset.key == CoreKey::AssetV1
                && asset.update_authority
                    == UpdateAuthority::Collection(ctx.accounts.collection.key()),
            ErrorCode::WrongAsset
        );
        write_asset_uri(
            &ctx.accounts.registry,
            &ctx.accounts.asset.to_account_info(),
            &ctx.accounts.collection.to_account_info(),
            &ctx.accounts.collection_auth.to_account_info(),
            &ctx.accounts.owner.to_account_info(),
            &ctx.accounts.mpl_core_program.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            ctx.accounts.recovery.original_uri.clone(),
        )
    }

    /// Explicit creator and current-holder opt-in. This adds only an immutable
    /// burn rejection hook; it never delegates transfer or edits base metadata.
    pub fn attach_wardrobe_oracle(ctx: Context<AttachWardrobeOracle>) -> Result<()> {
        require_keys_eq!(
            collection_update_authority(&ctx.accounts.collection)?,
            ctx.accounts.collection_auth.key(),
            ErrorCode::CollectionNotUnderProgramAuthority
        );
        let asset =
            mpl_core::accounts::BaseAssetV1::from_bytes(&ctx.accounts.asset.try_borrow_data()?)
                .map_err(|_| error!(ErrorCode::WrongAsset))?;
        require!(asset.key == CoreKey::AssetV1, ErrorCode::WrongAsset);
        require_keys_eq!(asset.owner, ctx.accounts.owner.key(), ErrorCode::WrongAsset);
        require!(
            asset.update_authority == UpdateAuthority::Collection(ctx.accounts.collection.key()),
            ErrorCode::WrongAsset
        );
        let oracle_program = ctx.accounts.oracle_program.key();
        require!(
            ctx.accounts.oracle_program.executable,
            ErrorCode::InvalidWardrobePolicy
        );
        let expected = Pubkey::find_program_address(
            &[b"loadout-v4", ctx.accounts.asset.key().as_ref()],
            &oracle_program,
        )
        .0;
        require_keys_eq!(
            expected,
            ctx.accounts.loadout.key(),
            ErrorCode::InvalidWardrobePolicy
        );
        require_keys_eq!(
            *ctx.accounts.loadout.owner,
            oracle_program,
            ErrorCode::InvalidWardrobePolicy
        );
        let expected_pool = Pubkey::find_program_address(
            &[b"sale-v4", ctx.accounts.collection.key().as_ref()],
            &oracle_program,
        )
        .0;
        require_keys_eq!(
            expected_pool,
            ctx.accounts.wardrobe_pool.key(),
            ErrorCode::InvalidWardrobePolicy
        );
        require_keys_eq!(
            *ctx.accounts.wardrobe_pool.owner,
            oracle_program,
            ErrorCode::InvalidWardrobePolicy
        );
        {
            let pool = ctx.accounts.wardrobe_pool.try_borrow_data()?;
            require!(
                pool.len() == 4352
                    && &pool[..8] == b"NUBSALE4"
                    && pool[8..40] == ctx.accounts.admin.key().to_bytes()
                    && pool[40..72] == ctx.accounts.collection.key().to_bytes()
                    && pool[254] == 1
                    && pool[255..287] == ctx.accounts.registry.key().to_bytes()
                    && pool[287..319] == crate::ID.to_bytes(),
                ErrorCode::InvalidWardrobePolicy
            );
        }
        {
            let policy = ctx.accounts.loadout.try_borrow_data()?;
            require!(
                policy.len() == 312
                    && &policy[..8] == b"NUBLOAD4"
                    && policy[8..13] == [1, 2, 2, 2, 2]
                    && policy[13] <= 7
                    && policy[14..46] == ctx.accounts.asset.key().to_bytes()
                    && policy[46..78] == ctx.accounts.wardrobe_pool.key().to_bytes()
                    && policy[110..116].iter().all(|v| *v == 255)
                    && policy[116..308].iter().all(|v| *v == 0),
                ErrorCode::InvalidWardrobePolicy
            );
        }
        let registry_key = ctx.accounts.registry.key();
        let seeds: &[&[u8]] = &[
            COLLECTION_AUTH_SEED,
            registry_key.as_ref(),
            &[ctx.accounts.registry.collection_auth_bump],
        ];
        AddExternalPluginAdapterV1CpiBuilder::new(&ctx.accounts.mpl_core_program)
            .asset(&ctx.accounts.asset.to_account_info())
            .collection(Some(&ctx.accounts.collection.to_account_info()))
            .payer(&ctx.accounts.owner.to_account_info())
            .authority(Some(&ctx.accounts.collection_auth.to_account_info()))
            .system_program(&ctx.accounts.system_program.to_account_info())
            .init_info(ExternalPluginAdapterInitInfo::Oracle(OracleInitInfo {
                base_address: oracle_program,
                init_plugin_authority: Some(PluginAuthority::None),
                lifecycle_checks: vec![(
                    HookableLifecycleEvent::Burn,
                    ExternalCheckResult { flags: 4 },
                )],
                base_address_config: Some(ExtraAccount::CustomPda {
                    seeds: vec![Seed::Bytes(b"loadout-v4".to_vec()), Seed::Asset],
                    custom_program_id: Some(oracle_program),
                    is_signer: false,
                    is_writable: false,
                }),
                results_offset: Some(ValidationResultsOffset::Custom(8)),
            }))
            .invoke_signed(&[seeds])?;
        Ok(())
    }

    pub fn update_collection_uri(ctx: Context<UpdateCollection>, new_uri: String) -> Result<()> {
        require!(new_uri.len() <= MAX_URI_BYTES, ErrorCode::UriTooLong);
        let registry_key = ctx.accounts.registry.key();
        let auth_seeds: &[&[u8]] = &[
            COLLECTION_AUTH_SEED,
            registry_key.as_ref(),
            &[ctx.accounts.registry.collection_auth_bump],
        ];
        UpdateCollectionV1CpiBuilder::new(&ctx.accounts.mpl_core_program)
            .collection(&ctx.accounts.collection.to_account_info())
            .authority(Some(&ctx.accounts.collection_auth.to_account_info()))
            .payer(&ctx.accounts.admin.to_account_info())
            .system_program(&ctx.accounts.system_program.to_account_info())
            .new_uri(new_uri)
            .invoke_signed(&[auth_seeds])?;
        Ok(())
    }
}

// Price to the creator's treasury, platform fee to the platform treasury. Both
// from the minter. `due` is what the minter still owes on the price; `price` is
// the full price the fee is computed on.
fn pay<'info>(
    system_program: &Program<'info, System>,
    minter: &Signer<'info>,
    treasury: &UncheckedAccount<'info>,
    platform_treasury: &UncheckedAccount<'info>,
    due: u64,
    price: u64,
) -> Result<()> {
    if due > 0 {
        system_program::transfer(
            CpiContext::new(
                system_program.to_account_info(),
                system_program::Transfer {
                    from: minter.to_account_info(),
                    to: treasury.to_account_info(),
                },
            ),
            due,
        )?;
    }
    let fee = price.checked_mul(PLATFORM_FEE_BPS).unwrap() / 10_000;
    if fee > 0 {
        system_program::transfer(
            CpiContext::new(
                system_program.to_account_info(),
                system_program::Transfer {
                    from: minter.to_account_info(),
                    to: platform_treasury.to_account_info(),
                },
            ),
            fee,
        )?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn create_asset<'info>(
    mpl_core_program: &UncheckedAccount<'info>,
    asset: &Signer<'info>,
    collection: &UncheckedAccount<'info>,
    collection_auth: &UncheckedAccount<'info>,
    payer: &Signer<'info>,
    owner: &UncheckedAccount<'info>,
    system_program: &Program<'info, System>,
    registry_key: Pubkey,
    collection_auth_bump: u8,
    name: String,
    uri: String,
    attribute_list: Vec<Attribute>,
) -> Result<()> {
    let auth_seeds: &[&[u8]] = &[
        COLLECTION_AUTH_SEED,
        registry_key.as_ref(),
        &[collection_auth_bump],
    ];
    CreateV2CpiBuilder::new(mpl_core_program)
        .asset(&asset.to_account_info())
        .collection(Some(&collection.to_account_info()))
        .authority(Some(&collection_auth.to_account_info()))
        .payer(&payer.to_account_info())
        .owner(Some(&owner.to_account_info()))
        .system_program(&system_program.to_account_info())
        .name(name)
        .uri(uri)
        .plugins(vec![PluginAuthorityPair {
            plugin: Plugin::Attributes(Attributes { attribute_list }),
            authority: None,
        }])
        .invoke_signed(&[auth_seeds])?;
    Ok(())
}

fn collection_update_authority(collection: &UncheckedAccount) -> Result<Pubkey> {
    require_keys_eq!(
        *collection.owner,
        mpl_core::ID,
        ErrorCode::CollectionNotUnderProgramAuthority
    );
    let data = collection.data.borrow();
    let parsed = mpl_core::accounts::BaseCollectionV1::from_bytes(&data)
        .map_err(|_| error!(ErrorCode::CollectionNotUnderProgramAuthority))?;
    Ok(parsed.update_authority)
}

fn hex_lower(bytes: &[u8]) -> String {
    const TABLE: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(TABLE[(b >> 4) as usize] as char);
        out.push(TABLE[(b & 0x0f) as usize] as char);
    }
    out
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct RoyaltyCreator {
    pub address: Pubkey,
    pub percentage: u8,
}

#[account]
pub struct Registry {
    pub bump: u8,
    pub collection_auth_bump: u8,
    pub collection: Pubkey,
    pub registrar: Pubkey,
    pub admin: Pubkey,
    pub treasury: Pubkey,
    pub max_supply: u32,
    pub minted: u32,
    pub price_lamports: u64,
    pub deposit_lamports: u64,
    pub manifest_hash: [u8; 32],
    pub manifest_sig: [u8; 64],
    pub shuffle_commit: [u8; 32],
    pub frozen: bool,
    // One bit per item index (1-based: index i lives at bit i-1). Sized at
    // initialize_registry from max_supply; never grows. The whole sold set is
    // one account read.
    pub minted_bitmap: Vec<u8>,
}

impl Registry {
    pub const BASE_LEN: usize = 8 + 1 + 1 + 32 + 32 + 32 + 32 + 4 + 4 + 8 + 8 + 32 + 64 + 32 + 1 + 4;
    pub fn bitmap_len(max_supply: u32) -> usize {
        (max_supply as usize + 7) / 8
    }
    pub fn space(max_supply: u32) -> usize {
        Self::BASE_LEN + Self::bitmap_len(max_supply)
    }
    pub fn bit(index: u32) -> (usize, u8) {
        let i = (index - 1) as usize;
        (i / 8, 1u8 << (i % 8))
    }
}

// One per inscription, anywhere: the same C can never back two tokens. Also
// the on-chain record of what that token is (its index and hashes), so a
// collection can be enumerated from these without an indexer.
#[account]
pub struct InscriptionRecord {
    pub bump: u8,
    pub asset: Pubkey,
    pub collection: Pubkey,
    pub index: u32, // 0 for single NFTs
    pub content_hash: [u8; 32],
    pub meta_sig: [u8; 64],
}

impl InscriptionRecord {
    pub const LEN: usize = 8 + 1 + 32 + 32 + 4 + 32 + 64;
}

#[derive(Accounts)]
#[instruction(max_supply: u32)]
pub struct InitializeRegistry<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: deserialized and authority-checked in the handler.
    pub collection: UncheckedAccount<'info>,

    #[account(
        init,
        payer = payer,
        space = Registry::space(max_supply),
        seeds = [REGISTRY_SEED, collection.key().as_ref()],
        bump
    )]
    pub registry: Account<'info, Registry>,

    /// CHECK: pure signer PDA, never holds data.
    #[account(seeds = [COLLECTION_AUTH_SEED, registry.key().as_ref()], bump)]
    pub collection_auth: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(index: u32, content_hash: [u8; 32], inscription_sig: [u8; 64])]
pub struct RegisterItem<'info> {
    #[account(mut)]
    pub minter: Signer<'info>,

    /// CHECK: receives the asset. The registrar co-signature binds it to the reservation.
    pub owner: UncheckedAccount<'info>,

    pub registrar: Signer<'info>,

    #[account(
        mut,
        seeds = [REGISTRY_SEED, registry.collection.as_ref()],
        bump = registry.bump
    )]
    pub registry: Account<'info, Registry>,

    #[account(
        init,
        payer = minter,
        space = InscriptionRecord::LEN,
        seeds = [INSCRIPTION_SEED, &inscription_sig[..32], &inscription_sig[32..]],
        bump
    )]
    pub inscription_record: Account<'info, InscriptionRecord>,

    /// CHECK: pinned to the registry's collection; mpl-core validates the rest.
    #[account(mut, address = registry.collection)]
    pub collection: UncheckedAccount<'info>,

    /// CHECK: pure signer PDA.
    #[account(
        seeds = [COLLECTION_AUTH_SEED, registry.key().as_ref()],
        bump = registry.collection_auth_bump
    )]
    pub collection_auth: UncheckedAccount<'info>,

    /// CHECK: must be the configured treasury; receives the price remainder.
    #[account(mut, address = registry.treasury @ ErrorCode::WrongTreasury)]
    pub treasury: UncheckedAccount<'info>,

    /// CHECK: the program's fee receiver; receives the platform fee.
    #[account(mut, address = PLATFORM_TREASURY @ ErrorCode::WrongPlatformTreasury)]
    pub platform_treasury: UncheckedAccount<'info>,

    #[account(mut)]
    pub asset: Signer<'info>,

    /// CHECK: pinned to the mpl-core program id.
    #[account(address = mpl_core::ID)]
    pub mpl_core_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(inscription_sig: [u8; 64])]
pub struct RegisterSingle<'info> {
    #[account(mut)]
    pub minter: Signer<'info>,

    /// CHECK: receives the asset. The registrar co-signature binds it to the inscription's payer.
    pub owner: UncheckedAccount<'info>,

    pub registrar: Signer<'info>,

    #[account(
        mut,
        seeds = [REGISTRY_SEED, registry.collection.as_ref()],
        bump = registry.bump
    )]
    pub registry: Account<'info, Registry>,

    #[account(
        init,
        payer = minter,
        space = InscriptionRecord::LEN,
        seeds = [INSCRIPTION_SEED, &inscription_sig[..32], &inscription_sig[32..]],
        bump
    )]
    pub inscription_record: Account<'info, InscriptionRecord>,

    /// CHECK: pinned to the registry's collection; mpl-core validates the rest.
    #[account(mut, address = registry.collection)]
    pub collection: UncheckedAccount<'info>,

    /// CHECK: pure signer PDA.
    #[account(
        seeds = [COLLECTION_AUTH_SEED, registry.key().as_ref()],
        bump = registry.collection_auth_bump
    )]
    pub collection_auth: UncheckedAccount<'info>,

    /// CHECK: must be the configured treasury; receives the price.
    #[account(mut, address = registry.treasury @ ErrorCode::WrongTreasury)]
    pub treasury: UncheckedAccount<'info>,

    /// CHECK: the program's fee receiver; receives the platform fee.
    #[account(mut, address = PLATFORM_TREASURY @ ErrorCode::WrongPlatformTreasury)]
    pub platform_treasury: UncheckedAccount<'info>,

    #[account(mut)]
    pub asset: Signer<'info>,

    /// CHECK: pinned to the mpl-core program id.
    #[account(address = mpl_core::ID)]
    pub mpl_core_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

fn write_asset_uri<'info>(
    registry: &Account<'info, Registry>,
    asset: &AccountInfo<'info>,
    collection: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    core: &AccountInfo<'info>,
    system: &AccountInfo<'info>,
    new_uri: String,
) -> Result<()> {
    require!(new_uri.len() <= MAX_URI_BYTES, ErrorCode::UriTooLong);
    let registry_key = registry.key();
    let seeds: &[&[u8]] = &[
        COLLECTION_AUTH_SEED,
        registry_key.as_ref(),
        &[registry.collection_auth_bump],
    ];
    UpdateV2CpiBuilder::new(core)
        .asset(asset)
        .collection(Some(collection))
        .authority(Some(authority))
        .payer(payer)
        .system_program(system)
        .new_uri(new_uri)
        .invoke_signed(&[seeds])?;
    Ok(())
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [REGISTRY_SEED, registry.collection.as_ref()],
        bump = registry.bump,
        has_one = admin @ ErrorCode::UnauthorizedAdmin
    )]
    pub registry: Account<'info, Registry>,
}

#[derive(Accounts)]
pub struct UpdateAssetUri<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        seeds = [REGISTRY_SEED, registry.collection.as_ref()],
        bump = registry.bump,
        has_one = admin @ ErrorCode::UnauthorizedAdmin
    )]
    pub registry: Account<'info, Registry>,

    /// CHECK: must be an asset this registry created (its inscription record points at it).
    #[account(mut, address = inscription_record.asset @ ErrorCode::WrongAsset)]
    pub asset: UncheckedAccount<'info>,

    #[account(constraint = inscription_record.collection == registry.collection @ ErrorCode::WrongAsset)]
    pub inscription_record: Account<'info, InscriptionRecord>,

    /// CHECK: pinned to the registry's collection.
    #[account(mut, address = registry.collection)]
    pub collection: UncheckedAccount<'info>,

    /// CHECK: pure signer PDA.
    #[account(
        seeds = [COLLECTION_AUTH_SEED, registry.key().as_ref()],
        bump = registry.collection_auth_bump
    )]
    pub collection_auth: UncheckedAccount<'info>,

    /// CHECK: pinned to the mpl-core program id.
    #[account(address = mpl_core::ID)]
    pub mpl_core_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OptInWardrobeMetadata<'info> {
    pub update: UpdateAssetUri<'info>,
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(init_if_needed, payer = owner, space = 8 + 32 + 32 + 4 + MAX_URI_BYTES, seeds = [b"wardrobe-meta", update.asset.key().as_ref()], bump)]
    pub recovery: Account<'info, WardrobeMetadataRecovery>,
    // Anchor's init constraint needs the System program at this account level.
    pub system_program: Program<'info, System>,
}

#[account]
pub struct WardrobeMetadataRecovery {
    pub asset: Pubkey,
    pub collection: Pubkey,
    pub original_uri: String,
}

#[derive(Accounts)]
pub struct RestoreWardrobeMetadata<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [REGISTRY_SEED, registry.collection.as_ref()], bump = registry.bump)]
    pub registry: Account<'info, Registry>,
    /// CHECK: registered identity, Core membership and current owner checked.
    #[account(mut, owner = mpl_core::ID, address = recovery.asset @ ErrorCode::WrongAsset)]
    pub asset: UncheckedAccount<'info>,
    #[account(seeds = [b"wardrobe-meta", asset.key().as_ref()], bump, constraint = recovery.collection == registry.collection @ ErrorCode::WrongAsset)]
    pub recovery: Account<'info, WardrobeMetadataRecovery>,
    /// CHECK: pinned registered collection.
    #[account(mut, address = registry.collection)]
    pub collection: UncheckedAccount<'info>,
    /// CHECK: collection signer PDA.
    #[account(seeds = [COLLECTION_AUTH_SEED, registry.key().as_ref()], bump = registry.collection_auth_bump)]
    pub collection_auth: UncheckedAccount<'info>,
    /// CHECK: canonical Core program.
    #[account(address = mpl_core::ID)]
    pub mpl_core_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AttachWardrobeOracle<'info> {
    pub admin: Signer<'info>,
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        seeds = [REGISTRY_SEED, registry.collection.as_ref()], bump = registry.bump,
        has_one = admin @ ErrorCode::UnauthorizedAdmin
    )]
    pub registry: Account<'info, Registry>,
    /// CHECK: Core membership and current owner are checked in the handler.
    #[account(mut, owner = mpl_core::ID)]
    pub asset: UncheckedAccount<'info>,
    /// CHECK: pinned to this registry's actual collection and Core authority.
    #[account(mut, address = registry.collection)]
    pub collection: UncheckedAccount<'info>,
    /// CHECK: this program signs only the narrow Core adapter installation.
    #[account(seeds = [COLLECTION_AUTH_SEED, registry.key().as_ref()], bump = registry.collection_auth_bump)]
    pub collection_auth: UncheckedAccount<'info>,
    /// CHECK: executable opt-in program, selected by both admin and current holder.
    pub oracle_program: UncheckedAccount<'info>,
    /// CHECK: exact program-owned empty loadout PDA and policy bytes checked above.
    pub loadout: UncheckedAccount<'info>,
    /// CHECK: exact program-owned registry-aware pool PDA and fields checked above.
    pub wardrobe_pool: UncheckedAccount<'info>,
    /// CHECK: canonical Core program.
    #[account(address = mpl_core::ID, executable)]
    pub mpl_core_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateCollection<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        seeds = [REGISTRY_SEED, registry.collection.as_ref()],
        bump = registry.bump,
        has_one = admin @ ErrorCode::UnauthorizedAdmin
    )]
    pub registry: Account<'info, Registry>,

    /// CHECK: pinned to the registry's collection.
    #[account(mut, address = registry.collection)]
    pub collection: UncheckedAccount<'info>,

    /// CHECK: pure signer PDA.
    #[account(
        seeds = [COLLECTION_AUTH_SEED, registry.key().as_ref()],
        bump = registry.collection_auth_bump
    )]
    pub collection_auth: UncheckedAccount<'info>,

    /// CHECK: pinned to the mpl-core program id.
    #[account(address = mpl_core::ID)]
    pub mpl_core_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[error_code]
pub enum ErrorCode {
    #[msg("registry is frozen")]
    Frozen,
    #[msg("signer is not the registered registrar")]
    UnauthorizedRegistrar,
    #[msg("item index is outside 1..max_supply")]
    IndexOutOfRange,
    #[msg("this item index has already been minted")]
    IndexAlreadyMinted,
    #[msg("the collection's update authority is not this program's PDA")]
    CollectionNotUnderProgramAuthority,
    #[msg("asset name exceeds 80 bytes")]
    NameTooLong,
    #[msg("uri exceeds 160 bytes")]
    UriTooLong,
    #[msg("treasury account does not match registry.treasury")]
    WrongTreasury,
    #[msg("platform treasury account does not match the program constant")]
    WrongPlatformTreasury,
    #[msg("signer is not the admin")]
    UnauthorizedAdmin,
    #[msg("asset does not match the one recorded for this inscription")]
    WrongAsset,
    #[msg("deposit cannot exceed the price")]
    DepositOverPrice,
    #[msg("register_single needs a registry with max_supply 0")]
    NotASingleRegistry,
    #[msg("wardrobe policy is not a valid empty program-owned loadout")]
    InvalidWardrobePolicy,
}
