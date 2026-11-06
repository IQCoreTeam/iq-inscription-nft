//! Fixed supply, transferable Core pack entitlements. No randomness is requested
//! until the current holder consumes a pack. Its prepaid price follows that right.
use crate::{economics::pack_charge, epoch, state::*};
use mpl_core::{
    accounts::BaseAssetV1,
    instructions::{
        AddExternalPluginAdapterV1CpiBuilder, BurnV1CpiBuilder, CreateCollectionV1CpiBuilder,
        CreateV1CpiBuilder,
    },
    types::{
        DataState, ExternalCheckResult, ExternalPluginAdapterInitInfo, ExtraAccount,
        HookableLifecycleEvent, OracleInitInfo, PluginAuthority, Seed, UpdateAuthority,
        ValidationResultsOffset,
    },
};
use solana_program::{
    account_info::AccountInfo, entrypoint::ProgramResult, program::invoke, pubkey::Pubkey,
    system_instruction, system_program,
};
const RELEASE_SIZE: usize = 320;
const PACK_SIZE: usize = 160;
fn release(
    a: &AccountInfo,
    pool: &AccountInfo,
    p: &Pubkey,
) -> Result<Vec<u8>, solana_program::program_error::ProgramError> {
    let d = checked(a, p, b"NUBSEAL1", RELEASE_SIZE)?;
    if Pubkey::find_program_address(&[b"sealed-release-v1", pool.key.as_ref()], p).0 != *a.key
        || key(&d, 8) != *pool.key
    {
        return Err(err(40));
    }
    Ok(d)
}
pub fn process(p: &Pubkey, a: &[AccountInfo], op: u8, d: &[u8]) -> ProgramResult {
    match op {
        30 => {
            // creator,pool,release,pack collection signer,authority,Core,system
            if a.len() != 7 || d.len() != 197 {
                return Err(err(2));
            }
            signer(&a[0])?;
            signer(&a[3])?;
            let mut pd = pool_checked(&a[1], p)?;
            let supply = u32at(d, 0);
            let name_len = d[4] as usize;
            let uri_len = d[37] as usize;
            let total = (0..pd[208] as usize)
                .map(|i| u32at(&pd, DEF_START + i * DEF_SIZE + 232) as u64)
                .sum::<u64>();
            if key(&pd, 8) != *a[0].key
                || pd[250] != 1
                || pd[252] != 0
                || pd[253] != 0
                || u64at(&pd, 226) != 0
                || u64at(&pd, 242) != 0
                || supply == 0
                || supply as u64 > total / 4
                || name_len == 0
                || name_len > 32
                || uri_len == 0
                || uri_len > 159
                || *a[5].key != mpl_core::ID
                || !a[5].executable
                || *a[6].key != system_program::id()
            {
                return Err(err(40));
            }
            let (auth, bump) =
                Pubkey::find_program_address(&[b"sealed-authority-v1", a[2].key.as_ref()], p);
            if auth != *a[4].key {
                return Err(err(40));
            }
            let name = std::str::from_utf8(&d[5..5 + name_len])
                .map_err(|_| err(2))?
                .to_string();
            let uri = std::str::from_utf8(&d[38..38 + uri_len])
                .map_err(|_| err(2))?
                .to_string();
            create_pda(
                p,
                &a[0],
                &a[2],
                &a[6],
                &[b"sealed-release-v1", a[1].key.as_ref()],
                RELEASE_SIZE,
            )?;
            CreateCollectionV1CpiBuilder::new(&a[5])
                .collection(&a[3])
                .update_authority(Some(&a[4]))
                .payer(&a[0])
                .system_program(&a[6])
                .name(name)
                .uri(uri)
                .invoke_signed(&[&[b"sealed-authority-v1", a[2].key.as_ref(), &[bump]]])?;
            let mut rd = a[2].try_borrow_mut_data()?;
            rd[..8].copy_from_slice(b"NUBSEAL1");
            putkey(&mut rd, 8, a[1].key);
            putkey(&mut rd, 40, a[3].key);
            put32(&mut rd, 72, supply);
            rd[84..277].copy_from_slice(&d[4..197]);
            pd[253] = 1;
            a[1].try_borrow_mut_data()?.copy_from_slice(&pd);
            Ok(())
        }
        31 => {
            // buyer,pool,release,pack collection,new asset,receipt,authority,ops,Core,system
            if a.len() != 10 || d.len() != 12 {
                return Err(err(2));
            }
            signer(&a[0])?;
            signer(&a[4])?;
            let mut pd = pool_checked(&a[1], p)?;
            let mut rd = release(&a[2], &a[1], p)?;
            ops_checked(&a[7], &a[1], p)?;
            let serial = u32at(&rd, 76);
            let price = pack_charge(u64at(&pd, 200))?.total;
            if pd[253] != 1
                || pd[252] != 0
                || serial >= u32at(&rd, 72)
                || u32at(d, 0) != serial
                || u64at(d, 4) != price
                || key(&rd, 40) != *a[3].key
                || *a[8].key != mpl_core::ID
                || !a[8].executable
                || *a[9].key != system_program::id()
            {
                return Err(err(40));
            }
            let (auth, bump) =
                Pubkey::find_program_address(&[b"sealed-authority-v1", a[2].key.as_ref()], p);
            if auth != *a[6].key {
                return Err(err(40));
            }
            let outstanding = u64at(&pd, 242).checked_add(4).ok_or(err(8))?;
            if a[7].lamports()
                < outstanding
                    .checked_mul(CLAIM_BUDGET)
                    .and_then(|v| v.checked_add(PROVIDER_RESERVE))
                    .ok_or(err(8))?
            {
                return Err(err(8));
            }
            create_pda(
                p,
                &a[0],
                &a[5],
                &a[9],
                &[b"sealed-pack-v1", a[4].key.as_ref()],
                PACK_SIZE,
            )?;
            {
                let mut receipt = a[5].try_borrow_mut_data()?;
                receipt[..8].copy_from_slice(b"NUBPACK1");
                receipt[8..13].copy_from_slice(&[1, 2, 2, 1, 2]);
                putkey(&mut receipt, 16, a[2].key);
                putkey(&mut receipt, 48, a[4].key);
                put32(&mut receipt, 80, serial);
                put64(&mut receipt, 88, price);
            }
            invoke(
                &system_instruction::transfer(a[0].key, a[5].key, price),
                &[a[0].clone(), a[5].clone(), a[9].clone()],
            )?;
            let name = std::str::from_utf8(&rd[85..85 + rd[84] as usize])
                .map_err(|_| err(2))?
                .to_string();
            let uri = std::str::from_utf8(&rd[118..118 + rd[117] as usize])
                .map_err(|_| err(2))?
                .to_string();
            let seeds: &[&[u8]] = &[b"sealed-authority-v1", a[2].key.as_ref(), &[bump]];
            CreateV1CpiBuilder::new(&a[8])
                .asset(&a[4])
                .collection(Some(&a[3]))
                .authority(Some(&a[6]))
                .payer(&a[0])
                .owner(Some(&a[0]))
                .system_program(&a[9])
                .data_state(DataState::AccountState)
                .name(name)
                .uri(uri)
                .invoke_signed(&[seeds])?;
            let oracle = ExternalPluginAdapterInitInfo::Oracle(OracleInitInfo {
                base_address: *p,
                init_plugin_authority: Some(PluginAuthority::None),
                lifecycle_checks: vec![(
                    HookableLifecycleEvent::Burn,
                    ExternalCheckResult { flags: 4 },
                )],
                base_address_config: Some(ExtraAccount::CustomPda {
                    seeds: vec![Seed::Bytes(b"sealed-pack-v1".to_vec()), Seed::Asset],
                    custom_program_id: Some(*p),
                    is_signer: false,
                    is_writable: false,
                }),
                results_offset: Some(ValidationResultsOffset::Custom(8)),
            });
            AddExternalPluginAdapterV1CpiBuilder::new(&a[8])
                .asset(&a[4])
                .collection(Some(&a[3]))
                .payer(&a[0])
                .authority(Some(&a[6]))
                .system_program(&a[9])
                .init_info(oracle)
                .invoke_signed(&[seeds])?;
            put32(&mut rd, 76, serial.checked_add(1).ok_or(err(8))?);
            put64(&mut pd, 242, outstanding);
            a[2].try_borrow_mut_data()?.copy_from_slice(&rd);
            a[1].try_borrow_mut_data()?.copy_from_slice(&pd);
            Ok(())
        }
        32 => {
            // holder,pool,release,pack collection,asset,receipt,epoch,ops,Core,system
            if a.len() != 10 || d.len() != 10 {
                return Err(err(2));
            }
            signer(&a[0])?;
            let pd = pool_checked(&a[1], p)?;
            let mut rd = release(&a[2], &a[1], p)?;
            let mut receipt = checked(&a[5], p, b"NUBPACK1", PACK_SIZE)?;
            if pd[253] != 1
                || key(&rd, 40) != *a[3].key
                || key(&receipt, 16) != *a[2].key
                || key(&receipt, 48) != *a[4].key
                || receipt[13] != 0
                || Pubkey::find_program_address(&[b"sealed-pack-v1", a[4].key.as_ref()], p).0
                    != *a[5].key
                || *a[8].key != mpl_core::ID
                || !a[8].executable
                || *a[4].owner != mpl_core::ID
                || u64at(&receipt, 88) != u64at(d, 2)
            {
                return Err(err(40));
            }
            let asset = BaseAssetV1::from_bytes(&a[4].try_borrow_data()?).map_err(|_| err(3))?;
            if asset.owner != *a[0].key
                || asset.update_authority != UpdateAuthority::Collection(*a[3].key)
            {
                return Err(err(1));
            }
            receipt[13] = 1;
            receipt[11] = 2;
            putkey(&mut receipt, 96, a[0].key);
            let ed = epoch_checked(&a[6], &a[1], p)?;
            put64(&mut receipt, 128, u64at(&ed, 40));
            put16(&mut receipt, 136, u16at(d, 0));
            a[5].try_borrow_mut_data()?.copy_from_slice(&receipt);
            BurnV1CpiBuilder::new(&a[8])
                .asset(&a[4])
                .collection(Some(&a[3]))
                .payer(&a[0])
                .authority(Some(&a[0]))
                .system_program(Some(&a[9]))
                .add_remaining_account(&a[5], false, false)
                .invoke()?;
            epoch::buy_ticket(
                p,
                &[
                    a[0].clone(),
                    a[1].clone(),
                    a[6].clone(),
                    a[7].clone(),
                    a[9].clone(),
                ],
                d,
                Some(&a[5]),
            )?;
            let opened = u32at(&rd, 80).checked_add(1).ok_or(err(8))?;
            put32(&mut rd, 80, opened);
            a[2].try_borrow_mut_data()?.copy_from_slice(&rd);
            Ok(())
        }
        _ => Err(err(2)),
    }
}
