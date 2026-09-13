//! papertrail - a payer-attributed x402 spend ledger.
//!
//! Pinax already ships `evm-x402`, a flat 1:1 dump of x402 events. This module is
//! not that. It composes x402 WITH erc20-tokens and adds what neither provides:
//! a computed facilitator allowlist (the x402 package explicitly applies none),
//! token decimals sourced by eth_call, normalisation that refuses to call a
//! non-stablecoin amount "USD", and a vendor first-seen store.

mod decimals;
#[allow(clippy::all)]
mod pb;

use std::collections::HashSet;

use pb::evm::x402::v1 as x402;
use pb::redflag::papertrail::v1 as pt;
use substreams::errors::Error;
use substreams::pb::substreams::Clock;
use substreams::store::{
    DeltaString, Deltas, StoreAdd, StoreAddInt64, StoreNew, StoreSetIfNotExists,
    StoreSetIfNotExistsString,
};
use substreams::Hex;
use substreams_database_change::pb::database::DatabaseChanges;
use substreams_database_change::tables::Tables;

/// Assets whose smallest unit is pegged 1:1 to USD, so a decimal-scaled amount
/// IS a dollar amount. Anything not in here gets `amount_usd` left EMPTY rather
/// than being silently counted as dollars - decimals alone do not make a value
/// USD, that needs a price feed we do not have. See NOTES.md 9.5.
const USD_STABLECOINS: [&str; 4] = [
    "833589fcd6edb6e08f4c7c32d4f71b54bda02913", // USDC   (Base)
    "fde4c96c8593536e31f229ea8f37b2ada2699bb2", // USDT   (Base)
    "d9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca", // USDbC  (Base, bridged)
    "50c5725949a6f0c72e6c4a641f24049a917db0cb", // DAI    (Base)
];

fn hex20(bytes: &[u8]) -> String {
    format!("0x{}", Hex::encode(bytes))
}

fn is_usd_stablecoin(asset_hex_no_prefix: &str) -> bool {
    USD_STABLECOINS.contains(&asset_hex_no_prefix)
}

#[substreams::handlers::map]
fn map_payments(params: String, clock: Clock, events: x402::Events) -> Result<pt::Payments, Error> {
    let chunk_size: usize = params.trim().parse().unwrap_or(100);
    let seconds = clock.timestamp.as_ref().map(|t| t.seconds).unwrap_or_default();

    // Collect distinct assets first so decimals() is fetched once per asset per
    // block, not once per payment.
    let mut assets: HashSet<Vec<u8>> = HashSet::new();
    for trx in events.transactions.iter() {
        for log in trx.logs.iter() {
            if let Some(x402::log::Log::Payment(p)) = &log.log {
                assets.insert(p.asset.clone());
            }
        }
    }
    let decimals_map = decimals::batch_decimals(&assets, chunk_size);

    let mut payments = Vec::new();
    for trx in events.transactions.iter() {
        let tx_hash = hex20(&trx.hash);
        let tx_from = hex20(&trx.from);

        for log in trx.logs.iter() {
            let Some(x402::log::Log::Payment(p)) = &log.log else {
                continue;
            };

            let asset_raw = Hex::encode(&p.asset);
            let payer = hex20(&p.payer);
            let facilitator = hex20(&p.facilitator);

            // The whole point of this project: attribute by the decoded payer,
            // never by tx.from. Both are kept so the claim is auditable.
            let payer_is_tx_from = payer == tx_from;

            let (dec, amount_decimal, amount_usd) = match decimals_map.get(&p.asset) {
                Some(&d) => {
                    let scaled = decimals::scale(&p.amount, d);
                    let usd = if is_usd_stablecoin(&asset_raw) { scaled.clone() } else { String::new() };
                    (d, scaled, usd)
                }
                // Unknown decimals: emit the raw amount only. Defaulting to 18
                // would misstate the value by orders of magnitude.
                None => (0u32, String::new(), String::new()),
            };

            payments.push(pt::Payment {
                // block_index is the receipt log index - explorer-verifiable.
                payment_id: format!("{}:{}", tx_hash, log.block_index),
                block_num: clock.number,
                timestamp: seconds,
                tx_hash: tx_hash.clone(),
                log_block_index: log.block_index,

                asset: hex20(&p.asset),
                payer,
                recipient: hex20(&p.recipient),
                facilitator,
                tx_from: tx_from.clone(),

                amount_raw: p.amount.clone(),
                decimals: dec,
                amount_decimal,
                amount_usd,

                transfer_method: x402::TransferMethod::try_from(p.transfer_method)
                    .unwrap_or(x402::TransferMethod::Unspecified)
                    .as_str_name()
                    .to_string(),
                settlement_source: x402::SettlementSource::try_from(p.settlement_source)
                    .unwrap_or(x402::SettlementSource::Unspecified)
                    .as_str_name()
                    .to_string(),
                scheme: p.scheme.clone(),
                // Upstream reports "heuristic" for every row observed. Carried
                // through so we never imply settlement certainty we cannot prove.
                confidence: p.confidence.clone(),

                payer_is_tx_from,
                // Computed downstream from store_facilitator_count; the upstream
                // package always leaves its own flag false.
                facilitator_known: p.facilitator_allowlist_matched,
            });
        }
    }

    Ok(pt::Payments { payments })
}

