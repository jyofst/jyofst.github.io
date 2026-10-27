#!/usr/bin/env node
// Backtests the pullback rule over the collected daily bars: buy at the next
// day's open after a signal, then exit at the close on a stop-loss,
// take-profit or max hold. Compares against entering on every day with the
// same exits, so the gap between the two shows what the rule adds.
//
// Usage: node backtest.mjs [--data ./data] [--out ./results]

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBars, evaluate } from './scan.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = {
    data: join(HERE, 'data'), out: join(HERE, 'results'),
    rules: join(HERE, 'rules.json'), config: join(HERE, 'backtest.json'),
  };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    if (!(key in args)) throw new Error(`unknown option --${key}`);
    args[key] = argv[i + 1];
  }
  return args;
}

// Holds from the open of bar `entry` and returns the trade, or null if the
// data ends before an exit.
export function runTrade(bars, entry, cfg) {
  const entryPx = bars[entry].open;
  for (let j = entry; j < bars.length; j++) {
    const ret = (bars[j].close / entryPx - 1) * 100;
    const held = j - entry + 1;
    let reason = null;
    if (ret <= -cfg.stopLossPct) reason = 'STOP_LOSS';
    else if (ret >= cfg.takeProfitPct) reason = 'TAKE_PROFIT';
    else if (held >= cfg.maxHoldDays) reason = 'TIME';
    if (reason) {
      const net = ((bars[j].close * (1 - cfg.sellCostPct / 100)) / (entryPx * (1 + cfg.buyCostPct / 100)) - 1) * 100;
      return { entryDate: bars[entry].date, exitDate: bars[j].date, exitIndex: j, reason, heldDays: held, grossPct: ret, netPct: net };
    }
  }
  return null;
}

export function backtestSymbol(bars, rules, cfg, currency) {
  const signal = [];
  const baseline = [];
  let busyUntil = -1;
  for (let i = rules.minBars - 1; i < bars.length - 1; i++) {
    const t = runTrade(bars, i + 1, cfg);
    if (!t) continue;
    baseline.push(t);
    if (i <= busyUntil) continue;
    if (evaluate(bars, i, rules, currency)?.pass) {
      signal.push({ signalDate: bars[i].date, ...t });
      busyUntil = t.exitIndex;
    }
  }
  return { signal, baseline };
}

export function stats(trades) {
  const nets = trades.map((t) => t.netPct).sort((a, b) => a - b);
  const r = (x) => (x == null ? null : Number(x.toFixed(2)));
  return {
    trades: nets.length,
    winRatePct: nets.length ? r((nets.filter((x) => x > 0).length / nets.length) * 100) : null,
    avgNetPct: nets.length ? r(nets.reduce((s, x) => s + x, 0) / nets.length) : null,
    medianNetPct: nets.length ? r(nets[Math.floor(nets.length / 2)]) : null,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const rules = JSON.parse(readFileSync(args.rules, 'utf8'));
  const cfg = JSON.parse(readFileSync(args.config, 'utf8'));
  const { symbols } = JSON.parse(readFileSync(join(args.data, 'universe.json'), 'utf8'));
  const signal = [];
  const baseline = [];
  for (const s of symbols) {
    const bars = loadBars(join(args.data, 'bars', `${s.symbol}.csv`));
    const res = backtestSymbol(bars, rules, cfg, s.currency);
    signal.push(...res.signal.map((t) => ({ symbol: s.symbol, name: s.name, ...t })));
    baseline.push(...res.baseline);
  }
  const summary = { cfg, signal: stats(signal), baseline: stats(baseline) };
  mkdirSync(args.out, { recursive: true });
  writeFileSync(join(args.out, 'backtest.json'), JSON.stringify(summary, null, 2) + '\n');
  const cols = ['symbol', 'name', 'signalDate', 'entryDate', 'exitDate', 'reason', 'heldDays', 'grossPct', 'netPct'];
  const fmt = (v) => (typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(2) : v);
  writeFileSync(join(args.out, 'backtest-trades.csv'), [cols.join(','), ...signal.map((t) => cols.map((c) => fmt(t[c])).join(','))].join('\n') + '\n');
  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
