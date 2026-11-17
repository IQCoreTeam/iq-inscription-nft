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
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

declare_id!("FCGhsCf5sMM7Z5APta1hi76WGTvrfMJnBr4QSR3w13Fu");

const REGISTRY_SEED: &[u8] = b"registry";
const INSCRIPTION_SEED: &[u8] = b"inscription";
const COLLECTION_AUTH_SEED: &[u8] = b"collection-auth";
const MAX_NAME_BYTES: usize = 80;
const MAX_URI_BYTES: usize = 160;
const STD: &str = "iqnft-0.1";
// Byte offset where `frozen` ends in a Registry account (8 disc + fixed fields +
// 1 frozen byte). migrate_registry_v2 inserts the 32-byte currency field here.
const CURRENCY_CUT: usize = 291;

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
        // The mint the mint price is paid in. Pubkey::default() means native SOL
        // (the existing path). Any other mint routes the price through a
        // Token-2022 transfer to the treasury and platform token accounts.
        currency: Pubkey,
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
        registry.currency = currency;
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
        let deposit = registry.deposit_lamports;
        let currency = registry.currency;
        let treasury_pk = registry.treasury;
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

        // Platform fee is on the full price, charged to the minter on top.
        let fee = price.checked_mul(PLATFORM_FEE_BPS).unwrap() / 10_000;
        if currency == Pubkey::default() {
            // SOL: the deposit was pre-paid to the creator at reservation
            // (off-chain), so only the remainder of the price moves here.
            let due = price.saturating_sub(deposit);
            pay_sol(
                &ctx.accounts.system_program,
                &ctx.accounts.minter,
                &ctx.accounts.treasury,
                &ctx.accounts.platform_treasury,
                due,
                fee,
            )?;
        } else {
            // SPL: the deposit stays in SOL (paid at reservation), so the full
            // price moves in the collection's chosen token.
            pay_spl(
                ctx.accounts.token_program.as_ref().ok_or(ErrorCode::CurrencyAccountsMissing)?,
                ctx.accounts.currency_mint.as_ref().ok_or(ErrorCode::CurrencyAccountsMissing)?,
                &ctx.accounts.minter,
                ctx.accounts.minter_token.as_ref().ok_or(ErrorCode::CurrencyAccountsMissing)?,
                ctx.accounts.treasury_token.as_ref().ok_or(ErrorCode::CurrencyAccountsMissing)?,
                ctx.accounts.platform_token.as_ref().ok_or(ErrorCode::CurrencyAccountsMissing)?,
                currency,
                treasury_pk,
                price,
                fee,
            )?;
        }

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
        let currency = registry.currency;
        let treasury_pk = registry.treasury;
        // No deposit on a single, so the full price moves here.
        let fee = price.checked_mul(PLATFORM_FEE_BPS).unwrap() / 10_000;
        if currency == Pubkey::default() {
            pay_sol(
                &ctx.accounts.system_program,
                &ctx.accounts.minter,
                &ctx.accounts.treasury,
                &ctx.accounts.platform_treasury,
                price,
                fee,
            )?;
        } else {
            pay_spl(
                ctx.accounts.token_program.as_ref().ok_or(ErrorCode::CurrencyAccountsMissing)?,
                ctx.accounts.currency_mint.as_ref().ok_or(ErrorCode::CurrencyAccountsMissing)?,
                &ctx.accounts.minter,
                ctx.accounts.minter_token.as_ref().ok_or(ErrorCode::CurrencyAccountsMissing)?,
                ctx.accounts.treasury_token.as_ref().ok_or(ErrorCode::CurrencyAccountsMissing)?,
                ctx.accounts.platform_token.as_ref().ok_or(ErrorCode::CurrencyAccountsMissing)?,
                currency,
                treasury_pk,
                price,
                fee,
            )?;
        }

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
        require!(new_uri.len() <= MAX_URI_BYTES, ErrorCode::UriTooLong);
        let registry_key = ctx.accounts.registry.key();
        let auth_seeds: &[&[u8]] = &[
            COLLECTION_AUTH_SEED,
            registry_key.as_ref(),
            &[ctx.accounts.registry.collection_auth_bump],
        ];
        UpdateV2CpiBuilder::new(&ctx.accounts.mpl_core_program)
            .asset(&ctx.accounts.asset.to_account_info())
            .collection(Some(&ctx.accounts.collection.to_account_info()))
            .authority(Some(&ctx.accounts.collection_auth.to_account_info()))
            .payer(&ctx.accounts.admin.to_account_info())
            .system_program(&ctx.accounts.system_program.to_account_info())
            .new_uri(new_uri)
            .invoke_signed(&[auth_seeds])?;
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

    // One-time, permissionless migration of a pre-currency Registry to the
    // currency layout: insert currency = Pubkey::default() (native SOL) after the
    // `frozen` byte and shift the bitmap. It changes no privileged field, so any
    // payer may fund the 32-byte rent bump and run it.
    pub fn migrate_registry_v2(ctx: Context<MigrateRegistry>) -> Result<()> {
        let acc = ctx.accounts.registry.to_account_info();
        require_keys_eq!(*acc.owner, crate::ID, ErrorCode::BadRegistryLayout);
        // Build the new bytes from the old, validating the old layout as we read.
        let new_data = {
            let data = acc.try_borrow_data()?;
            require!(data.len() >= CURRENCY_CUT + 4, ErrorCode::BadRegistryLayout);
            require!(&data[0..8] == Registry::DISCRIMINATOR, ErrorCode::BadRegistryLayout);
            let max_supply = u32::from_le_bytes(data[138..142].try_into().unwrap());
            let old_total = CURRENCY_CUT + 4 + Registry::bitmap_len(max_supply);
            require!(data.len() == old_total, ErrorCode::AlreadyMigratedOrBad);
            registry_insert_currency(&data, CURRENCY_CUT)
        };

        // Keep the account rent-exempt at the larger size, fund the bump, grow,
        // then write the new bytes (bitmap copied verbatim, so the sold set lives).
        let need = Rent::get()?.minimum_balance(new_data.len());
        if need > acc.lamports() {
            let diff = need - acc.lamports();
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.payer.to_account_info(),
                        to: acc.clone(),
                    },
                ),
                diff,
            )?;
        }
        acc.resize(new_data.len())?;
        acc.try_borrow_mut_data()?.copy_from_slice(&new_data);
        Ok(())
    }
}

