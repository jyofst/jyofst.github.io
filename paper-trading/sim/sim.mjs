#!/usr/bin/env node
// Replay simulator: walks the scout's snapshots in time order, opens a paper
// position on the tick after each signal, and closes it on stop-loss,
// take-profit, max hold time, liquidity drop, or the end of unbroken data.
// Fees and slippage are charged on both sides. Paper-trading only.
//
// Usage: node sim.mjs [--data ../scout/data] [--out ./results]
//                     [--rules ../signal/rules.json] [--config ./sim.json]

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSnapshots, evaluate } from '../signal/signal.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = {
    data: join(HERE, '..', 'scout', 'data'),
    out: join(HERE, 'results'),
    rules: join(HERE, '..', 'signal', 'rules.json'),
    config: join(HERE, 'sim.json'),
  };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    if (!(key in args)) throw new Error(`unknown option --${key}`);
    args[key] = argv[i + 1];
  }
  return args;
}

const round = (x, d = 2) => Number(x.toFixed(d));

export function simulate(rows, rules, cfg) {
  let cash = cfg.startingCashUsd;
  const history = new Map();
  const open = new Map();
  const pending = new Map();
  const cooldownUntil = new Map();
  const trades = [];
  let signals = 0;
  let skippedFull = 0;

  const close = (pos, row, reason, complete = true) => {
    const market = Number(row.priceUsd);
    const proceeds = pos.qty * market * (1 - cfg.slippagePct / 100);
    const exitFee = proceeds * (cfg.feePct / 100);
    cash += proceeds - exitFee;
    const pnl = proceeds - exitFee - pos.notional - pos.entryFee;
    trades.push({
      symbol: pos.symbol,
      signalTs: pos.signalTs,
      entryTs: pos.entryTs,
      entryPx: pos.entryMarket,
      exitTs: row.ts,
      exitPx: market,
      reason,
      holdMin: round((Date.parse(row.ts) - Date.parse(pos.entryTs)) / 60000, 1),
      grossPct: round((market / pos.entryMarket - 1) * 100),
      netPct: round((pnl / pos.notional) * 100),
      pnlUsd: round(pnl),
      complete,
    });
    open.delete(pos.symbol);
  };

  for (const row of rows) {
    const sym = row.symbol;
    const past = history.get(sym) ?? [];
    const prev = past.at(-1);
    const gap = prev && Date.parse(row.ts) - Date.parse(prev.ts) > rules.maxGapSec * 1000;
    const price = Number(row.priceUsd);

    const pos = open.get(sym);
    if (pos && gap) {
      // Collection stopped mid-trade: book it at the last price we saw.
      close(pos, prev, 'DATA_GAP', false);
    } else if (pos) {
      const ret = (price / pos.entryMarket - 1) * 100;
      pos.below = ret <= -cfg.stopLossPct ? pos.below + 1 : 0;
      const heldMin = (Date.parse(row.ts) - Date.parse(pos.entryTs)) / 60000;
      if (row.flags.includes('LIQ_DROP')) close(pos, row, 'LIQ_DROP');
      else if (ret >= cfg.takeProfitPct) close(pos, row, 'TAKE_PROFIT');
      // A single-tick dip below the stop is often a thin-pool wick, so the
      // stop needs stopConfirmTicks consecutive ticks under it.
      else if (pos.below >= cfg.stopConfirmTicks) close(pos, row, 'STOP_LOSS');
      else if (heldMin >= cfg.maxHoldMin) close(pos, row, 'TIME');
    }

    const sig = pending.get(sym);
    if (sig) {
      pending.delete(sym);
      if (gap || open.has(sym)) {
        // The signal's next tick is missing or a position is already held.
      } else if (open.size >= cfg.maxOpenPositions) {
        skippedFull++;
      } else {
        const committed = [...open.values()].reduce((s, p) => s + p.notional, 0);
        const notional = Math.min(cash, (cash + committed) * (cfg.positionPct / 100));
        const fill = price * (1 + cfg.slippagePct / 100);
        const entryFee = notional * (cfg.feePct / 100);
        cash -= notional + entryFee;
        open.set(sym, {
          symbol: sym, signalTs: sig, entryTs: row.ts, entryMarket: price,
          qty: notional / fill, notional, entryFee, below: 0,
        });
      }
    }

    const result = evaluate(row, past, rules);
    past.push(row);
    history.set(sym, past);
    if (result?.pass && !open.has(sym) && Date.parse(row.ts) >= (cooldownUntil.get(sym) ?? 0)) {
      signals++;
      pending.set(sym, row.ts);
      cooldownUntil.set(sym, Date.parse(row.ts) + rules.cooldownMin * 60000);
    }
  }

  for (const pos of [...open.values()]) close(pos, history.get(pos.symbol).at(-1), 'DATA_END', false);
  return { trades, signals, skippedFull, endingCashUsd: round(cash) };
}

export function summarize(result, cfg) {
  const done = result.trades.filter((t) => t.complete);
  const avg = (xs) => (xs.length ? round(xs.reduce((s, x) => s + x, 0) / xs.length) : null);
  const group = (key) => {
    const out = {};
    for (const t of result.trades) {
      const g = (out[t[key]] ||= { trades: 0, pnlUsd: 0 });
      g.trades++;
      g.pnlUsd = round(g.pnlUsd + t.pnlUsd);
    }
    return out;
  };
  return {
    signals: result.signals,
    trades: result.trades.length,
    completeTrades: done.length,
    skippedMaxPositions: result.skippedFull,
    winRatePct: done.length ? round((done.filter((t) => t.netPct > 0).length / done.length) * 100, 1) : null,
    avgGrossPct: avg(done.map((t) => t.grossPct)),
    avgNetPct: avg(done.map((t) => t.netPct)),
    roundTripCostPct: round(2 * (cfg.feePct + cfg.slippagePct)),
    startingCashUsd: cfg.startingCashUsd,
    endingCashUsd: result.endingCashUsd,
    totalPnlUsd: round(result.endingCashUsd - cfg.startingCashUsd),
    byReason: group('reason'),
    bySymbol: group('symbol'),
  };
}

function toCsv(trades) {
  const cols = ['symbol', 'signalTs', 'entryTs', 'entryPx', 'exitTs', 'exitPx', 'reason', 'holdMin', 'grossPct', 'netPct', 'pnlUsd', 'complete'];
  return [cols.join(','), ...trades.map((t) => cols.map((c) => t[c]).join(','))].join('\n') + '\n';
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const rules = JSON.parse(readFileSync(args.rules, 'utf8'));
  const cfg = JSON.parse(readFileSync(args.config, 'utf8'));
  const result = simulate(loadSnapshots(args.data), rules, cfg);
  const summary = summarize(result, cfg);
  mkdirSync(args.out, { recursive: true });
  writeFileSync(join(args.out, 'trades.csv'), toCsv(result.trades));
  writeFileSync(join(args.out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
