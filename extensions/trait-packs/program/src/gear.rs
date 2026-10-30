//! Portable Core cosmetic entitlements and custody. No fixture authority or
//! metadata label is accepted as proof of issuance or current ownership.
use crate::state::*;
use mpl_core::{
    instructions::{
        AddExternalPluginAdapterV1CpiBuilder, CreateV1CpiBuilder, TransferV1CpiBuilder,
    },
    types::{
        DataState, ExternalCheckResult, ExternalPluginAdapterInitInfo, ExtraAccount,
        HookableLifecycleEvent, OracleInitInfo, PluginAuthority, Seed, UpdateAuthority,
        ValidationResultsOffset,
    },
};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    hash::hashv,
    instruction::{AccountMeta, Instruction},
    program::{invoke, invoke_signed},
    pubkey::Pubkey,
    rent::Rent,
    system_instruction,
    sysvar::Sysvar,
};
const GEAR_MAGIC: &[u8; 8] = b"NUBGEAR4";
const GEAR_SIZE: usize = 140;
const LOAD_MAGIC: &[u8; 8] = b"NUBLOAD4";
const LOAD_SIZE: usize = 312;
const NONE: u8 = 255;
const SLOTS: usize = 6;
fn core_program(a: &AccountInfo) -> ProgramResult {
    if *a.key != mpl_core::ID || !a.executable {
        return Err(err(3));
    }
    Ok(())
}
fn authority(
    a: &AccountInfo,
    pool: &AccountInfo,
    program: &Pubkey,
) -> Result<u8, solana_program::program_error::ProgramError> {
    let (k, b) = Pubkey::find_program_address(&[b"gear-authority-v4", pool.key.as_ref()], program);
    if k != *a.key {
        return Err(err(3));
    }
    Ok(b)
}
fn base_hash(v: &mpl_core::accounts::BaseAssetV1) -> [u8; 32] {
    hashv(&[
        &(v.name.len() as u32).to_le_bytes(),
        v.name.as_bytes(),
        &(v.uri.len() as u32).to_le_bytes(),
        v.uri.as_bytes(),
    ])
    .to_bytes()
}
fn definition(p: &[u8], id: u8) -> Result<&[u8], solana_program::program_error::ProgramError> {
    if id >= p[208] || id as usize >= MAX_DEFS {
        return Err(err(3));
    }
    let at = DEF_START + id as usize * DEF_SIZE;
    Ok(&p[at..at + DEF_SIZE])
}
fn compatible(p: &[u8], l: &[u8]) -> ProgramResult {
    for s in 0..SLOTS {
        let id = l[110 + s];
        if id == NONE {
            continue;
        }
        let d = definition(p, id)?;
        if d[0] as usize != s || d[1] & (1 << l[13]) == 0 {
            return Err(err(9));
        }
        if d[2] != NONE && (d[2] as usize >= SLOTS || l[110 + d[2] as usize] != d[3]) {
            return Err(err(9));
        }
    }
    Ok(())
}
fn loadout(
    load: &AccountInfo,
    avatar: &AccountInfo,
    pool: &AccountInfo,
    program: &Pubkey,
) -> Result<Vec<u8>, solana_program::program_error::ProgramError> {
    if Pubkey::find_program_address(&[b"loadout-v4", avatar.key.as_ref()], program).0 != *load.key {
        return Err(err(3));
    }
    let l = checked(load, program, LOAD_MAGIC, LOAD_SIZE)?;
    if key(&l, 14) != *avatar.key || key(&l, 46) != *pool.key || l[13] > 7 {
        return Err(err(3));
    }
    Ok(l)
}
fn issued(
    item: &AccountInfo,
    asset: &AccountInfo,
    pool: &AccountInfo,
    program: &Pubkey,
) -> Result<Vec<u8>, solana_program::program_error::ProgramError> {
    if Pubkey::find_program_address(&[b"gear-v4", asset.key.as_ref()], program).0 != *item.key {
        return Err(err(3));
    }
    let g = checked(item, program, GEAR_MAGIC, GEAR_SIZE)?;
    if key(&g, 8) != *pool.key || key(&g, 76) != *asset.key {
        return Err(err(3));
    }
    Ok(g)
}
fn policy(l: &mut [u8]) {
    let burn = if l[110..116].iter().any(|d| *d != NONE) {
        1
    } else {
        2
    };
    l[8..13].copy_from_slice(&[1, 2, 2, burn, 2]);
}