/// First sighting of each vendor (recipient). set_if_not_exists means the
/// earliest block wins, which is what R2 needs to judge vendor freshness.
#[substreams::handlers::store]
fn store_vendor_first_seen(payments: pt::Payments, store: StoreSetIfNotExistsString) {
    for p in payments.payments.iter() {
        store.set_if_not_exists(
            0,
            format!("vendor:{}", p.recipient),
            &format!("{}:{}", p.block_num, p.timestamp),
        );
    }
}

/// Facilitator activity counts - the raw input to the computed allowlist that
/// the upstream x402 package deliberately does not provide.
#[substreams::handlers::store]
fn store_facilitator_count(payments: pt::Payments, store: StoreAddInt64) {
    for p in payments.payments.iter() {
        store.add(0, format!("facilitator:{}", p.facilitator), 1);
        store.add(0, format!("vendor_receipts:{}", p.recipient), 1);
        store.add(0, format!("payer_spend_count:{}", p.payer), 1);
    }
}

#[substreams::handlers::map]
fn db_out(
    clock: Clock,
    payments: pt::Payments,
    vendor_deltas: Deltas<DeltaString>,
) -> Result<DatabaseChanges, Error> {
    let mut tables = Tables::new();
    let seconds = clock.timestamp.as_ref().map(|t| t.seconds).unwrap_or_default();

    for p in payments.payments.iter() {
        let row = tables.create_row("payments", [("payment_id", p.payment_id.clone())]);
        row.set("block_num", p.block_num)
            .set("timestamp", seconds)
            .set("tx_hash", &p.tx_hash)
            .set("log_block_index", p.log_block_index)
            .set("asset", &p.asset)
            .set("payer", &p.payer)
            .set("recipient", &p.recipient)
            .set("facilitator", &p.facilitator)
            .set("tx_from", &p.tx_from)
            .set("amount_raw", &p.amount_raw)
            .set("decimals", p.decimals)
            .set("amount_decimal", &p.amount_decimal)
            .set("amount_usd", &p.amount_usd)
            .set("transfer_method", &p.transfer_method)
            .set("settlement_source", &p.settlement_source)
            .set("scheme", &p.scheme)
            .set("confidence", &p.confidence)
            .set("payer_is_tx_from", p.payer_is_tx_from)
            .set("facilitator_known", p.facilitator_known);
    }

    // Only newly-seen vendors produce a delta, so this stays small.
    for delta in vendor_deltas.deltas.iter() {
        let Some(recipient) = delta.key.strip_prefix("vendor:") else {
            continue;
        };
        let row = tables.create_row("vendors", [("address", recipient.to_string())]);
        row.set("first_seen_block", clock.number)
            .set("first_seen_timestamp", seconds);
    }

    Ok(tables.to_database_changes())
}
