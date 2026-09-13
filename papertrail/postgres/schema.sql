-- RedFlag_Trail :: papertrail ledger schema
--
-- FROZEN AT G1. Later gates read these columns; changing them is a migration,
-- not an edit.
--
-- Design notes that are load-bearing, not decoration:
--
--  * payment_id is tx_hash:log_block_index. log_block_index is the RECEIPT log
--    index, which a reader can verify on a block explorer. The Firehose
--    `ordinal` is also unique but is an execution counter and cannot be checked
--    against anything, so it is deliberately not the key. (NOTES.md 7.7, 9.6)
--
--  * payer and facilitator are BOTH stored, as is tx_from. On live Base data
--    payer differs from tx.from on 99.6% of payments, so keeping all three is
--    what makes the attribution auditable rather than merely asserted.
--
--  * amount_decimal vs amount_usd are NOT the same thing. Decimals give a
--    decimal-scaled amount; that is only a USD value when the asset is a USD
--    stablecoin. amount_usd is NULL for anything else so that SUM(amount_usd)
--    stays truthful and unpriced assets are visibly unpriced. (NOTES.md 9.5)
--
--  * confidence is carried through from upstream, where every observed row is
--    "heuristic". We reconstruct payments; we do not prove settlement.

CREATE TABLE IF NOT EXISTS payments (
    payment_id          TEXT NOT NULL PRIMARY KEY,  -- tx_hash:log_block_index

    block_num           BIGINT      NOT NULL,
    timestamp           TIMESTAMP   NOT NULL,
    tx_hash             TEXT        NOT NULL,
    log_block_index     INTEGER     NOT NULL,

    asset               TEXT        NOT NULL,
    payer               TEXT        NOT NULL,  -- the REAL spender
    recipient           TEXT        NOT NULL,  -- the vendor
    facilitator         TEXT        NOT NULL,  -- the relayer
    tx_from             TEXT        NOT NULL,  -- kept: equals facilitator in practice

    amount_raw          NUMERIC     NOT NULL,  -- uint256 as emitted
    decimals            INTEGER     NOT NULL,
    amount_decimal      NUMERIC,               -- amount_raw / 10^decimals
    amount_usd          NUMERIC,               -- ONLY for USD stablecoins

    transfer_method     TEXT        NOT NULL,
    settlement_source   TEXT        NOT NULL,
    scheme              TEXT        NOT NULL,
    confidence          TEXT        NOT NULL,

    payer_is_tx_from    BOOLEAN     NOT NULL,
    facilitator_known   BOOLEAN     NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_payments_payer       ON payments (payer);
CREATE INDEX IF NOT EXISTS idx_payments_recipient   ON payments (recipient);
CREATE INDEX IF NOT EXISTS idx_payments_facilitator ON payments (facilitator);
CREATE INDEX IF NOT EXISTS idx_payments_timestamp   ON payments (timestamp);
CREATE INDEX IF NOT EXISTS idx_payments_asset       ON payments (asset);

-- Vendor first-seen. Written from the store deltas, so a row appears exactly
-- once, at the block the vendor was first paid. R2 (fresh vendor where we are
-- >50% of its lifetime receipts) reads this.
CREATE TABLE IF NOT EXISTS vendors (
    address                 TEXT NOT NULL PRIMARY KEY,
    first_seen_block        BIGINT    NOT NULL,
    first_seen_timestamp    TIMESTAMP NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_vendors_first_seen ON vendors (first_seen_timestamp);
