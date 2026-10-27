#!/usr/bin/env node
// Builds the stock universe and downloads about a year of daily bars.
//
// With DATA_GO_KR_KEY set (a free service key for the Financial Services
// Commission stock price API on data.go.kr), the universe is the KOSPI top
// 200 + KOSDAQ top 150 common shares by market cap, priced from that API.
// Without it, only the holdings are collected. Holdings listed abroad are
// always priced from Yahoo Finance's chart endpoint.
//
// Usage: DATA_GO_KR_KEY=... node collect.mjs [--out ./data] [--kospi 200] [--kosdaq 150]

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const KRX_API = 'https://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService/getStockPriceInfo';

function parseArgs(argv) {
  const args = { out: join(HERE, 'data'), kospi: 200, kosdaq: 150, holdings: join(HERE, 'holdings.json') };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    if (!(key in args)) throw new Error(`unknown option --${key}`);
    args[key] = typeof args[key] === 'number' ? Number(argv[i + 1]) : argv[i + 1];
  }
  return args;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      // data.go.kr explains rejections (unapproved key, wrong key type) in the
      // body; keep it so the Actions log shows why.
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).replace(/\s+/g, ' ').slice(0, 300)}`);
      return await res.json();
    } catch (err) {
      if (attempt === 3) throw err;
      await sleep(2000 * attempt);
    }
  }
}

const ymd = (d) => d.toISOString().slice(0, 10).replaceAll('-', '');

async function krxItems(key, params) {
  const qs = new URLSearchParams({ serviceKey: key, resultType: 'json', numOfRows: '5000', pageNo: '1', ...params });
  const json = await getJson(`${KRX_API}?${qs}`);
  const items = json?.response?.body?.items?.item;
  return Array.isArray(items) ? items : items ? [items] : [];
}

// The API publishes each trading day around 1 p.m. the next business day, so
// walk back from yesterday until a day with rows turns up.
async function latestKrxDay(key) {
  const d = new Date();
  for (let back = 1; back <= 10; back++) {
    d.setUTCDate(d.getUTCDate() - 1);
    const rows = await krxItems(key, { basDt: ymd(d) });
    if (rows.length) return rows;
  }
  throw new Error('no KRX rows in the last 10 days');
}

// Common shares only: preferred shares have codes not ending in 0.
export function topByMarketCap(rows, market, count) {
  return rows
    .filter((r) => r.mrktCtg === market && r.srtnCd.endsWith('0') && !r.itmsNm.includes('스팩'))
    .sort((a, b) => Number(b.mrktTotAmt) - Number(a.mrktTotAmt))
    .slice(0, count)
    .map((r) => ({ symbol: `${r.srtnCd}.${market === 'KOSPI' ? 'KS' : 'KQ'}`, name: r.itmsNm, market, currency: 'KRW' }));
}

export function krxBars(rows) {
  return rows
    .map((r) => ({ date: `${r.basDt.slice(0, 4)}-${r.basDt.slice(4, 6)}-${r.basDt.slice(6)}`, open: +r.mkp, high: +r.hipr, low: +r.lopr, close: +r.clpr, volume: +r.trqu }))
    // Halted days come back with zero prices.
    .filter((b) => b.open > 0 && b.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function yahooBars(json) {
  const r = json?.chart?.result?.[0];
  const q = r?.indicators?.quote?.[0];
  if (!r?.timestamp || !q) return [];
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: r.meta?.exchangeTimezoneName ?? 'UTC' });
  return r.timestamp
    .map((t, i) => ({ date: day.format(new Date(t * 1000)), open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] }))
    .filter((b) => [b.open, b.high, b.low, b.close, b.volume].every((v) => v != null));
}

async function fetchBars(s, key) {
  if (key && s.currency === 'KRW') {
    const since = new Date();
    since.setUTCFullYear(since.getUTCFullYear() - 1);
    return krxBars(await krxItems(key, { likeSrtnCd: s.symbol.slice(0, 6), beginBasDt: ymd(since), numOfRows: '400' }));
  }
  return yahooBars(await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${s.symbol}?interval=1d&range=1y`));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // Accept either key data.go.kr shows: the Encoding one would otherwise be
  // percent-encoded a second time and rejected as unregistered.
  const rawKey = process.env.DATA_GO_KR_KEY?.trim();
  const key = rawKey?.includes('%') ? decodeURIComponent(rawKey) : rawKey;
  const { holdings } = JSON.parse(readFileSync(args.holdings, 'utf8'));
  let universe = holdings.map((h) => ({ ...h, currency: h.symbol.endsWith('.KS') || h.symbol.endsWith('.KQ') ? 'KRW' : 'USD', holding: true }));
  if (key) {
    const latest = await latestKrxDay(key);
    universe = [...universe, ...topByMarketCap(latest, 'KOSPI', args.kospi), ...topByMarketCap(latest, 'KOSDAQ', args.kosdaq)]
      .filter((s, i, all) => all.findIndex((x) => x.symbol === s.symbol) === i);
  } else {
    console.warn('[collect] DATA_GO_KR_KEY not set: collecting holdings only');
  }

  const barsDir = join(args.out, 'bars');
  mkdirSync(barsDir, { recursive: true });
  const failed = [];
  for (const s of universe) {
    try {
      const bars = await fetchBars(s, key);
      if (!bars.length) throw new Error('no bars');
      const lines = bars.map((b) => [b.date, b.open, b.high, b.low, b.close, b.volume].join(','));
      writeFileSync(join(barsDir, `${s.symbol}.csv`), ['date,open,high,low,close,volume', ...lines].join('\n') + '\n');
    } catch (err) {
      failed.push(s.symbol);
      console.warn(`[collect] ${s.symbol}: ${err.message}`);
    }
    await sleep(150);
  }
  writeFileSync(join(args.out, 'universe.json'), JSON.stringify({ updatedAt: new Date().toISOString(), scope: key ? 'market' : 'holdings', failed, symbols: universe }, null, 2) + '\n');
  console.log(`[collect] ${universe.length - failed.length}/${universe.length} symbols saved`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
