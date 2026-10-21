#!/usr/bin/env node
// Data scout: records price/liquidity/volume snapshots for a fixed watchlist
// from DexScreener (no API key). Paper-trading only — never places orders.
//
// Usage: node scout.mjs [--interval 60] [--ticks 0] [--out ./data]
//   --ticks 0 runs until stopped.

import { readFileSync, mkdirSync, appendFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const API = 'https://api.dexscreener.com';
const RESOLVE_EVERY_MS = 6 * 60 * 60 * 1000;
const JUMP_PCT = 15;          // price move between ticks worth flagging
const LIQ_DROP_PCT = 30;      // liquidity drop between ticks worth flagging

const COLUMNS = [
  'ts', 'symbol', 'pair', 'dex', 'priceUsd', 'liquidityUsd', 'fdv',
  'vol_m5', 'vol_h1', 'vol_h24', 'chg_m5', 'chg_h1', 'chg_h24',
  'buys_m5', 'sells_m5', 'flags',
];

function parseArgs(argv) {
  const args = { interval: 60, ticks: 0, out: join(HERE, 'data'), watchlist: join(HERE, 'watchlist.json') };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    if (!(key in args)) throw new Error(`unknown option --${key}`);
    args[key] = typeof args[key] === 'number' ? Number(argv[i + 1]) : argv[i + 1];
  }
  return args;
}

async function getJson(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (res.status === 429) throw new Error('rate limited');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt === 3) throw err;
      await sleep(2000 * attempt);
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pick the pair by contract address, not by symbol: symbol search returns
// look-alike tokens whose "liquidity" is large but whose volume is near zero.
async function resolvePairs(cfg) {
  const resolved = [];
  for (const t of cfg.tokens) {
    const pairs = await getJson(`${API}/token-pairs/v1/${cfg.chain}/${t.address}`);
    const best = pairs
      .filter((p) => p.baseToken?.address === t.address && (p.liquidity?.usd ?? 0) >= cfg.minLiquidityUsd)
      .sort((a, b) => (b.volume?.h24 ?? 0) - (a.volume?.h24 ?? 0))[0];
    if (!best) {
      console.warn(`[resolve] ${t.symbol}: no pair with liquidity >= $${cfg.minLiquidityUsd}`);
      continue;
    }
    resolved.push({ symbol: t.symbol, pair: best.pairAddress });
    console.log(`[resolve] ${t.symbol} -> ${best.dexId} ${best.pairAddress} (vol24 $${Math.round(best.volume?.h24 ?? 0)})`);
  }
  return resolved;
}

function toRow(symbol, p, prev, ts) {
  const price = Number(p.priceUsd);
  const liq = p.liquidity?.usd ?? null;
  const flags = [];
  if (!Number.isFinite(price)) flags.push('NO_PRICE');
  if (prev && Number.isFinite(price) && prev.price > 0) {
    const move = ((price - prev.price) / prev.price) * 100;
    if (Math.abs(move) >= JUMP_PCT) flags.push(`JUMP_${move.toFixed(1)}%`);
  }
  if (prev && liq != null && prev.liq > 0) {
    const drop = ((prev.liq - liq) / prev.liq) * 100;
    if (drop >= LIQ_DROP_PCT) flags.push(`LIQ_DROP_${drop.toFixed(1)}%`);
  }
  return {
    ts, symbol, pair: p.pairAddress, dex: p.dexId, priceUsd: p.priceUsd ?? '',
    liquidityUsd: liq ?? '', fdv: p.fdv ?? '',
    vol_m5: p.volume?.m5 ?? '', vol_h1: p.volume?.h1 ?? '', vol_h24: p.volume?.h24 ?? '',
    chg_m5: p.priceChange?.m5 ?? '', chg_h1: p.priceChange?.h1 ?? '', chg_h24: p.priceChange?.h24 ?? '',
    buys_m5: p.txns?.m5?.buys ?? '', sells_m5: p.txns?.m5?.sells ?? '',
    flags: flags.join(' '),
  };
}

function appendCsv(outDir, row) {
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${row.ts.slice(0, 10)}.csv`);
  if (!existsSync(file)) appendFileSync(file, COLUMNS.join(',') + '\n');
  appendFileSync(file, COLUMNS.map((c) => String(row[c]).replaceAll(',', ' ')).join(',') + '\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = JSON.parse(readFileSync(args.watchlist, 'utf8'));
  let pairs = await resolvePairs(cfg);
  let resolvedAt = Date.now();
  const last = new Map();

  for (let tick = 1; args.ticks === 0 || tick <= args.ticks; tick++) {
    if (Date.now() - resolvedAt > RESOLVE_EVERY_MS) {
      pairs = await resolvePairs(cfg);
      resolvedAt = Date.now();
    }
    const ts = new Date().toISOString();
    try {
      const data = await getJson(`${API}/latest/dex/pairs/${cfg.chain}/${pairs.map((p) => p.pair).join(',')}`);
      const byPair = new Map((data.pairs ?? []).map((p) => [p.pairAddress, p]));
      for (const { symbol, pair } of pairs) {
        const p = byPair.get(pair);
        if (!p) {
          console.warn(`[tick ${tick}] ${symbol}: pair missing from response`);
          continue;
        }
        const row = toRow(symbol, p, last.get(symbol), ts);
        last.set(symbol, { price: Number(p.priceUsd), liq: p.liquidity?.usd ?? 0 });
        appendCsv(args.out, row);
        console.log(`[tick ${tick}] ${symbol} $${row.priceUsd} liq $${Math.round(row.liquidityUsd)} m5 ${row.chg_m5}% ${row.flags}`);
      }
    } catch (err) {
      console.error(`[tick ${tick}] fetch failed: ${err.message}`);
    }
    if (args.ticks === 0 || tick < args.ticks) await sleep(args.interval * 1000);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
