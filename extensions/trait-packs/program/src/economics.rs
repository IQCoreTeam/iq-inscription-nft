use solana_program::{program_error::ProgramError, pubkey::Pubkey};

use crate::state::err;

// Match the IQ NFT program's fixed surcharge and recipient. Neither is a
// creator-controlled catalog field. V5 pools escrow the entire buyer payment.
pub const PLATFORM_TREASURY: Pubkey =
    solana_program::pubkey!("EWNSTD8tikwqHMcRNuuNbZrnYJUiJdKq9UXLXSEU4wZ1");
pub const PLATFORM_FEE_BPS: u64 = 500;

pub struct PackCharge {
    pub platform_fee: u64,
    pub total: u64,
}

pub fn pack_charge(creator_price: u64) -> Result<PackCharge, ProgramError> {
    if creator_price == 0 {
        return Err(err(2));
    }
    let platform_fee =
        ((creator_price as u128 * PLATFORM_FEE_BPS as u128) / 10_000) as u64;
    let total = creator_price.checked_add(platform_fee).ok_or(err(8))?;
    Ok(PackCharge { platform_fee, total })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_iq_surcharge_and_per_purchase_rounding() {
        for (price, fee, total) in [
            (1, 0, 1),
            (19, 0, 19),
            (20, 1, 21),
            (21, 1, 22),
            (100_000_000, 5_000_000, 105_000_000),
        ] {
            let charge = pack_charge(price).unwrap();
            assert_eq!((charge.platform_fee, charge.total), (fee, total));
        }
        // Rounding is per ticket, not on the aggregate epoch revenue.
        assert_eq!(pack_charge(19).unwrap().platform_fee * 32, 0);
    }

    #[test]
    fn rejects_free_prices_and_total_payment_overflow() {
        assert!(pack_charge(0).is_err());
        assert!(pack_charge(u64::MAX).is_err());
        let largest = u64::MAX as u128 * 10_000 / 10_500;
        assert!(pack_charge(largest as u64).is_ok());
        assert!(pack_charge((largest + 2) as u64).is_err());
    }
}
