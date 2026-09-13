#!/usr/bin/env node
/**
 * RedFlag_Trail API + review console.
 *
 * Deliberately dependency-free (node:http): the console is a single page and
 * the API is a handful of routes, so a framework would add supply chain for no
 * benefit.
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { pool } from '../lib/db.mjs';
import { backtest } from '../lib/backtest.mjs';
import { ruleFingerprint } from '../lib/rules.mjs';

const PORT = Number(process.env.PORT ?? 8787);
const db = pool();

const fleetPath = new URL('../fleet.json', import.meta.url);
const fleet = existsSync(fleetPath) ? JSON.parse(readFileSync(fleetPath, 'utf8')) : null;
const OURS = (fleet?.agents ?? []).map((a) => a.address);

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body, null, 2));
};

async function spendSummary(params) {
  const since = params.get('since_days') ?? '3650';
  const { rows } = await db.query(`
    select
      count(*)::int                                          as payments,
      coalesce(sum(amount_usd), 0)                           as total_usd,
      count(distinct payer)::int                             as payers,
      count(distinct recipient)::int                         as vendors,
      count(distinct facilitator)::int                       as facilitators,
      count(*) filter (where payer <> tx_from)::int          as payer_ne_txfrom,
      min(block_num)                                         as from_block,
      max(block_num)                                         as to_block
    from payments
    where timestamp > now() - ($1 || ' days')::interval
  `, [since]);
  const { rows: top } = await db.query(`
    select recipient, count(*)::int as payments, coalesce(sum(amount_usd),0) as usd,
           (array_agg(tx_hash order by block_num desc))[1:3] as sample_tx
    from payments
    where timestamp > now() - ($1 || ' days')::interval
    group by recipient order by sum(amount_usd) desc nulls last limit 10
  `, [since]);
  return { ...rows[0], top_vendors: top };
}

const routes = {
  'GET /v1/health': async () => ({ ok: true, fleet_agents: OURS.length }),

  'GET /v1/spend': async (_m, _b, params) => spendSummary(params),

  'GET /v1/findings': async () => {
    const { rows } = await db.query(`
      select f.*, b.would_block_count, b.would_block_usd,
             b.false_positive_count, b.ran_at as backtested_at
      from findings f
      left join lateral (
        select * from backtests b2 where b2.finding_id = f.id order by ran_at desc limit 1
      ) b on true
      order by case f.severity when 'high' then 0 when 'medium' then 1 else 2 end,
               f.exposure_usd desc nulls last
    `);
    return { findings: rows };
  },

  'GET /v1/vendors': async (_m, _b, params) => {
    const addr = params.get('address');
    if (!addr) return { error: 'address query param required' };
    const { rows: reg } = await db.query('select * from vendor_registry where address = $1', [addr.toLowerCase()]);
    const { rows: pay } = await db.query(`
      select count(*)::int payments, coalesce(sum(amount_usd),0) usd,
             min(block_num) first_block, max(block_num) last_block,
             (array_agg(tx_hash order by block_num desc))[1:5] as sample_tx
      from payments where lower(recipient) = $1
    `, [addr.toLowerCase()]);
    return { address: addr, registry: reg[0] ?? { registered: null, note: 'not enriched yet' }, activity: pay[0] };
  },
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const key = `${req.method} ${url.pathname}`;

    // Quiet the browser's automatic favicon probe rather than logging a 404.
    if (req.method === 'GET' && url.pathname === '/favicon.ico') {
      res.writeHead(204); return res.end();
    }

    // OpenAPI spec - the Bazantic gateway needs a --spec-url, and an agent
    // reading the API benefits from the same description either way.
    if (req.method === 'GET' && url.pathname === '/openapi.json') {
      const spec = readFileSync(new URL('./openapi.json', import.meta.url));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(spec);
    }

    // Console
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = readFileSync(new URL('./console.html', import.meta.url));
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(html);
    }

    // POST /v1/findings/{id}/backtest  - the G4 endpoint
    const bt = url.pathname.match(/^\/v1\/findings\/(.+)\/backtest$/);
    if (req.method === 'POST' && bt) {
      const id = decodeURIComponent(bt[1]);
      const { rows } = await db.query('select * from findings where id = $1', [id]);
      if (!rows.length) return json(res, 404, { error: `no finding ${id}` });
      const finding = rows[0];
      const result = await backtest(db, finding.proposed_rule, OURS);
      if (result.supported) {
        await db.query(`
          insert into backtests (id, finding_id, ran_at, would_block_count, would_block_usd,
                                 would_block_tx, false_positive_count, false_positive_vendors,
                                 window_from_block, window_to_block, rule_fingerprint)
          values ($1,$2,now(),$3,$4,$5,$6,$7,$8,$9,$10)
          on conflict (id) do update set
            ran_at=now(), would_block_count=excluded.would_block_count,
            would_block_usd=excluded.would_block_usd, would_block_tx=excluded.would_block_tx,
            false_positive_count=excluded.false_positive_count,
            false_positive_vendors=excluded.false_positive_vendors,
            window_from_block=excluded.window_from_block,
            window_to_block=excluded.window_to_block,
            rule_fingerprint=excluded.rule_fingerprint
        `, [`bt:${id}`, id, result.would_block.count, result.would_block.usd,
            result.would_block.tx, result.false_positives.count,
            result.false_positives.vendors, result.window?.from_block ?? null,
            result.window?.to_block ?? null, ruleFingerprint(finding.proposed_rule)]);
      }
      return json(res, 200, { finding_id: id, rule: finding.rule, subject: finding.subject, ...result });
    }

    // POST /v1/findings/{id}/approve - the G5 handoff into Privy.
    const ap = url.pathname.match(/^\/v1\/findings\/(.+)\/approve$/);
    if (req.method === 'POST' && ap) {
      const id = decodeURIComponent(ap[1]);
      const { rows } = await db.query('select * from findings where id = $1', [id]);
      if (!rows.length) return json(res, 404, { error: `no finding ${id}` });
      const finding = rows[0];

      if (finding.proposed_rule?._advisory) {
        return json(res, 400, {
          error: 'Advisory finding cannot be enforced at signing time. '
               + 'The facilitator is not a field of the EIP-3009 message.',
        });
      }
      if (!fleet) {
        return json(res, 400, { error: 'No fleet.json - nothing to attach a policy rule to.' });
      }

      // Require a backtest first. Approving a rule nobody has replayed is exactly
      // the mistake this tool exists to prevent.
      const { rows: bt } = await db.query(
        'select * from backtests where finding_id = $1 order by ran_at desc limit 1', [id]);
      if (!bt.length) {
        return json(res, 409, {
          error: 'Backtest this finding before approving it.',
          hint: `POST /v1/findings/${encodeURIComponent(id)}/backtest`,
        });
      }
      // The backtest must have been run against THIS rule. g3-risk.mjs upserts
      // proposed_rule in place, so a finding's rule can change under a stale
      // backtest - approving on a replay of a different rule would defeat the
      // entire guard.
      if (bt[0].rule_fingerprint !== ruleFingerprint(finding.proposed_rule)) {
        return json(res, 409, {
          error: 'The rule changed since it was backtested. Re-run the backtest.',
          hint: `POST /v1/findings/${encodeURIComponent(id)}/backtest`,
        });
      }

      await db.query("update findings set status = 'approved' where id = $1", [id]);
      const { _reason, ...postable } = finding.proposed_rule;
      return json(res, 200, {
        finding_id: id,
        status: 'approved',
        message: 'Approved. Run scripts/g5-enforce.mjs to append this rule to the fleet policies.',
        rule_to_append: postable,
        target_policies: fleet.agents.map((a) => a.policy_id),
        backtest: {
          would_block: bt[0].would_block_count,
          would_block_usd: bt[0].would_block_usd,
          false_positives: bt[0].false_positive_count,
        },
        enforced: false,
      });
    }

    const handler = routes[key];
    if (!handler) return json(res, 404, { error: `no route ${key}` });

    let body = null;
    if (req.method === 'POST') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString();
      body = raw ? JSON.parse(raw) : null;
    }
    return json(res, 200, await handler(req.method, body, url.searchParams));
  } catch (e) {
    return json(res, 500, { error: String(e.message ?? e) });
  }
});

server.listen(PORT, () => console.log(`RedFlag_Trail API on http://localhost:${PORT}`));
