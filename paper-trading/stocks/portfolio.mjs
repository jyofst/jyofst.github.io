#!/usr/bin/env node
// Portfolio simulation (the "risk" step): replays the past year day by day
// with one account. Signals found at a close are bought at the next open,
// each with positionPct of equity, at most maxPositions at a time (the most
// liquid signals first when there are more). Exits use the backtest's
// stop-loss / take-profit / max-hold rules. Reports return and max drawdown
// against an equal-weight buy-and-hold of the same universe. KRW stocks only.
//
// Usage: node portfolio.mjs [--data ./data] [--out ./results]

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBars, evaluate, segments } from './scan.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = {
    data: join(HERE, 'data'), out: join(HERE, 'results'),
    rules: join(HERE, 'rules.json'), config: join(HERE, 'backtest.json'),
    portfolio: join(HERE, 'portfolio.json'), experiments: join(HERE, 'experiments.json'),
  };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    if (!(key in args)) throw new Error(`unknown option --${key}`);
    args[key] = argv[i + 1];
  }
  return args;
}

const round = (x, d = 2) => Number(x.toFixed(d));

// Maps each symbol's dates to its segment and index, so a split (segment
// change) can close a position and averages never span one.
function index(series) {
  return series.map((s) => {
    const at = new Map();
    s.segs.forEach((bars, seg) => bars.forEach((b, i) => at.set(b.date, { seg, i })));
    const recent = s.segs.at(-1).slice(-20);
    const liquidity = recent.reduce((sum, b) => sum + b.close * b.volume, 0);
    return { ...s, at, liquidity };
  });
}

function maxDrawdownPct(values) {
  let peak = -Infinity;
  let worst = 0;
  for (const v of values) {
    peak = Math.max(peak, v);
    worst = Math.min(worst, (v / peak - 1) * 100);
  }
  return round(worst);
}

export function simulatePortfolio(series, rules, cfg, pf) {
  const syms = index(series);
  const dates = [...new Set(syms.flatMap((s) => [...s.at.keys()]))].sort();
  let cash = pf.startingCashKrw;
  let equity = cash;
  const positions = new Map();
  const trades = [];
  const curve = [];
  let pending = [];
  let skipped = 0;
  let investedSum = 0;

  const close = (s, pos, price, date, reason) => {
    const proceeds = pos.shares * price * (1 - cfg.sellCostPct / 100);
    cash += proceeds;
    trades.push({ symbol: s.symbol, entryDate: pos.entryDate, exitDate: date, reason, netPct: (proceeds / pos.cost - 1) * 100 });
    positions.delete(s.symbol);
  };

  for (const date of dates) {
    // Open: fill yesterday's signals, most liquid first, while slots remain.
    for (const sig of pending.sort((a, b) => b.s.liquidity - a.s.liquidity)) {
      const loc = sig.s.at.get(date);
      if (!loc || loc.seg !== sig.seg || loc.i !== sig.i + 1 || positions.has(sig.s.symbol)) continue;
      if (positions.size >= pf.maxPositions) {
        skipped++;
        continue;
      }
      const size = Math.min(cash, equity * (pf.positionPct / 100));
      if (size <= 0) continue;
      const open = sig.s.segs[loc.seg][loc.i].open;
      cash -= size;
      positions.set(sig.s.symbol, {
        seg: loc.seg, entryIdx: loc.i, entryDate: date, entryPx: open,
        shares: size / (open * (1 + cfg.buyCostPct / 100)), cost: size, last: open,
      });
    }
    pending = [];

    // Close: exits, then today's signals for tomorrow's open.
    for (const s of syms) {
      const loc = s.at.get(date);
      if (!loc) continue;
      const pos = positions.get(s.symbol);
      if (pos && loc.seg !== pos.seg) {
        close(s, pos, pos.last, date, 'PRICE_BREAK');
      } else if (pos) {
        const bar = s.segs[loc.seg][loc.i];
        pos.last = bar.close;
        const ret = (bar.close / pos.entryPx - 1) * 100;
        const held = loc.i - pos.entryIdx + 1;
        if (ret <= -cfg.stopLossPct) close(s, pos, bar.close, date, 'STOP_LOSS');
        else if (ret >= cfg.takeProfitPct) close(s, pos, bar.close, date, 'TAKE_PROFIT');
        else if (held >= cfg.maxHoldDays) close(s, pos, bar.close, date, 'TIME');
      }
      if (!positions.has(s.symbol) && evaluate(s.segs[loc.seg], loc.i, rules, 'KRW')?.pass) {
        pending.push({ s, seg: loc.seg, i: loc.i });
      }
    }

    const held = [...positions.values()].reduce((sum, p) => sum + p.shares * p.last, 0);
    equity = cash + held;
    investedSum += held / equity;
    curve.push({ date, equity });
  }

  const done = trades.map((t) => t.netPct);
  return {
    curve,
    trades,
    stats: {
      endingEquity: Math.round(equity),
      returnPct: round((equity / pf.startingCashKrw - 1) * 100),
      maxDrawdownPct: maxDrawdownPct(curve.map((c) => c.equity)),
      trades: done.length,
      winRatePct: done.length ? round((done.filter((x) => x > 0).length / done.length) * 100, 1) : null,
      avgNetPct: done.length ? round(done.reduce((a, b) => a + b, 0) / done.length) : null,
      avgInvestedPct: round((investedSum / dates.length) * 100, 1),
      skippedFull: skipped,
      openAtEnd: positions.size,
    },
  };
}