// Price to the creator's treasury, platform fee to the platform treasury. Both
// from the minter. `due` is what the minter still owes on the price; `price` is
// the full price the fee is computed on.
fn pay_sol<'info>(
    system_program: &Program<'info, System>,
    minter: &Signer<'info>,
    treasury: &UncheckedAccount<'info>,
    platform_treasury: &UncheckedAccount<'info>,
    due: u64,
    fee: u64,
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

// Same split in an SPL (or Token-2022) mint: the minter's token account pays the
// creator's and the platform's token accounts. The money must land in the
// collection's chosen mint, owned by the configured treasury and the platform
// treasury; any token account satisfying that is accepted (the client uses the
// ATA). transfer_checked verifies the decimals and routes to the token program
// the mint belongs to. NOTE: this does not yet forward transfer-hook extra
// accounts, so a mint with an active hook would fail here; the stock tokens we
// target have no active hook today. Hook forwarding is a hardening follow-up.
#[allow(clippy::too_many_arguments)]
fn pay_spl<'info>(
    token_program: &Interface<'info, TokenInterface>,
    mint: &InterfaceAccount<'info, Mint>,
    minter: &Signer<'info>,
    minter_token: &InterfaceAccount<'info, TokenAccount>,
    treasury_token: &InterfaceAccount<'info, TokenAccount>,
    platform_token: &InterfaceAccount<'info, TokenAccount>,
    currency: Pubkey,
    treasury_owner: Pubkey,
    due: u64,
    fee: u64,
) -> Result<()> {
    require_keys_eq!(mint.key(), currency, ErrorCode::WrongCurrencyMint);
    require!(minter_token.mint == mint.key(), ErrorCode::WrongCurrencyAccount);
    require!(
        treasury_token.mint == mint.key() && treasury_token.owner == treasury_owner,
        ErrorCode::WrongCurrencyAccount
    );
    require!(
        platform_token.mint == mint.key() && platform_token.owner == PLATFORM_TREASURY,
        ErrorCode::WrongCurrencyAccount
    );
    let decimals = mint.decimals;
    if due > 0 {
        transfer_checked(
            CpiContext::new(
                token_program.to_account_info(),
                TransferChecked {
                    from: minter_token.to_account_info(),
                    mint: mint.to_account_info(),
                    to: treasury_token.to_account_info(),
                    authority: minter.to_account_info(),
                },
            ),
            due,
            decimals,
        )?;
    }
    if fee > 0 {
        transfer_checked(
            CpiContext::new(
                token_program.to_account_info(),
                TransferChecked {
                    from: minter_token.to_account_info(),
                    mint: mint.to_account_info(),
                    to: platform_token.to_account_info(),
                    authority: minter.to_account_info(),
                },
            ),
            fee,
            decimals,
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

// Insert a zeroed 32-byte currency field (= Pubkey::default() = native SOL) at
// `cut`, keeping everything before it and the trailing vec_len + bitmap verbatim.
// Pure so the byte math (the only real migration risk) is unit-tested below.
fn registry_insert_currency(old: &[u8], cut: usize) -> Vec<u8> {
    let mut v = Vec::with_capacity(old.len() + 32);
    v.extend_from_slice(&old[..cut]);
    v.extend_from_slice(&[0u8; 32]);
    v.extend_from_slice(&old[cut..]);
    v
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
    // Mint the price is paid in. Pubkey::default() = native SOL. Inserted here,
    // before the Vec, so migrate_registry_v2 only has to shift the trailing bitmap.
    pub currency: Pubkey,
    // One bit per item index (1-based: index i lives at bit i-1). Sized at
    // initialize_registry from max_supply; never grows. The whole sold set is
    // one account read.
    pub minted_bitmap: Vec<u8>,
}

impl Registry {
    pub const BASE_LEN: usize =
        8 + 1 + 1 + 32 + 32 + 32 + 32 + 4 + 4 + 8 + 8 + 32 + 64 + 32 + 1 + 32 + 4;
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

    // Optional SPL payment accounts: present only when the registry's currency is
    // not SOL. A SOL collection passes these as None. The handler checks the mint
    // matches registry.currency and that the token accounts belong to the right
    // owners, so unused/forged accounts cannot be slipped in.
    pub currency_mint: Option<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub minter_token: Option<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub treasury_token: Option<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub platform_token: Option<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Option<Interface<'info, TokenInterface>>,

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

    // Optional SPL payment accounts: present only when the registry's currency is
    // not SOL. A SOL collection passes these as None. The handler checks the mint
    // matches registry.currency and that the token accounts belong to the right
    // owners, so unused/forged accounts cannot be slipped in.
    pub currency_mint: Option<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub minter_token: Option<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub treasury_token: Option<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub platform_token: Option<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Option<Interface<'info, TokenInterface>>,

    pub system_program: Program<'info, System>,
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

#[derive(Accounts)]
pub struct MigrateRegistry<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: a Registry account owned by this program; the layout and
    /// already-migrated guard are checked in the handler.
    #[account(mut)]
    pub registry: UncheckedAccount<'info>,

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
    #[msg("SPL currency payment accounts are missing")]
    CurrencyAccountsMissing,
    #[msg("currency mint does not match registry.currency")]
    WrongCurrencyMint,
    #[msg("a currency token account has the wrong mint or owner")]
    WrongCurrencyAccount,
    #[msg("registry account is not the expected pre-currency layout")]
    BadRegistryLayout,
    #[msg("registry is already migrated or has an unexpected size")]
    AlreadyMigratedOrBad,
}

#[cfg(test)]
mod tests {
    use super::*;

    // The migration's only real risk: the trailing bitmap (the sold set) must
    // survive the 32-byte currency insertion byte-for-byte.
    #[test]
    fn migrate_preserves_bitmap() {
        let bitmap = [0xA5u8, 0x00, 0xFF]; // ceil(20/8) = 3 bytes, a known pattern
        let mut old = vec![7u8; CURRENCY_CUT]; // disc + fields + frozen (arbitrary)
        old.extend_from_slice(&(bitmap.len() as u32).to_le_bytes());
        old.extend_from_slice(&bitmap);

        let new = registry_insert_currency(&old, CURRENCY_CUT);

        assert_eq!(new.len(), old.len() + 32);
        assert_eq!(&new[..CURRENCY_CUT], &old[..CURRENCY_CUT]); // prefix unchanged
        assert_eq!(&new[CURRENCY_CUT..CURRENCY_CUT + 32], &[0u8; 32]); // currency = SOL
        assert_eq!(
            &new[CURRENCY_CUT + 32..CURRENCY_CUT + 36],
            &(bitmap.len() as u32).to_le_bytes()
        ); // vec_len intact
        assert_eq!(&new[CURRENCY_CUT + 36..], &bitmap[..]); // bitmap byte-identical
    }

    // The insertion point must match where a fresh Registry writes currency:
    // right after `frozen`, i.e. BASE_LEN minus the currency field and vec prefix.
    #[test]
    fn cut_matches_initialize_layout() {
        assert_eq!(CURRENCY_CUT, Registry::BASE_LEN - 32 - 4);
    }
}
