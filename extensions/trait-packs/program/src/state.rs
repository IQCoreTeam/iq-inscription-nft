use mpl_core::{
    accounts::{BaseAssetV1, BaseCollectionV1},
    types::{Key, UpdateAuthority},
};
use solana_program::{
    account_info::AccountInfo,
    entrypoint::ProgramResult,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction, system_program,
    sysvar::Sysvar,
};
pub const POOL_MAGIC: &[u8; 8] = b"NUBSALE4";
pub const EPOCH_MAGIC: &[u8; 8] = b"NUBEPOC4";
pub const POOL_SIZE: usize = 4352;
pub const EPOCH_SIZE: usize = 2048;
pub const MAX_DEFS: usize = 16;
pub const MAX_TICKETS: usize = 32;
pub const DEF_START: usize = 384;
pub const DEF_SIZE: usize = 240;
pub const TICKET_START: usize = 256;
pub const TICKET_SIZE: usize = 48;
pub const CLAIM_BUDGET: u64 = 12_000_000;
pub const PROVIDER_RESERVE: u64 = 100_000_000;
pub fn err(n: u32) -> ProgramError {
    ProgramError::Custom(n)
}
pub fn signer(a: &AccountInfo) -> ProgramResult {
    if !a.is_signer {
        return Err(err(1));
    }
    Ok(())
}
pub fn key(d: &[u8], at: usize) -> Pubkey {
    Pubkey::new_from_array(d[at..at + 32].try_into().unwrap())
}
pub fn putkey(d: &mut [u8], at: usize, k: &Pubkey) {
    d[at..at + 32].copy_from_slice(k.as_ref());
}
pub fn u16at(d: &[u8], at: usize) -> u16 {
    u16::from_le_bytes(d[at..at + 2].try_into().unwrap())
}
pub fn put16(d: &mut [u8], at: usize, n: u16) {
    d[at..at + 2].copy_from_slice(&n.to_le_bytes());
}
pub fn u32at(d: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(d[at..at + 4].try_into().unwrap())
}
pub fn put32(d: &mut [u8], at: usize, n: u32) {
    d[at..at + 4].copy_from_slice(&n.to_le_bytes());
}
pub fn u64at(d: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(d[at..at + 8].try_into().unwrap())
}
pub fn put64(d: &mut [u8], at: usize, n: u64) {
    d[at..at + 8].copy_from_slice(&n.to_le_bytes());
}
pub fn checked(
    a: &AccountInfo,
    program: &Pubkey,
    magic: &[u8; 8],
    size: usize,
) -> Result<Vec<u8>, ProgramError> {
    if a.owner != program || a.data_len() != size {
        return Err(err(3));
    }
    let d = a.try_borrow_data()?;
    if &d[..8] != magic {
        return Err(err(3));
    }
    Ok(d.to_vec())
}
pub fn pool_checked(a: &AccountInfo, p: &Pubkey) -> Result<Vec<u8>, ProgramError> {
    let d = checked(a, p, POOL_MAGIC, POOL_SIZE)?;
    if Pubkey::find_program_address(&[b"sale-v4", key(&d, 40).as_ref()], p).0 != *a.key {
        return Err(err(3));
    }
    Ok(d)
}
pub fn epoch_checked(
    a: &AccountInfo,
    pool: &AccountInfo,
    p: &Pubkey,
) -> Result<Vec<u8>, ProgramError> {
    let d = checked(a, p, EPOCH_MAGIC, EPOCH_SIZE)?;
    if key(&d, 8) != *pool.key
        || Pubkey::find_program_address(&[b"epoch-v4", pool.key.as_ref(), &d[40..48]], p).0
            != *a.key
    {
        return Err(err(3));
    }
    Ok(d)
}
pub fn ops_checked(a: &AccountInfo, pool: &AccountInfo, p: &Pubkey) -> ProgramResult {
    if Pubkey::find_program_address(&[b"ops-v4", pool.key.as_ref()], p).0 != *a.key
        || *a.owner != system_program::id()
        || !a.data_is_empty()
        || a.executable
    {
        return Err(err(3));
    }
    Ok(())
}
pub fn create_pda<'a>(
    program: &Pubkey,
    payer: &AccountInfo<'a>,
    a: &AccountInfo<'a>,
    system: &AccountInfo<'a>,
    seeds: &[&[u8]],
    len: usize,
) -> ProgramResult {
    signer(payer)?;
    let (address, bump) = Pubkey::find_program_address(seeds, program);
    if address != *a.key
        || *system.key != system_program::id()
        || *a.owner != system_program::id()
        || !a.data_is_empty()
        || a.executable
    {
        return Err(err(3));
    }
    let b = [bump];
    let mut signed = seeds.to_vec();
    signed.push(&b);
    let rent = Rent::get()?.minimum_balance(len);
    if a.lamports() == 0 {
        return invoke_signed(
            &system_instruction::create_account(payer.key, a.key, rent, len as u64, program),
            &[payer.clone(), a.clone(), system.clone()],
            &[&signed],
        );
    }
    let top = rent.saturating_sub(a.lamports());
    if top > 0 {
        invoke(
            &system_instruction::transfer(payer.key, a.key, top),
            &[payer.clone(), a.clone(), system.clone()],
        )?;
    }
    invoke_signed(
        &system_instruction::allocate(a.key, len as u64),
        &[a.clone(), system.clone()],
        &[&signed],
    )?;
    invoke_signed(
        &system_instruction::assign(a.key, program),
        &[a.clone(), system.clone()],
        &[&signed],
    )
}
pub fn core_value(a: &AccountInfo) -> Result<BaseAssetV1, ProgramError> {
    if *a.owner != mpl_core::ID {
        return Err(err(3));
    }
    let v = BaseAssetV1::from_bytes(&a.try_borrow_data()?).map_err(|_| err(3))?;
    if v.key != Key::AssetV1 {
        return Err(err(3));
    }
    Ok(v)
}
pub fn collection_authority(c: &AccountInfo, a: &AccountInfo) -> ProgramResult {
    signer(a)?;
    if *c.owner != mpl_core::ID {
        return Err(err(3));
    }
    let v = BaseCollectionV1::from_bytes(&c.try_borrow_data()?).map_err(|_| err(3))?;
    if v.key != Key::CollectionV1 || v.update_authority != *a.key {
        return Err(err(1));
    }
    Ok(())
}
pub fn core_collection(a: &AccountInfo, c: &Pubkey) -> Result<BaseAssetV1, ProgramError> {
    let v = core_value(a)?;
    if v.update_authority != UpdateAuthority::Collection(*c) {
        return Err(err(3));
    }
    Ok(v)
}
pub fn transfer_owned(from: &AccountInfo, to: &AccountInfo, amount: u64) -> ProgramResult {
    if from.key == to.key {
        return Err(err(3));
    }
    let rest = from.lamports().checked_sub(amount).ok_or(err(8))?;
    if rest < Rent::get()?.minimum_balance(from.data_len()) {
        return Err(err(8));
    }
    let add = to.lamports().checked_add(amount).ok_or(err(8))?;
    **from.try_borrow_mut_lamports()? = rest;
    **to.try_borrow_mut_lamports()? = add;
    Ok(())
}
pub fn ticket_offset(e: &[u8], ticket: usize) -> Result<usize, ProgramError> {
    if ticket >= u16at(e, 65) as usize {
        return Err(err(3));
    }
    Ok(TICKET_START + ticket * TICKET_SIZE)
}

