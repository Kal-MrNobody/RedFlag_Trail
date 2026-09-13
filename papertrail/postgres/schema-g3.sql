-- G3 additions. ADDITIVE ONLY - the G1 `payments` and `vendors` tables are
-- frozen and are not altered here.

-- Cached registry lookups, one row per vendor. Cached because the registry is
-- slow-moving and we would otherwise re-query the same vendor on every run.
CREATE TABLE IF NOT EXISTS vendor_registry (
    address                 TEXT NOT NULL PRIMARY KEY,
    checked_at              TIMESTAMP NOT NULL,
    registered              BOOLEAN   NOT NULL,
    agent_id                TEXT,
    name                    TEXT,
    ens                     TEXT,
    x402_support            BOOLEAN,
    active                  BOOLEAN,
    total_feedback          BIGINT,
    avg_feedback            NUMERIC,
    validations_completed   INTEGER,
    registry_created_at     BIGINT
);

-- Risk findings. Every finding MUST carry a proposed_rule that is valid Privy
-- policy JSON, so a human can approve it straight into enforcement without a
-- translation step - that is the whole point of the loop.
CREATE TABLE IF NOT EXISTS findings (
    id              TEXT NOT NULL PRIMARY KEY,   -- rule:subject, stable across reruns
    rule            TEXT NOT NULL,               -- R1 | R2 | R4
    severity        TEXT NOT NULL,               -- low | medium | high
    subject         TEXT NOT NULL,               -- the vendor or facilitator address
    subject_kind    TEXT NOT NULL,               -- vendor | facilitator
    summary         TEXT NOT NULL,
    detail          TEXT,
    evidence_tx     TEXT[] NOT NULL,             -- tx hashes a judge can verify
    payment_count   INTEGER NOT NULL,
    exposure_usd    NUMERIC,
    proposed_rule   JSONB NOT NULL,              -- Privy policy rule, ready to POST
    created_at      TIMESTAMP NOT NULL,
    status          TEXT NOT NULL DEFAULT 'open' -- open | approved | enforced | dismissed
);

CREATE INDEX IF NOT EXISTS idx_findings_rule    ON findings (rule);
CREATE INDEX IF NOT EXISTS idx_findings_subject ON findings (subject);
CREATE INDEX IF NOT EXISTS idx_findings_status  ON findings (status);

-- Backtest results, one row per (finding, run). G4 writes here.
CREATE TABLE IF NOT EXISTS backtests (
    id                  TEXT NOT NULL PRIMARY KEY,
    finding_id          TEXT NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
    ran_at              TIMESTAMP NOT NULL,
    would_block_count   INTEGER NOT NULL,
    would_block_usd     NUMERIC,
    would_block_tx      TEXT[] NOT NULL,
    false_positive_count INTEGER NOT NULL,
    false_positive_vendors TEXT[] NOT NULL,
    window_from_block   BIGINT,
    window_to_block     BIGINT,
    -- Binds this backtest to the exact rule it replayed. proposed_rule is
    -- upserted in place, so without this a rule could be approved on a backtest
    -- of an earlier, different rule.
    rule_fingerprint    TEXT
);

CREATE INDEX IF NOT EXISTS idx_backtests_finding ON backtests (finding_id);
