//! Token decimals, sourced by batched `eth_call` and memoised per block.
//!
//! WHY THIS EXISTS: the brief assumed `erc20-tokens` supplies `decimals`. It does
//! not, and no prebuilt Pinax package does (five checked, all zero occurrences -
//! NOTES.md 5.2). Decimals are an immutable ERC-20 constant, so reading them on
//! first sight of an asset is the correct live source. Pinax establishes the same
//! RPC-from-module pattern in `erc20/balances`, so this is idiomatic here.
//!
//! Hardcoding `USDC = 6` was rejected: G6 requires the tooling to work against any
//! fleet, and a second, non-USDC asset appeared within a single 5.5-hour window of
//! live Base data (NOTES.md 7.4).

use std::collections::{HashMap, HashSet};

use substreams::scalar::BigInt;
use substreams_abis::standard::erc20;
use substreams_ethereum::rpc::RpcBatch;

/// Look up `decimals()` for each distinct asset, batching the calls.
///
/// Assets that fail to answer are simply absent from the map; callers must treat
/// a missing entry as "unknown" rather than defaulting to 18, which would inflate
/// or deflate every amount for that asset by orders of magnitude.
pub fn batch_decimals(assets: &HashSet<Vec<u8>>, chunk_size: usize) -> HashMap<Vec<u8>, u32> {
    let mut out: HashMap<Vec<u8>, u32> = HashMap::with_capacity(assets.len());
    if assets.is_empty() {
        return out;
    }
    let list: Vec<&Vec<u8>> = assets.iter().collect();

    for chunk in list.chunks(chunk_size.max(1)) {
        let batch = chunk.iter().fold(RpcBatch::new(), |batch, asset| {
            batch.add(erc20::functions::Decimals {}, asset.to_vec())
        });
        let responses = match batch.execute() {
            Ok(r) => r.responses,
            Err(e) => {
                substreams::log::info!("decimals batch failed: {:?}", e);
                continue;
            }
        };
        for (i, asset) in chunk.iter().enumerate() {
            match RpcBatch::decode::<BigInt, erc20::functions::Decimals>(&responses[i]) {
                Some(d) => {
                    out.insert((*asset).clone(), d.to_u64() as u32);
                }
                None => substreams::log::info!(
                    "decimals() undecodable for asset 0x{}",
                    substreams::Hex::encode(asset)
                ),
            }
        }
    }
    out
}

/// Scale a uint256 amount string by `decimals`, as a decimal string.
///
/// Done with string arithmetic rather than floats: these are money values and an
/// f64 silently loses precision above 2^53, which a uint256 routinely exceeds.
pub fn scale(amount_raw: &str, decimals: u32) -> String {
    let digits: String = amount_raw.chars().filter(|c| c.is_ascii_digit()).collect();
    let digits = if digits.is_empty() { "0".to_string() } else { digits };
    let d = decimals as usize;
    if d == 0 {
        return digits;
    }
    let padded = if digits.len() <= d {
        format!("{}{}", "0".repeat(d - digits.len() + 1), digits)
    } else {
        digits
    };
    let split = padded.len() - d;
    let (int_part, frac_part) = padded.split_at(split);
    let frac_trimmed = frac_part.trim_end_matches('0');
    if frac_trimmed.is_empty() {
        int_part.to_string()
    } else {
        format!("{}.{}", int_part, frac_trimmed)
    }
}

#[cfg(test)]
mod tests {
    use super::scale;

    #[test]
    fn scales_usdc_six_decimals() {
        assert_eq!(scale("50000", 6), "0.05");
        assert_eq!(scale("2000", 6), "0.002");
        assert_eq!(scale("1000000", 6), "1");
    }

    #[test]
    fn handles_sub_unit_and_zero() {
        assert_eq!(scale("1", 6), "0.000001");
        assert_eq!(scale("0", 6), "0");
        assert_eq!(scale("", 6), "0");
    }

    #[test]
    fn survives_uint256_beyond_f64_precision() {
        // 2^53 + 1 would be lost to a float round-trip.
        assert_eq!(scale("9007199254740993", 0), "9007199254740993");
        assert_eq!(scale("123456789012345678901234567890", 18), "123456789012.34567890123456789");
    }

    #[test]
    fn zero_decimals_is_identity() {
        assert_eq!(scale("12345", 0), "12345");
    }
}
