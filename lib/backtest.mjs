// G4 - replay a proposed rule over indexed history.
//
// This is the differentiator: before a human approves a DENY, they see exactly
// what it WOULD have blocked and what it would have blocked BY MISTAKE. A rule
// that blocks nothing is noise; a rule that blocks legitimate vendors is worse
// than the risk it addresses.

/**
 * Interpret a proposed Privy rule as a predicate over ledger rows.
 *
 * Deliberately reads the SAME JSON that gets POSTed to Privy rather than taking
 * a separate "what this rule means" argument. If the two could disagree, the
 * backtest would be testing something other than what gets enforced.
 */
export function ruleToPredicate(proposedRule) {
  if (proposedRule?._advisory) {
    return { kind: 'advisory', sql: null, params: [] };
  }
  const conds = proposedRule?.conditions ?? [];
  const toCond = conds.find(
    (c) => c.field_source === 'ethereum_typed_data_message' && c.field === 'to',
  );
  if (!toCond) return { kind: 'unsupported', sql: null, params: [] };

  const values = Array.isArray(toCond.value) ? toCond.value : [toCond.value];
  const lowered = values.map((v) => String(v).toLowerCase());

  switch (toCond.operator) {
    case 'eq':
      return { kind: 'recipient', sql: 'lower(recipient) = $1', params: [lowered[0]] };
    case 'in':
      return { kind: 'recipient', sql: 'lower(recipient) = any($1)', params: [lowered] };
    default:
      return { kind: 'unsupported', sql: null, params: [] };
  }
}

/**
 * Replay the rule over history.
 *
 * would_block      - our fleet's payments the rule would have stopped.
 * false_positives  - vendors the rule would block that look LEGITIMATE, judged
 *                    by how many independent payers outside our fleet also pay
 *                    them. A vendor the whole network uses is probably not a
 *                    scam, so blocking it is probably a mistake.
 * blast_radius     - context, not a verdict: total third-party activity with
 *                    the same vendors. Reported separately so it is never
 *                    mistaken for payments our rule could actually stop - the
 *                    rule lives on OUR wallets and cannot touch anyone else's.
 */
export async function backtest(db, proposedRule, ourPayers = [], opts = {}) {
  const legitThreshold = opts.legitThreshold ?? Number(process.env.G4_LEGIT_PAYERS ?? 5);
  const pred = ruleToPredicate(proposedRule);
  if (pred.kind !== 'recipient') {
    return {
      supported: false,
      reason: pred.kind === 'advisory'
        ? 'Advisory finding: the facilitator is not part of the signed message, so no '
        + 'signing-time rule can be replayed.'
        : 'Rule shape not replayable: no equality condition on the in-message `to` field.',
      would_block: { count: 0, usd: null, tx: [] },
      false_positives: { count: 0, vendors: [] },
    };
  }

  const ours = ourPayers.map((a) => a.toLowerCase());

  // A rule attaches to OUR agents' wallets. With no wallets in scope it can
  // block nothing - but returning `would_block: 0` for that reason reads as
  // "this rule is harmless", which is the opposite of the truth and exactly the
  // misreading this tool exists to prevent. Refuse instead.
  if (ours.length === 0) {
    return {
      supported: false,
      reason: 'No payer scope. A rule attaches to specific agent wallets, so with an '
            + 'empty fleet would_block is vacuously 0 - which would read as "harmless" '
            + 'rather than "not measured". Pass the wallets this rule would attach to.',
      would_block: { count: null, usd: null, tx: [] },
      false_positives: { count: null, vendors: [] },
    };
  }

  // What the rule would actually have stopped: OUR payments only.
  const { rows: blocked } = await db.query(`
    select count(*)::int                                     as count,
           coalesce(sum(amount_usd), 0)                       as usd,
           (array_agg(tx_hash order by block_num desc))[1:20] as tx,
           min(block_num) as from_block, max(block_num) as to_block
    from payments
    where ${pred.sql} and lower(payer) = any($2)
  `, [...pred.params, ours]);

  // Which targeted vendors look legitimate, by independent-payer count.
  const { rows: vendorStats } = await db.query(`
    select lower(recipient) as vendor,
           count(distinct lower(payer)) filter (
             where not (lower(payer) = any($2))
           )::int as independent_payers,
           count(*) filter (
             where not (lower(payer) = any($2))
           )::int as third_party_payments
    from payments
    where ${pred.sql}
    group by lower(recipient)
  `, [...pred.params, ours]);

  const likelyLegit = vendorStats.filter((v) => v.independent_payers >= legitThreshold);

  return {
    supported: true,
    would_block: {
      count: blocked[0].count,
      usd: blocked[0].usd,
      tx: blocked[0].tx ?? [],
    },
    false_positives: {
      count: likelyLegit.length,
      vendors: likelyLegit.map((v) => v.vendor),
      basis: `vendor has >= ${legitThreshold} independent payers outside our fleet`,
      detail: likelyLegit.map((v) => ({
        vendor: v.vendor,
        independent_payers: v.independent_payers,
        third_party_payments: v.third_party_payments,
      })),
    },
    blast_radius: {
      third_party_payments: vendorStats.reduce((s, v) => s + v.third_party_payments, 0),
      // Deliberately NOT a sum of per-vendor distinct payers: the same payer can
      // pay several targeted vendors, so summing would double-count. Per-vendor
      // counts are reported instead of a wrong total.
      independent_payers_by_vendor: vendorStats.map(
        (v) => ({ vendor: v.vendor, independent_payers: v.independent_payers })),
      note: 'Context only. The rule attaches to our wallets and cannot block these.',
    },
    window: { from_block: blocked[0].from_block, to_block: blocked[0].to_block },
  };
}
