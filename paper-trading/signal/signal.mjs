#!/usr/bin/env node
// Signal bot: reads the scout's CSV snapshots and checks entry conditions
// from rules.json. Paper-trading only — it writes signals, never orders.
//
// Usage: node signal.mjs [--data ../scout/data] [--out ./signals] [--rules ./rules.json]
//                        [--watch 0]   (seconds between re-runs; 0 = run once)

import { readFileSync, readdirSync, mkdirSync, appendFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = {
    data: join(HERE, '..', 'scout', 'data'),
    out: join(HERE, 'signals'),
    rules: join(HERE, 'rules.json'),
    watch: 0,
  };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    if (!(key in args)) throw new Error(`unknown option --${key}`);
    args[key] = typeof args[key] === 'number' ? Number(argv[i + 1]) : argv[i + 1];
  }
  return args;
}

const num = (v) => (v === '' || v == null ? null : Number(v));

export function loadSnapshots(dataDir) {
  if (!existsSync(dataDir)) return [];
  const rows = [];
  for (const file of readdirSync(dataDir).filter((f) => f.endsWith('.csv')).sort()) {
    const [header, ...lines] = readFileSync(join(dataDir, file), 'utf8').trim().split('\n');
    const cols = header.split(',');
    for (const line of lines) {
      const cells = line.split(',');
      rows.push(Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? ''])));
    }
  }
  return rows.sort((a, b) => a.ts.localeCompare(b.ts));
}

// Checks one snapshot against the rules, given the snapshots before it for
// the same symbol. Returns null while there is not enough history yet.
export function evaluate(row, history, rules) {
  if (history.length < rules.lookbackTicks) return null;
  const window = history.slice(-rules.lookbackTicks);
  const price = num(row.priceUsd);
  const mean = window.reduce((s, r) => s + num(r.priceUsd), 0) / window.length;
  const buys = num(row.buys_m5) ?? 0;
  const sells = num(row.sells_m5) ?? 0;
  const txns = buys + sells;
  const chgM5 = num(row.chg_m5);
  const chgH1 = num(row.chg_h1);
  const abovePct = ((price - mean) / mean) * 100;
  const recentFlags = [...window, row].map((r) => r.flags).filter(Boolean);

  const checks = {
    liquidity: (num(row.liquidityUsd) ?? 0) >= rules.minLiquidityUsd,
    activity: txns >= rules.minTxnsM5,
    buyPressure: txns > 0 && buys / txns >= rules.minBuyRatioM5,
    momentumM5: chgM5 != null && chgM5 > rules.minChgM5,
    momentumH1: chgH1 != null && chgH1 > rules.minChgH1,
    aboveMean: price >= mean,
    notChasing: abovePct <= rules.maxAboveMeanPct,
    noRecentFlags: recentFlags.length === 0,
  };
  return {
    ts: row.ts,
    symbol: row.symbol,
    pair: row.pair,
    priceUsd: price,
    meanPrice: Number(mean.toPrecision(6)),
    abovePct: Number(abovePct.toFixed(2)),
    buyRatio: txns > 0 ? Number((buys / txns).toFixed(2)) : null,
    checks,
    failed: Object.keys(checks).filter((k) => !checks[k]),
    pass: Object.values(checks).every(Boolean),
  };
}

function runOnce(args, rules) {
  mkdirSync(args.out, { recursive: true });
  const stateFile = join(args.out, '.state.json');
  const state = existsSync(stateFile)
    ? JSON.parse(readFileSync(stateFile, 'utf8'))
    : { lastTs: '', lastSignal: {} };

  const history = new Map();
  const latest = new Map();
  let emitted = 0;

  for (const row of loadSnapshots(args.data)) {
    const past = history.get(row.symbol) ?? [];
    const result = evaluate(row, past, rules);
    past.push(row);
    history.set(row.symbol, past);
    if (!result) continue;
    latest.set(row.symbol, result);
    if (row.ts <= state.lastTs || !result.pass) continue;

    const prev = state.lastSignal[row.symbol];
    if (prev && Date.parse(row.ts) - Date.parse(prev) < rules.cooldownMin * 60_000) continue;

    const signal = { type: 'ENTRY_CANDIDATE', ...result };
    appendFileSync(join(args.out, `${row.ts.slice(0, 10)}.jsonl`), JSON.stringify(signal) + '\n');
    state.lastSignal[row.symbol] = row.ts;
    emitted++;
    console.log(`[signal] ${row.ts} ${row.symbol} $${result.priceUsd} (mean ${result.meanPrice}, +${result.abovePct}%)`);
  }

  for (const [symbol, h] of history) {
    const r = latest.get(symbol);
    if (!r) console.log(`[status] ${symbol}: warming up (${h.length}/${rules.lookbackTicks + 1} ticks)`);
    else console.log(`[status] ${symbol}: ${r.pass ? 'all checks pass' : `failed ${r.failed.join(', ')}`}`);
  }
  const allTs = [...history.values()].flat().map((r) => r.ts);
  if (allTs.length) state.lastTs = allTs.sort().at(-1);
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
  console.log(`[done] ${emitted} new signal(s)`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rules = JSON.parse(readFileSync(args.rules, 'utf8'));
  do {
    runOnce(args, rules);
    if (args.watch > 0) await new Promise((r) => setTimeout(r, args.watch * 1000));
  } while (args.watch > 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