/// The existing IQ registry is the authorization source for program-controlled
/// Core collections. No wallet is treated as the Core PDA's private signer.
pub const IQ_PROGRAM: Pubkey =
    solana_program::pubkey!("FCGhsCf5sMM7Z5APta1hi76WGTvrfMJnBr4QSR3w13Fu");
pub fn iq_registry_authority(
    collection: &AccountInfo,
    authority: &AccountInfo,
    registry: &AccountInfo,
) -> Result<Pubkey, ProgramError> {
    signer(authority)?;
    if *registry.owner != IQ_PROGRAM || *collection.owner != mpl_core::ID {
        return Err(err(30));
    }
    let (expected, bump) =
        Pubkey::find_program_address(&[b"registry", collection.key.as_ref()], &IQ_PROGRAM);
    let (collection_auth, auth_bump) =
        Pubkey::find_program_address(&[b"collection-auth", registry.key.as_ref()], &IQ_PROGRAM);
    if expected != *registry.key {
        return Err(err(30));
    }
    let d = registry.try_borrow_data()?;
    if d.len() < 295
        || d[..8] != [47, 174, 110, 246, 184, 182, 252, 218]
        || d[8] != bump
        || d[9] != auth_bump
        || key(&d, 10) != *collection.key
        || key(&d, 74) != *authority.key
    {
        return Err(err(30));
    }
    let bitmap = (u32at(&d, 138) as usize).checked_add(7).ok_or(err(30))? / 8;
    if u32at(&d, 291) as usize != bitmap
        || d.len() != 295usize.checked_add(bitmap).ok_or(err(30))?
    {
        return Err(err(30));
    }
    let value =
        BaseCollectionV1::from_bytes(&collection.try_borrow_data()?).map_err(|_| err(30))?;
    if value.key != Key::CollectionV1 || value.update_authority != collection_auth {
        return Err(err(30));
    }
    Ok(key(&d, 106))
}

pub fn sale_authority(
    pool: &[u8],
    collection: &AccountInfo,
    authority: &AccountInfo,
    registry: Option<&AccountInfo>,
) -> ProgramResult {
    if key(pool, 8) != *authority.key || key(pool, 40) != *collection.key {
        return Err(err(1));
    }
    match pool[254] {
        0 => {
            if registry.is_some() {
                return Err(err(3));
            }
            collection_authority(collection, authority)
        }
        1 => {
            let r = registry.ok_or(err(30))?;
            if key(pool, 255) != *r.key || key(pool, 287) != IQ_PROGRAM {
                return Err(err(30));
            }
            if iq_registry_authority(collection, authority, r)? != key(pool, 72) {
                return Err(err(30));
            }
            Ok(())
        }
        _ => Err(err(30)),
    }
}
