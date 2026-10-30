use crate::state::*;
use solana_program::{
    account_info::AccountInfo,
    clock::Clock,
    entrypoint::ProgramResult,
    hash::hashv,
    instruction::{AccountMeta, Instruction},
    program::{invoke, invoke_signed},
    pubkey::Pubkey,
    system_instruction, system_program,
    sysvar::Sysvar,
};
const ORAO: Pubkey = solana_program::pubkey!("VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y");
const ORAO_MAGIC: [u8; 8] = [139, 239, 184, 215, 227, 86, 191, 226];
fn request_address(seed: &[u8], provider: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"orao-vrf-randomness-request", seed], provider).0
}
fn requester_address(epoch: &AccountInfo, p: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"requester-v4", epoch.key.as_ref()], p)
}
// Provider owns/discriminates the variable-layout record. Pending and fulfilled
// share enum + client + seed; only fulfilled exposes its 64-byte result.
fn provider_record(
    a: &AccountInfo,
    seed: &[u8],
    provider: &Pubkey,
) -> Result<(u8, Pubkey, Vec<u8>), solana_program::program_error::ProgramError> {
    if *a.key != request_address(seed, provider) || a.owner != provider {
        return Err(err(20));
    }
    let d = a.try_borrow_data()?;
    if d.len() < 73 || d[..8] != ORAO_MAGIC || d[41..73] != *seed || d[8] > 1 {
        return Err(err(20));
    }
    if d[8] == 0 {
        if d.len() < 77 {
            return Err(err(20));
        }
        let responses = u32at(&d, 73) as usize;
        if responses > 64
            || 77usize
                .checked_add(responses.checked_mul(96).ok_or(err(20))?)
                .ok_or(err(20))?
                > d.len()
        {
            return Err(err(20));
        }
    }
    if d[8] == 1 && d.len() < 137 {
        return Err(err(20));
    }
    Ok((
        d[8],
        key(&d, 9),
        if d[8] == 1 {
            d[73..137].to_vec()
        } else {
            vec![]
        },
    ))
}
fn active(pool: &[u8], epoch: &[u8]) -> ProgramResult {
    if u64at(pool, 234) != u64at(epoch, 40) {
        return Err(err(5));
    }
    Ok(())
}
fn reserved_budget(outstanding: u64) -> Result<u64, solana_program::program_error::ProgramError> {
    outstanding
        .checked_mul(CLAIM_BUDGET)
        .and_then(|n| n.checked_add(PROVIDER_RESERVE))
        .ok_or(err(8))
}
pub fn process(p: &Pubkey, a: &[AccountInfo], op: u8, d: &[u8]) -> ProgramResult {
    match op {
        0 | 15 => {
            if a.len() != (if op == 15 { 9 } else { 7 }) || d.len() != 57 {
                return Err(err(2));
            }
            let payer = &a[0];
            let pool = &a[1];
            let collection = &a[2];
            let extra = if op == 15 { 2 } else { 0 };
            let treasury = &a[3 + extra];
            let provider = &a[4 + extra];
            let provider_treasury = &a[5 + extra];
            let system = &a[6 + extra];
            if op == 15 {
                if *a[4].key != IQ_PROGRAM
                    || !a[4].executable
                    || iq_registry_authority(collection, payer, &a[3])? != *treasury.key
                {
                    return Err(err(30));
                }
            } else {
                collection_authority(collection, payer)?;
            }
            if *provider.key != ORAO || !provider.executable || treasury.key == pool.key {
                return Err(err(3));
            }
            let price = u64at(d, 0);
            let window = u64at(d, 8);
            let timeout = u64at(d, 16);
            let count = d[24] as usize;
            if price == 0
                || window == 0
                || timeout == 0
                || count == 0
                || count > MAX_DEFS
                || d[25..57].iter().all(|b| *b == 0)
            {
                return Err(err(2));
            }
            create_pda(
                p,
                payer,
                pool,
                system,
                &[b"sale-v4", collection.key.as_ref()],
                POOL_SIZE,
            )?;
            let mut data = pool.try_borrow_mut_data()?;
            data[..8].copy_from_slice(POOL_MAGIC);
            putkey(&mut data, 8, payer.key);
            putkey(&mut data, 40, collection.key);
            putkey(&mut data, 72, treasury.key);
            putkey(&mut data, 104, provider.key);
            putkey(&mut data, 136, provider_treasury.key);
            data[168..200].copy_from_slice(&d[25..57]);
            put64(&mut data, 200, price);
            data[208] = count as u8;
            data[209] = 4;
            put64(&mut data, 210, window);
            put64(&mut data, 218, timeout);
            if op == 15 {
                data[254] = 1;
                putkey(&mut data, 255, a[3].key);
                putkey(&mut data, 287, a[4].key);
            }
            Ok(())
        }
        1 => {
            if !(a.len() == 4 || a.len() == 5) || !d.is_empty() {
                return Err(err(2));
            }
            let payer = &a[0];
            let pool = &a[1];
            let epoch = &a[2];
            let system = &a[3];
            let mut pd = pool_checked(pool, p)?;
            let id = u64at(&pd, 226);
            if pd[250] != 1 || pd[252] != 0 {
                return Err(err(5));
            }
            if id > 0 {
                if a.len() != 5 {
                    return Err(err(5));
                }
                let old = epoch_checked(&a[4], pool, p)?;
                if u64at(&old, 40) != id - 1 || ![4, 5, 6].contains(&old[48]) {
                    return Err(err(5));
                }
                if old[48] == 5 {
                    for n in 0..u16at(&old, 65) as usize {
                        if old[TICKET_START + n * TICKET_SIZE + 45] != 1 {
                            return Err(err(5));
                        }
                    }
                }
            }
            let total = (0..pd[208] as usize)
                .map(|i| u32at(&pd, DEF_START + i * DEF_SIZE + 232) as u64)
                .sum::<u64>();
            if total < 4 {
                return Err(err(7));
            }
            create_pda(
                p,
                payer,
                epoch,
                system,
                &[b"epoch-v4", pool.key.as_ref(), &id.to_le_bytes()],
                EPOCH_SIZE,
            )?;
            let now = Clock::get()?.slot;
            let close = now.checked_add(u64at(&pd, 210)).ok_or(err(8))?;
            let deadline = close.checked_add(u64at(&pd, 218)).ok_or(err(8))?;
            let mut ed = epoch.try_borrow_mut_data()?;
            ed[..8].copy_from_slice(EPOCH_MAGIC);
            putkey(&mut ed, 8, pool.key);
            put64(&mut ed, 40, id);
            ed[48] = 1;
            put64(&mut ed, 49, close);
            put64(&mut ed, 57, deadline);
            drop(ed);
            put64(&mut pd, 226, id.checked_add(1).ok_or(err(8))?);
            put64(&mut pd, 234, id);
            pool.try_borrow_mut_data()?.copy_from_slice(&pd);
            Ok(())
        }
        2 => {
            if a.len() != 5 || d.len() != 2 {
                return Err(err(2));
            }
            let buyer = &a[0];
            let pool = &a[1];
            let epoch = &a[2];
            let ops = &a[3];
            let system = &a[4];
            signer(buyer)?;
            ops_checked(ops, pool, p)?;
            let mut pd = pool_checked(pool, p)?;
            let mut ed = epoch_checked(epoch, pool, p)?;
            active(&pd, &ed)?;
            let n = u16at(&ed, 65) as usize;
            if pd[252] != 0
                || ed[48] != 1
                || Clock::get()?.slot >= u64at(&ed, 49)
                || n >= MAX_TICKETS
                || u16at(d, 0) as usize != n
                || *system.key != system_program::id()
            {
                return Err(err(5));
            }
            let total = (0..pd[208] as usize)
                .map(|i| u32at(&pd, DEF_START + i * DEF_SIZE + 232) as u64)
                .sum::<u64>();
            if total < (n as u64 + 1) * 4 {
                return Err(err(7));
            }
            let outstanding = u64at(&pd, 242).checked_add(4).ok_or(err(8))?;
            if ops.lamports() < reserved_budget(outstanding)? {
                return Err(err(8));
            }
            let price = u64at(&pd, 200);
            let escrow = u64at(&ed, 69).checked_add(price).ok_or(err(8))?;
            invoke(
                &system_instruction::transfer(buyer.key, epoch.key, price),
                &[buyer.clone(), epoch.clone(), system.clone()],
            )?;
            let at = TICKET_START + n * TICKET_SIZE;
            putkey(&mut ed, at, buyer.key);
            put64(&mut ed, at + 32, price);
            ed[at + 40..at + 44].fill(255);
            put16(&mut ed, 65, (n + 1) as u16);
            put64(&mut ed, 69, escrow);
            put64(&mut pd, 242, outstanding);
            epoch.try_borrow_mut_data()?.copy_from_slice(&ed);
            pool.try_borrow_mut_data()?.copy_from_slice(&pd);
            Ok(())
        }
        3 => {
            if a.len() != 2 || !d.is_empty() {
                return Err(err(2));
            }
            let pd = pool_checked(&a[0], p)?;
            let mut ed = epoch_checked(&a[1], &a[0], p)?;
            active(&pd, &ed)?;
            if ed[48] != 1 {
                return Err(err(5));
            }
            let n = u16at(&ed, 65) as usize;
            let total = (0..pd[208] as usize)
                .map(|i| u32at(&pd, DEF_START + i * DEF_SIZE + 232) as u64)
                .sum::<u64>();
            if Clock::get()?.slot < u64at(&ed, 49) && n < MAX_TICKETS && total >= (n as u64 + 1) * 4
            {
                return Err(err(5));
            }
            if n == 0 {
                ed[48] = 5;
            } else {
                for i in 0..pd[208] as usize {
                    put32(
                        &mut ed,
                        160 + i * 4,
                        u32at(&pd, DEF_START + i * DEF_SIZE + 232),
                    );
                }
                let seed = hashv(&[
                    b"nubbies-paid-v4",
                    p.as_ref(),
                    a[0].key.as_ref(),
                    a[1].key.as_ref(),
                    &pd,
                    &ed[..77],
                    &ed[160..224],
                    &ed[TICKET_START..TICKET_START + n * TICKET_SIZE],
                ])
                .to_bytes();
                ed[77..109].copy_from_slice(&seed);
                ed[48] = 2;
            }
            a[1].try_borrow_mut_data()?.copy_from_slice(&ed);
            Ok(())
        }
        4 => {
            if a.len() != 9 || d.len() != 40 {
                return Err(err(2));
            }
            let sponsor = &a[0];
            let pool = &a[1];
            let epoch = &a[2];
            let requester = &a[3];
            let network = &a[4];
            let treasury = &a[5];
            let request = &a[6];
            let provider = &a[7];
            let system = &a[8];
            signer(sponsor)?;
            let pd = pool_checked(pool, p)?;
            let mut ed = epoch_checked(epoch, pool, p)?;
            if ed[48] != 2
                || ed[141] != 0
                || Clock::get()?.slot > u64at(&ed, 57)
                || *provider.key != key(&pd, 104)
                || !provider.executable
                || *treasury.key != key(&pd, 136)
                || *system.key != system_program::id()
            {
                return Err(err(5));
            }
            // The frozen snapshot commits to buyers/inventory without publishing the
            // provider seed. Reserve a nonce-derived candidate only if CPI succeeds.
            let candidate = hashv(&[
                b"nubbies-paid-request-v6",
                &ed[77..109],
                &d[8..40],
                p.as_ref(),
                pool.key.as_ref(),
                epoch.key.as_ref(),
                requester.key.as_ref(),
            ])
            .to_bytes();
            let (client, bump) = requester_address(epoch, p);
            if client != *requester.key
                || *requester.owner != system_program::id()
                || !requester.data_is_empty()
                || requester.executable
                || Pubkey::find_program_address(&[b"orao-vrf-network-configuration"], provider.key)
                    .0
                    != *network.key
                || *network.owner != *provider.key
                || *request.key != request_address(&candidate, provider.key)
                || *request.owner != system_program::id()
                || !request.data_is_empty()
            {
                return Err(err(20));
            }
            let funding = u64at(d, 0);
            if funding > PROVIDER_RESERVE {
                return Err(err(8));
            }
            if funding > 0 {
                invoke(
                    &system_instruction::transfer(sponsor.key, requester.key, funding),
                    &[sponsor.clone(), requester.clone(), system.clone()],
                )?;
            }
            let mut data = vec![38, 151, 209, 6, 195, 102, 28, 217];
            data.extend_from_slice(&candidate);
            let ix = Instruction {
                program_id: *provider.key,
                accounts: vec![
                    AccountMeta::new(*requester.key, true),
                    AccountMeta::new(*network.key, false),
                    AccountMeta::new(*treasury.key, false),
                    AccountMeta::new(*request.key, false),
                    AccountMeta::new_readonly(*system.key, false),
                ],
                data,
            };
            invoke_signed(
                &ix,
                &[
                    requester.clone(),
                    network.clone(),
                    treasury.clone(),
                    request.clone(),
                    system.clone(),
                    provider.clone(),
                ],
                &[&[b"requester-v4", epoch.key.as_ref(), &[bump]]],
            )?;
            let (status, owner, _) = provider_record(request, &candidate, provider.key)?;
            if status != 0 || owner != client {
                return Err(err(20));
            }
            ed[77..109].copy_from_slice(&candidate);
            ed[48] = 3;
            ed[141] = 1;
            putkey(&mut ed, 224, sponsor.key);
            epoch.try_borrow_mut_data()?.copy_from_slice(&ed);
            Ok(())
        }
        5 => {
            if a.len() != 4 || !d.is_empty() {
                return Err(err(2));
            }
            let pd = pool_checked(&a[0], p)?;
            let mut ed = epoch_checked(&a[1], &a[0], p)?;
            if ed[48] != 3 || ed[141] != 1 {
                return Err(err(5));
            }
            let (client, _) = requester_address(&a[1], p);
            if client != *a[2].key {
                return Err(err(20));
            }
            let (status, owner, result) = provider_record(&a[3], &ed[77..109], &key(&pd, 104))?;
            if status != 1 || owner != client {
                return Err(err(20));
            }
            ed[109..141].copy_from_slice(&hashv(&[b"NUBBIES_ORAO_RESULT_V4", &result]).to_bytes());
            ed[48] = 7; // allocating, distinct from allocated4
            a[1].try_borrow_mut_data()?.copy_from_slice(&ed);
            Ok(())
        }
        6 => {
            if a.len() != 2 || d.len() != 1 || d[0] == 0 || d[0] > 8 {
                return Err(err(2));
            }
            let mut pd = pool_checked(&a[0], p)?;
            let mut ed = epoch_checked(&a[1], &a[0], p)?;
            if ed[48] != 7 {
                return Err(err(5));
            }
            let n = u16at(&ed, 65) as usize;
            let start = u16at(&ed, 67) as usize;
            let stop = std::cmp::min(start + d[0] as usize, n);
            for ticket in start..stop {
                for pull in 0..4 {
                    let total = (0..pd[208] as usize)
                        .map(|i| u32at(&ed, 160 + i * 4) as u64)
                        .sum::<u64>();
                    if total == 0 {
                        return Err(err(7));
                    }
                    let mut retry = 0u32;
                    let ceiling = u64::MAX - u64::MAX % total;
                    let pick = loop {
                        let h = hashv(&[
                            b"nubbies-draw-v4",
                            &ed[109..141],
                            &ed[77..109],
                            &(ticket as u32).to_le_bytes(),
                            &(pull as u32).to_le_bytes(),
                            &retry.to_le_bytes(),
                        ])
                        .to_bytes();
                        let value = u64::from_le_bytes(h[..8].try_into().unwrap());
                        if value < ceiling {
                            break value % total;
                        }
                        retry = retry.checked_add(1).ok_or(err(8))?;
                        if retry > 128 {
                            return Err(err(8));
                        }
                    };
                    let mut value = pick;
                    let mut chosen = None;
                    for i in 0..pd[208] as usize {
                        let left = u32at(&ed, 160 + i * 4);
                        if value < left as u64 {
                            chosen = Some(i);
                            put32(&mut ed, 160 + i * 4, left - 1);
                            break;
                        }
                        value -= left as u64;
                    }
                    let chosen = chosen.ok_or(err(7))?;
                    ed[TICKET_START + ticket * TICKET_SIZE + 40 + pull] = chosen as u8;
                }
                put16(&mut ed, 67, (ticket + 1) as u16);
            }
            if stop == n {
                for i in 0..pd[208] as usize {
                    put32(
                        &mut pd,
                        DEF_START + i * DEF_SIZE + 232,
                        u32at(&ed, 160 + i * 4),
                    );
                }
                ed[48] = 4;
                a[0].try_borrow_mut_data()?.copy_from_slice(&pd);
            }
            a[1].try_borrow_mut_data()?.copy_from_slice(&ed);
            Ok(())
        }
        7 => {
            if a.len() != 3 || d.len() != 2 {
                return Err(err(2));
            }
            let mut pd = pool_checked(&a[0], p)?;
            let mut ed = epoch_checked(&a[1], &a[0], p)?;
            let at = ticket_offset(&ed, u16at(d, 0) as usize)?;
            if ed[48] != 5 || ed[at + 45] != 0 || key(&ed, at) != *a[2].key {
                return Err(err(5));
            }
            let paid = u64at(&ed, at + 32);
            transfer_owned(&a[1], &a[2], paid)?;
            let escrow = u64at(&ed, 69).checked_sub(paid).ok_or(err(8))?;
            put64(&mut ed, 69, escrow);
            ed[at + 45] = 1;
            let left = u64at(&pd, 242).checked_sub(4).ok_or(err(8))?;
            put64(&mut pd, 242, left);
            a[1].try_borrow_mut_data()?.copy_from_slice(&ed);
            a[0].try_borrow_mut_data()?.copy_from_slice(&pd);
            Ok(())
        }
        8 => {
            if a.len() != 4 || !d.is_empty() {
                return Err(err(2));
            }
            let pd = pool_checked(&a[0], p)?;
            let mut ed = epoch_checked(&a[1], &a[0], p)?;
            if ![2, 3].contains(&ed[48]) || Clock::get()?.slot <= u64at(&ed, 57) {
                return Err(err(5));
            }
            // A successful provider CPI and own-request marker write are atomic.
            // Before that marker, timeout must not depend on any provider seed.
            if ed[48] == 2 {
                if ed[141] != 0 {
                    return Err(err(20));
                }
            } else {
                let client = requester_address(&a[1], p).0;
                if ed[141] != 1 || client != *a[2].key {
                    return Err(err(20));
                }
                let (status, owner, _) = provider_record(&a[3], &ed[77..109], &key(&pd, 104))?;
                if status != 0 || owner != client {
                    return Err(err(20));
                }
            }
            ed[48] = 5;
            a[1].try_borrow_mut_data()?.copy_from_slice(&ed);
            Ok(())
        }
        9 => {
            if a.len() != 5 || !d.is_empty() {
                return Err(err(2));
            }
            pool_checked(&a[0], p)?;
            let ed = epoch_checked(&a[1], &a[0], p)?;
            if ed[141] != 1
                || ![4, 5, 6, 7].contains(&ed[48])
                || key(&ed, 224) != *a[3].key
                || *a[4].key != system_program::id()
            {
                return Err(err(5));
            }
            let (client, bump) = requester_address(&a[1], p);
            if client != *a[2].key
                || *a[2].owner != system_program::id()
                || !a[2].data_is_empty()
                || a[2].executable
                || a[2].key == a[3].key
            {
                return Err(err(3));
            }
            let amount = a[2].lamports();
            if amount > 0 {
                invoke_signed(
                    &system_instruction::transfer(a[2].key, a[3].key, amount),
                    &[a[2].clone(), a[3].clone(), a[4].clone()],
                    &[&[b"requester-v4", a[1].key.as_ref(), &[bump]]],
                )?;
            }
            Ok(())
        }
        10 => {
            if a.len() != 3 || !d.is_empty() {
                return Err(err(2));
            }
            let pd = pool_checked(&a[0], p)?;
            let mut ed = epoch_checked(&a[1], &a[0], p)?;
            if ed[48] != 4 || *a[2].key != key(&pd, 72) {
                return Err(err(5));
            }
            for n in 0..u16at(&ed, 65) as usize {
                if ed[TICKET_START + n * TICKET_SIZE + 44] != 15 {
                    return Err(err(5));
                }
            }
            let amount = u64at(&ed, 69);
            transfer_owned(&a[1], &a[2], amount)?;
            put64(&mut ed, 69, 0);
            ed[48] = 6;
            a[1].try_borrow_mut_data()?.copy_from_slice(&ed);
            Ok(())
        }
        11 => {
            if ![3, 4].contains(&a.len()) || d.len() < 2 {
                return Err(err(2));
            }
            let mut pd = pool_checked(&a[1], p)?;
            if pd[250] != 0 || key(&pd, 8) != *a[0].key || key(&pd, 40) != *a[2].key {
                return Err(err(1));
            }
            sale_authority(&pd, &a[2], &a[0], a.get(3))?;
            let start = d[0] as usize;
            let count = d[1] as usize;
            if start != pd[251] as usize
                || count == 0
                || count > 2
                || start + count > pd[208] as usize
                || d.len() != 2 + count * DEF_SIZE
            {
                return Err(err(2));
            }
            for i in 0..count {
                let def = &d[2 + i * DEF_SIZE..2 + (i + 1) * DEF_SIZE];
                if def[0] > 5
                    || def[1] == 0
                    || def[2] != 255 && (def[2] > 5 || def[3] >= pd[208])
                    || def[36] == 0
                    || def[36] > 32
                    || def[69] == 0
                    || def[69] > 160
                    || def[4..36].iter().all(|b| *b == 0)
                {
                    return Err(err(7));
                }
                std::str::from_utf8(&def[37..37 + def[36] as usize]).map_err(|_| err(7))?;
                std::str::from_utf8(&def[70..70 + def[69] as usize]).map_err(|_| err(7))?;
            }
            pd[DEF_START + start * DEF_SIZE..DEF_START + (start + count) * DEF_SIZE]
                .copy_from_slice(&d[2..]);
            pd[251] = (start + count) as u8;
            a[1].try_borrow_mut_data()?.copy_from_slice(&pd);
            Ok(())
        }
        12 => {
            if ![3, 4].contains(&a.len()) || !d.is_empty() {
                return Err(err(2));
            }
            let mut pd = pool_checked(&a[1], p)?;
            if pd[250] != 0
                || pd[251] != pd[208]
                || key(&pd, 8) != *a[0].key
                || key(&pd, 40) != *a[2].key
            {
                return Err(err(1));
            }
            sale_authority(&pd, &a[2], &a[0], a.get(3))?;
            let defs = &pd[DEF_START..DEF_START + pd[208] as usize * DEF_SIZE];
            if hashv(&[defs]).to_bytes() != pd[168..200] {
                return Err(err(7));
            }
            for i in 0..pd[208] as usize {
                let mut cursor = i;
                let mut visited_slots = 0u8;
                let issued = u32at(&pd, DEF_START + i * DEF_SIZE + 232) > 0;
                for depth in 0..=pd[208] as usize {
                    let at = DEF_START + cursor * DEF_SIZE;
                    let slot_bit = 1u8 << pd[at];
                    if visited_slots & slot_bit != 0 {
                        return Err(err(7));
                    }
                    visited_slots |= slot_bit;
                    if pd[at + 2] == 255 {
                        break;
                    }
                    let target = pd[at + 3] as usize;
                    if target >= pd[208] as usize {
                        return Err(err(7));
                    }
                    let to = DEF_START + target * DEF_SIZE;
                    if pd[to] != pd[at + 2]
                        || pd[at + 1] & !pd[to + 1] != 0
                        || (issued && u32at(&pd, to + 232) == 0)
                        || depth == pd[208] as usize
                    {
                        return Err(err(7));
                    }
                    cursor = target;
                }
            }
            let total = (0..pd[208] as usize)
                .map(|i| u32at(&pd, DEF_START + i * DEF_SIZE + 232) as u64)
                .sum::<u64>();
            if total < 4 || total > 1_000_000 {
                return Err(err(7));
            }
            pd[250] = 1;
            a[1].try_borrow_mut_data()?.copy_from_slice(&pd);
            Ok(())
        }
        13 => {
            if a.len() != 5 || d.len() != 8 {
                return Err(err(2));
            }
            signer(&a[0])?;
            let pd = pool_checked(&a[1], p)?;
            ops_checked(&a[2], &a[1], p)?;
            if key(&pd, 8) != *a[0].key
                || key(&pd, 72) != *a[3].key
                || *a[4].key != system_program::id()
            {
                return Err(err(1));
            }
            let amount = u64at(d, 0);
            let remaining = a[2].lamports().checked_sub(amount).ok_or(err(8))?;
            let floor = if pd[252] == 1 {
                if u64at(&pd, 242) != 0 {
                    return Err(err(8));
                }
                0
            } else {
                reserved_budget(u64at(&pd, 242))?
            };
            if remaining < floor
                || (remaining > 0
                    && remaining < solana_program::rent::Rent::get()?.minimum_balance(0))
            {
                return Err(err(8));
            }
            let bump = Pubkey::find_program_address(&[b"ops-v4", a[1].key.as_ref()], p).1;
            invoke_signed(
                &system_instruction::transfer(a[2].key, a[3].key, amount),
                &[a[2].clone(), a[3].clone(), a[4].clone()],
                &[&[b"ops-v4", a[1].key.as_ref(), &[bump]]],
            )?;
            Ok(())
        }
        14 => {
            if !(a.len() == 2 || a.len() == 3) || !d.is_empty() {
                return Err(err(2));
            }
            signer(&a[0])?;
            let mut pd = pool_checked(&a[1], p)?;
            if key(&pd, 8) != *a[0].key || pd[252] != 0 || u64at(&pd, 242) != 0 {
                return Err(err(1));
            }
            let count = u64at(&pd, 226);
            if count > 0 {
                if a.len() != 3 {
                    return Err(err(5));
                }
                let ed = epoch_checked(&a[2], &a[1], p)?;
                if u64at(&ed, 40) != count - 1 || ![5, 6].contains(&ed[48]) || u64at(&ed, 69) != 0 {
                    return Err(err(5));
                }
                if ed[48] == 5 {
                    for i in 0..u16at(&ed, 65) as usize {
                        if ed[TICKET_START + i * TICKET_SIZE + 45] != 1 {
                            return Err(err(5));
                        }
                    }
                }
            }
            pd[252] = 1;
            a[1].try_borrow_mut_data()?.copy_from_slice(&pd);
            Ok(())
        }
        _ => Err(err(2)),
    }
}