// Equal weight at the first date, no rebalancing; daily returns are chained
// within segments so a split never counts as a loss.
export function benchmark(series, startDate) {
  const syms = index(series);
  const dates = [...new Set(syms.flatMap((s) => [...s.at.keys()]))].sort().filter((d) => d >= startDate);
  const growth = syms.map(() => 1);
  const prev = syms.map(() => null);
  const curve = [];
  for (const date of dates) {
    syms.forEach((s, k) => {
      const loc = s.at.get(date);
      if (!loc) return;
      const bar = s.segs[loc.seg][loc.i];
      if (prev[k] && prev[k].seg === loc.seg) growth[k] *= bar.close / prev[k].close;
      prev[k] = { seg: loc.seg, close: bar.close };
    });
    curve.push(growth.reduce((a, b) => a + b, 0) / growth.length);
  }
  return {
    returnPct: round((curve.at(-1) - 1) * 100),
    maxDrawdownPct: maxDrawdownPct(curve),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const rules = JSON.parse(readFileSync(args.rules, 'utf8'));
  const cfg = JSON.parse(readFileSync(args.config, 'utf8'));
  const pf = JSON.parse(readFileSync(args.portfolio, 'utf8'));
  const { variants } = JSON.parse(readFileSync(args.experiments, 'utf8'));
  const { symbols } = JSON.parse(readFileSync(join(args.data, 'universe.json'), 'utf8'));
  const series = symbols
    .filter((s) => s.currency === 'KRW')
    .map((s) => ({ symbol: s.symbol, name: s.name, segs: segments(loadBars(join(args.data, 'bars', `${s.symbol}.csv`)), 'KRW') }))
    .filter((s) => s.segs[0].length);

  const results = pf.variants.map((name) => {
    const v = variants.find((x) => x.name === name);
    if (!v) throw new Error(`unknown experiment "${name}" in portfolio.json`);
    return { name, ...simulatePortfolio(series, { ...rules, ...v.overrides }, cfg, pf) };
  });
  const startDate = results[0].curve[rules.minBars - 1]?.date ?? results[0].curve[0].date;
  const summary = {
    config: pf,
    startDate,
    endDate: results[0].curve.at(-1).date,
    symbols: series.length,
    variants: results.map((r) => ({ name: r.name, stats: r.stats })),
    benchmark: benchmark(series, startDate),
  };
  mkdirSync(args.out, { recursive: true });
  writeFileSync(join(args.out, 'portfolio-result.json'), JSON.stringify(summary, null, 2) + '\n');
  const header = ['date', ...results.map((r) => r.name)].join(',');
  const rows = results[0].curve.map((c, i) => [c.date, ...results.map((r) => Math.round(r.curve[i].equity))].join(','));
  writeFileSync(join(args.out, 'portfolio-equity.csv'), [header, ...rows].join('\n') + '\n');
  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
