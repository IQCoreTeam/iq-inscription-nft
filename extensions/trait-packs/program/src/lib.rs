use solana_program::{
    account_info::AccountInfo, entrypoint, entrypoint::ProgramResult, pubkey::Pubkey,
};
pub mod epoch;
pub mod gear;
pub mod state;
entrypoint!(process_instruction);
pub fn process_instruction(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> ProgramResult {
    let (op, data) = d.split_first().ok_or(state::err(2))?;
    match *op {
        0..=15 => epoch::process(p, a, *op, data),
        20..=29 => gear::process(p, a, *op, data),
        _ => Err(state::err(2)),
    }
}