fn initialize_loadout<'a>(
    program: &Pubkey,
    owner: &AccountInfo<'a>,
    pool: &AccountInfo<'a>,
    avatar: &AccountInfo<'a>,
    load: &AccountInfo<'a>,
    system: &AccountInfo<'a>,
    body_class: u8,
    base: &mpl_core::accounts::BaseAssetV1,
) -> ProgramResult {
    create_pda(
        program,
        owner,
        load,
        system,
        &[b"loadout-v4", avatar.key.as_ref()],
        LOAD_SIZE,
    )?;
    let mut l = load.try_borrow_mut_data()?;
    l[..8].copy_from_slice(LOAD_MAGIC);
    l[13] = body_class;
    putkey(&mut l, 14, avatar.key);
    putkey(&mut l, 46, pool.key);
    l[78..110].copy_from_slice(&base_hash(base));
    l[110..116].fill(NONE);
    policy(&mut l);
    Ok(())
}

pub fn process(program: &Pubkey, accounts: &[AccountInfo], op: u8, body: &[u8]) -> ProgramResult {
    let mut it = accounts.iter();
    match op {
        20 => {
            if body.len() != 3 {
                return Err(err(2));
            }
            let ticket = u16::from_le_bytes(body[..2].try_into().unwrap()) as usize;
            let pull = body[2] as usize;
            if pull >= 4 {
                return Err(err(2));
            }
            let cranker = next_account_info(&mut it)?;
            let pool = next_account_info(&mut it)?;
            let epoch = next_account_info(&mut it)?;
            let buyer = next_account_info(&mut it)?;
            let asset = next_account_info(&mut it)?;
            let item = next_account_info(&mut it)?;
            let auth = next_account_info(&mut it)?;
            let ops = next_account_info(&mut it)?;
            let core = next_account_info(&mut it)?;
            let system = next_account_info(&mut it)?;
            signer(cranker)?;
            signer(asset)?;
            core_program(core)?;
            let mut p = pool_checked(pool, program)?;
            let mut e = epoch_checked(epoch, pool, program)?;
            ops_checked(ops, pool, program)?;
            let ab = authority(auth, pool, program)?;
            if e[48] != 4 {
                return Err(err(4));
            }
            let at = ticket_offset(&e, ticket)?;
            if key(&e, at) != *buyer.key || e[at + 45] != 0 || e[at + 44] & (1 << pull) != 0 {
                return Err(err(4));
            }
            let id = e[at + 40 + pull];
            let d = definition(&p, id)?;
            let n = d[36] as usize;
            let u = d[69] as usize;
            if n == 0 || n > 32 || u == 0 || u > 160 {
                return Err(err(3));
            }
            let name = std::str::from_utf8(&d[37..37 + n])
                .map_err(|_| err(3))?
                .to_string();
            let uri = std::str::from_utf8(&d[70..70 + u])
                .map_err(|_| err(3))?
                .to_string();
            if Pubkey::find_program_address(&[b"gear-v4", asset.key.as_ref()], program).0
                != *item.key
                || !item.data_is_empty()
                || *item.owner != solana_program::system_program::id()
            {
                return Err(err(3));
            }
            let ob = [Pubkey::find_program_address(&[b"ops-v4", pool.key.as_ref()], program).1];
            let ops_seeds: &[&[u8]] = &[b"ops-v4", pool.key.as_ref(), &ob];
            let outstanding = u64at(&p, 242).checked_sub(1).ok_or(err(8))?;
            let min_after = outstanding
                .checked_mul(CLAIM_BUDGET)
                .and_then(|n| n.checked_add(PROVIDER_RESERVE))
                .ok_or(err(8))?;
            let rent = Rent::get()?
                .minimum_balance(GEAR_SIZE)
                .saturating_sub(item.lamports());
            if rent > 0 {
                invoke_signed(
                    &system_instruction::transfer(ops.key, item.key, rent),
                    &[ops.clone(), item.clone(), system.clone()],
                    &[ops_seeds],
                )?;
            }
            create_pda(
                program,
                cranker,
                item,
                system,
                &[b"gear-v4", asset.key.as_ref()],
                GEAR_SIZE,
            )?;
            let bump = [ab];
            let auth_seeds: &[&[u8]] = &[b"gear-authority-v4", pool.key.as_ref(), &bump];
            CreateV1CpiBuilder::new(core)
                .asset(asset)
                .payer(ops)
                .owner(Some(buyer))
                .update_authority(Some(auth))
                .system_program(system)
                .data_state(DataState::AccountState)
                .name(name)
                .uri(uri)
                .invoke_signed(&[ops_seeds, auth_seeds])?;
            if ops.lamports() < min_after {
                return Err(err(8));
            }
            let mut g = item.try_borrow_mut_data()?;
            g[..8].copy_from_slice(GEAR_MAGIC);
            putkey(&mut g, 8, pool.key);
            putkey(&mut g, 40, epoch.key);
            put16(&mut g, 72, ticket as u16);
            g[74] = pull as u8;
            g[75] = id;
            putkey(&mut g, 76, asset.key);
            putkey(&mut g, 108, &Pubkey::default());
            e[at + 44] |= 1 << pull;
            put64(&mut p, 242, outstanding);
            epoch.try_borrow_mut_data()?.copy_from_slice(&e);
            pool.try_borrow_mut_data()?.copy_from_slice(&p);
            Ok(())
        }
        21 => {
            if body.len() != 1 || body[0] > 7 {
                return Err(err(2));
            }
            let owner = next_account_info(&mut it)?;
            let admin = next_account_info(&mut it)?;
            let pool = next_account_info(&mut it)?;
            let collection = next_account_info(&mut it)?;
            let avatar = next_account_info(&mut it)?;
            let load = next_account_info(&mut it)?;
            let core = next_account_info(&mut it)?;
            let system = next_account_info(&mut it)?;
            signer(owner)?;
            core_program(core)?;
            let p = pool_checked(pool, program)?;
            if p[254] != 0 || key(&p, 8) != *admin.key || key(&p, 40) != *collection.key {
                return Err(err(1));
            }
            collection_authority(collection, admin)?;
            let base = core_collection(avatar, collection.key)?;
            if base.owner != *owner.key {
                return Err(err(1));
            }
            initialize_loadout(program, owner, pool, avatar, load, system, body[0], &base)?;
            let oracle = ExternalPluginAdapterInitInfo::Oracle(OracleInitInfo {
                base_address: *program,
                init_plugin_authority: Some(PluginAuthority::None),
                lifecycle_checks: vec![(
                    HookableLifecycleEvent::Burn,
                    ExternalCheckResult { flags: 4 },
                )],
                base_address_config: Some(ExtraAccount::CustomPda {
                    seeds: vec![Seed::Bytes(b"loadout-v4".to_vec()), Seed::Asset],
                    custom_program_id: Some(*program),
                    is_signer: false,
                    is_writable: false,
                }),
                results_offset: Some(ValidationResultsOffset::Custom(8)),
            });
            AddExternalPluginAdapterV1CpiBuilder::new(core)
                .asset(avatar)
                .collection(Some(collection))
                .payer(owner)
                .authority(Some(admin))
                .system_program(system)
                .init_info(oracle)
                .invoke()?;
            Ok(())
        }
        24 => {
            if body.len() != 1 || body[0] > 7 || accounts.len() != 12 {
                return Err(err(2));
            }
            let owner = next_account_info(&mut it)?;
            let admin = next_account_info(&mut it)?;
            let pool = next_account_info(&mut it)?;
            let registry = next_account_info(&mut it)?;
            let collection = next_account_info(&mut it)?;
            let avatar = next_account_info(&mut it)?;
            let load = next_account_info(&mut it)?;
            let collection_auth = next_account_info(&mut it)?;
            let oracle_program = next_account_info(&mut it)?;
            let iq_program = next_account_info(&mut it)?;
            let core = next_account_info(&mut it)?;
            let system = next_account_info(&mut it)?;
            signer(owner)?;
            core_program(core)?;
            let p = pool_checked(pool, program)?;
            if p[254] != 1
                || key(&p, 255) != *registry.key
                || key(&p, 287) != *iq_program.key
                || *iq_program.key != IQ_PROGRAM
                || !iq_program.executable
                || *oracle_program.key != *program
                || !oracle_program.executable
            {
                return Err(err(3));
            }
            sale_authority(&p, collection, admin, Some(registry))?;
            let expected_auth = Pubkey::find_program_address(
                &[b"collection-auth", registry.key.as_ref()],
                iq_program.key,
            )
            .0;
            if expected_auth != *collection_auth.key {
                return Err(err(3));
            }
            let base = core_collection(avatar, collection.key)?;
            if base.owner != *owner.key {
                return Err(err(1));
            }
            initialize_loadout(program, owner, pool, avatar, load, system, body[0], &base)?;
            let discr = hashv(&[b"global:attach_wardrobe_oracle"]).to_bytes();
            let ix = Instruction {
                program_id: *iq_program.key,
                accounts: vec![
                    AccountMeta::new_readonly(*admin.key, true),
                    AccountMeta::new(*owner.key, true),
                    AccountMeta::new_readonly(*registry.key, false),
                    AccountMeta::new(*avatar.key, false),
                    AccountMeta::new(*collection.key, false),
                    AccountMeta::new_readonly(*collection_auth.key, false),
                    AccountMeta::new_readonly(*oracle_program.key, false),
                    AccountMeta::new_readonly(*load.key, false),
                    AccountMeta::new_readonly(*pool.key, false),
                    AccountMeta::new_readonly(*core.key, false),
                    AccountMeta::new_readonly(*system.key, false),
                ],
                data: discr[..8].to_vec(),
            };
            invoke(
                &ix,
                &[
                    admin.clone(),
                    owner.clone(),
                    registry.clone(),
                    avatar.clone(),
                    collection.clone(),
                    collection_auth.clone(),
                    oracle_program.clone(),
                    load.clone(),
                    pool.clone(),
                    core.clone(),
                    system.clone(),
                    iq_program.clone(),
                ],
            )?;
            Ok(())
        }
        // Read-only purchase precondition; compose before a marketplace's payment
        // and Core transfer in the same transaction to reject stale outfits.
        25 => {
            if body.len() != 36 || accounts.len() != 3 {
                return Err(err(2));
            }
            let pool = next_account_info(&mut it)?;
            let avatar = next_account_info(&mut it)?;
            let load = next_account_info(&mut it)?;
            let pd = pool_checked(pool, program)?;
            let base = core_collection(avatar, &key(&pd, 40))?;
            let state = loadout(load, avatar, pool, program)?;
            if state[78..110] != base_hash(&base)
                || u32at(&state, 308) != u32at(body, 0)
                || hashv(&[&state]).to_bytes() != body[4..36]
            {
                return Err(err(10));
            }
            Ok(())
        }
        22 | 23 => {
            if !body.is_empty() {
                return Err(err(2));
            }
            let actor = next_account_info(&mut it)?;
            let pool = next_account_info(&mut it)?;
            let avatar = next_account_info(&mut it)?;
            let load = next_account_info(&mut it)?;
            let asset = next_account_info(&mut it)?;
            let item = next_account_info(&mut it)?;
            let auth = next_account_info(&mut it)?;
            let core = next_account_info(&mut it)?;
            let system = next_account_info(&mut it)?;
            signer(actor)?;
            core_program(core)?;
            let p = pool_checked(pool, program)?;
            let mut l = loadout(load, avatar, pool, program)?;
            let mut g = issued(item, asset, pool, program)?;
            let ab = authority(auth, pool, program)?;
            let avatar_value = core_collection(avatar, &key(&p, 40))?;
            if avatar_value.owner != *actor.key {
                return Err(err(1));
            }
            let trait_value = core_value(asset)?;
            if trait_value.update_authority != UpdateAuthority::Address(*auth.key) {
                return Err(err(3));
            }
            let id = g[75];
            let def = definition(&p, id)?;
            let slot = def[0] as usize;
            if slot >= SLOTS {
                return Err(err(3));
            }
            let slot_at = 116 + slot * 32;
            if op == 22 {
                // Withdrawal must remain possible after an authorized base URI move.
                // Only adding new gear requires the original visual identity.
                if l[78..110] != base_hash(&avatar_value) {
                    return Err(err(10));
                }
                if trait_value.owner != *actor.key
                    || key(&g, 108) != Pubkey::default()
                    || l[110 + slot] != NONE
                {
                    return Err(err(4));
                }
                l[110 + slot] = id;
                putkey(&mut l, slot_at, asset.key);
                compatible(&p, &l)?;
                TransferV1CpiBuilder::new(core)
                    .asset(asset)
                    .payer(actor)
                    .authority(Some(actor))
                    .new_owner(auth)
                    .system_program(Some(system))
                    .invoke()?;
                putkey(&mut g, 108, avatar.key);
            } else {
                if trait_value.owner != *auth.key
                    || key(&g, 108) != *avatar.key
                    || l[110 + slot] != id
                    || key(&l, slot_at) != *asset.key
                {
                    return Err(err(4));
                }
                l[110 + slot] = NONE;
                putkey(&mut l, slot_at, &Pubkey::default());
                compatible(&p, &l)?;
                let b = [ab];
                let seeds: &[&[u8]] = &[b"gear-authority-v4", pool.key.as_ref(), &b];
                TransferV1CpiBuilder::new(core)
                    .asset(asset)
                    .payer(actor)
                    .authority(Some(auth))
                    .new_owner(actor)
                    .system_program(Some(system))
                    .invoke_signed(&[seeds])?;
                putkey(&mut g, 108, &Pubkey::default());
            }
            let rev = u32at(&l, 308).checked_add(1).ok_or(err(8))?;
            put32(&mut l, 308, rev);
            policy(&mut l);
            load.try_borrow_mut_data()?.copy_from_slice(&l);
            item.try_borrow_mut_data()?.copy_from_slice(&g);
            Ok(())
        }
        _ => Err(err(2)),
    }
}
