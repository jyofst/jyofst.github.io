#!/usr/bin/env node
// Tests each row of a swing-trading indicator cheat sheet on the daily bars:
// buy at the next open after the indicator's buy signal, sell at the close
// when its sell/stop signal fires (or after maxHoldDays). Each trade is
// compared with the equal-weight universe over the same days, so "excess"
// is what the indicator added beyond the market. KRW stocks only.
//
// Usage: node indicator-test.mjs [--data ./data] [--out ./results]

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBars, segments } from './scan.mjs';
import { ema, rsi, atr, macd, bollinger, supertrend, mfi, obv, dmi, anchoredVwap, sma } from './indicators.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// EMA120 needs 120 bars; every strategy starts there so all cover the same days.
export const WARMUP = 120;
const COST = { buyPct: 0.1, sellPct: 0.35 };
const MAX_HOLD_DAYS = 30;

function parseArgs(argv) {
  const args = { data: join(HERE, 'data'), out: join(HERE, 'results') };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    if (!(key in args)) throw new Error(`unknown option --${key}`);
    args[key] = argv[i + 1];
  }
  return args;
}

const crossUp = (a, b, i) => a[i - 1] != null && b[i - 1] != null && a[i - 1] <= b[i - 1] && a[i] > b[i];
const crossDown = (a, b, i) => crossUp(b, a, i);

export function computeAll(bars) {
  const closes = bars.map((b) => b.close);
  const vol = bars.map((b) => b.volume);
  return {
    closes,
    e20: ema(closes, 20), e60: ema(closes, 60), e120: ema(closes, 120),
    vwap: anchoredVwap(bars, 60),
    st: supertrend(bars, 10, 3),
    bb: bollinger(bars, 20, 2),
    vol20: sma(vol, 20),
    mfi: mfi(bars, 14),
    obv: obv(bars),
    macd: macd(bars),
    rsi: rsi(bars, 14),
    dmi: dmi(bars, 14),
    atr: atr(bars, 14),
  };
}

// Each strategy: the cheat sheet's wording, then how it is coded.
// buy(x, i) is checked at bar i's close; sell(x, i, pos) at each later close.
export const STRATEGIES = [
  {
    name: 'EMA 20/60/120',
    rule: '매수: 20>60>120 정배열에서 종가가 EMA20을 아래→위로 돌파 · 매도: 종가가 EMA20 아래로 이탈',
    buy: (x, i) => x.e20[i] > x.e60[i] && x.e60[i] > x.e120[i] && crossUp(x.closes, x.e20, i),
    sell: (x, i) => x.closes[i] < x.e20[i],
  },
  {
    name: '고정 VWAP',
    rule: '매수: 60일 최저점 기준 VWAP 위에서 종가 2일 연속 마감(전에는 아래) · 매도: 종가가 VWAP 아래',
    buy: (x, i) => x.closes[i] > x.vwap[i] && x.closes[i - 1] > x.vwap[i - 1] && x.closes[i - 2] <= x.vwap[i - 2],
    sell: (x, i) => x.closes[i] < x.vwap[i],
  },
  {
    name: '슈퍼트렌드 10,3',
    rule: '매수: 하락→상승 추세 전환 · 매도: 상승→하락 전환',
    buy: (x, i) => x.st.up[i] === true && x.st.up[i - 1] === false,
    sell: (x, i) => x.st.up[i] === false,
  },
  {
    name: '볼린저 밴드 20,2',
    rule: '매수: 최근 5일 안에 하단밴드를 찍고 종가가 중앙선을 상향 돌파 · 매도: 종가가 중앙선 아래',
    buy: (x, i, bars) => crossUp(x.closes, x.bb.mid, i) && [0, 1, 2, 3, 4].some((k) => bars[i - k].low <= x.bb.lower[i - k]),
    sell: (x, i) => x.closes[i] < x.bb.mid[i],
  },
  {
    name: '거래량 + MFI/OBV',
    rule: '매수: 거래량 ≥ 20일 평균의 1.5배 + MFI 상승(80 미만) + OBV 5일 전보다 상승 · 매도: MFI가 80 위에서 꺾임 또는 OBV가 5일 전보다 낮아짐',
    buy: (x, i, bars) => bars[i].volume >= 1.5 * x.vol20[i] && x.mfi[i] > x.mfi[i - 1] && x.mfi[i] < 80 && x.obv[i] > x.obv[i - 5],
    sell: (x, i) => (x.mfi[i - 1] >= 80 && x.mfi[i] < x.mfi[i - 1]) || x.obv[i] < x.obv[i - 5],
  },
  {
    name: 'MACD 12,26,9',
    rule: '매수: 0선 위에서 MACD가 시그널을 골든크로스 · 매도: 데드크로스',
    buy: (x, i) => x.macd.line[i] > 0 && crossUp(x.macd.line, x.macd.signal, i),
    sell: (x, i) => crossDown(x.macd.line, x.macd.signal, i) || x.macd.line[i] < 0,
  },
  {
    name: 'RSI 14',
    rule: '매수: 최근 10일 안에 40 이하였다가 50을 상향 돌파 · 매도: 50 하향 이탈 또는 70 위에서 꺾임',
    buy: (x, i) => x.rsi[i - 1] <= 50 && x.rsi[i] > 50 && x.rsi.slice(i - 10, i).some((r) => r != null && r <= 40),
    sell: (x, i) => x.rsi[i] < 50 || (x.rsi[i - 1] >= 70 && x.rsi[i] < x.rsi[i - 1]),
  },
  {
    name: 'DMI + ADX 14',
    rule: '매수: +DI가 -DI를 상향 돌파 + ADX ≥ 25이고 상승 · 매도: -DI가 +DI 위로 또는 ADX 25 미만',
    buy: (x, i) => crossUp(x.dmi.plusDi, x.dmi.minusDi, i) && x.dmi.adx[i] >= 25 && x.dmi.adx[i] > x.dmi.adx[i - 1],
    sell: (x, i) => x.dmi.minusDi[i] > x.dmi.plusDi[i] || x.dmi.adx[i] < 25,
  },
  {
    name: '종합: ADX + VWAP + MFI + ATR 손절',
    rule: '매수: ADX ≥ 25·+DI > -DI·종가 > VWAP·MFI 상승이 처음 동시에 충족 · 매도: 종가 < 진입가 − ATR×2 또는 종가 < VWAP',
    buy: (x, i) => {
      const ok = (k) => x.dmi.adx[k] >= 25 && x.dmi.plusDi[k] > x.dmi.minusDi[k] && x.closes[k] > x.vwap[k] && x.mfi[k] > x.mfi[k - 1];
      return ok(i) && !ok(i - 1);
    },
    sell: (x, i, pos) => x.closes[i] < pos.entryPx - 2 * pos.atrAtEntry || x.closes[i] < x.vwap[i],
  },
];

// One position at a time per symbol: enter at the next open, exit at the
// close the sell rule (or max hold) fires. Trades still open at the end of
// the data are left out.
export function runStrategy(bars, x, strat) {
  const trades = [];
  for (let i = WARMUP; i < bars.length - 1; i++) {
    if (!strat.buy(x, i, bars)) continue;
    const entry = i + 1;
    const pos = { entryPx: bars[entry].open, atrAtEntry: x.atr?.[i] };
    let exit = null;
    for (let j = entry; j < bars.length; j++) {
      if (strat.sell(x, j, pos) || j - entry + 1 >= MAX_HOLD_DAYS) {
        exit = j;
        break;
      }
    }
    if (exit == null) break;
    const net = ((bars[exit].close * (1 - COST.sellPct / 100)) / (pos.entryPx * (1 + COST.buyPct / 100)) - 1) * 100;
    trades.push({ entryDate: bars[entry].date, exitDate: bars[exit].date, heldDays: exit - entry + 1, netPct: net, entryIdx: entry, exitIdx: exit });
    i = exit;
  }
  return trades;
}

// Equal-weight universe level by date, chained within segments.
function marketIndex(series) {
  const byDate = new Map();
  for (const segs of series) {
    for (const bars of segs) {
      for (let i = 1; i < bars.length; i++) {
        const r = bars[i].close / bars[i - 1].close;
        const acc = byDate.get(bars[i].date) ?? { sum: 0, n: 0 };
        acc.sum += r;
        acc.n += 1;
        byDate.set(bars[i].date, acc);
      }
    }
  }
  const level = new Map();
  let lvl = 1;
  for (const d of [...byDate.keys()].sort()) {
    const { sum, n } = byDate.get(d);
    lvl *= sum / n;
    level.set(d, lvl);
  }
  return level;
}

// A day is "bull" when the equal-weight universe closes above its own
// 60-day average: a plain, rule-free way to split the window by regime.
export function marketRegime(level, n = 60) {
  const dates = [...level.keys()];
  const avg = sma(dates.map((d) => level.get(d)), n);
  return new Map(dates.map((d, i) => [d, avg[i] != null && level.get(d) > avg[i]]));
}

function summarize(trades) {
  const r = (v) => (v == null ? null : Number(v.toFixed(2)));
  const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const nets = trades.map((t) => t.netPct).sort((a, b) => a - b);
  return {
    trades: trades.length,
    winRatePct: trades.length ? r((nets.filter((v) => v > 0).length / nets.length) * 100) : null,
    avgNetPct: r(avg(nets)),
    medianNetPct: nets.length ? r(nets[Math.floor(nets.length / 2)]) : null,
    avgHeldDays: r(avg(trades.map((t) => t.heldDays))),
    avgExcessPct: r(avg(trades.map((t) => t.excessPct))),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const { symbols } = JSON.parse(readFileSync(join(args.data, 'universe.json'), 'utf8'));
  const series = symbols
    .filter((s) => s.currency === 'KRW')
    .map((s) => segments(loadBars(join(args.data, 'bars', `${s.symbol}.csv`)), 'KRW'));
  const market = marketIndex(series);
  const dates = [...market.keys()];
  const testStart = dates[WARMUP] ?? dates[0];
  const midDate = dates[Math.floor((dates.indexOf(testStart) + dates.length) / 2)];
  const bull = marketRegime(market);
  const testDates = dates.filter((d) => d >= testStart);
  const bullDays = testDates.filter((d) => bull.get(d)).length;

  const results = STRATEGIES.map((strat) => {
    const trades = [];
    for (const segs of series) {
      for (const bars of segs) {
        if (bars.length <= WARMUP + 1) continue;
        const x = computeAll(bars);
        for (const t of runStrategy(bars, x, strat)) {
          // Market over the same holding window: from the day before entry
          // (entry is at the open) to the exit close.
          const before = market.get(bars[t.entryIdx - 1].date);
          const after = market.get(t.exitDate);
          const mkt = before && after ? (after / before - 1) * 100 : 0;
          trades.push({ ...t, excessPct: t.netPct - mkt, bull: bull.get(bars[t.entryIdx - 1].date) });
        }
      }
    }
    return {
      name: strat.name,
      rule: strat.rule,
      all: summarize(trades),
      firstHalf: summarize(trades.filter((t) => t.entryDate < midDate)),
      secondHalf: summarize(trades.filter((t) => t.entryDate >= midDate)),
      bull: summarize(trades.filter((t) => t.bull)),
      notBull: summarize(trades.filter((t) => !t.bull)),
    };
  });

  const summary = {
    testStart, midDate, testEnd: dates.at(-1), symbols: series.length,
    testDays: testDates.length, bullDays,
    marketReturnPct: Number(((market.get(dates.at(-1)) / market.get(testStart) - 1) * 100).toFixed(2)),
    maxHoldDays: MAX_HOLD_DAYS, cost: COST, results,
  };
  mkdirSync(args.out, { recursive: true });
  writeFileSync(join(args.out, 'indicator-test.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(results.map((r) => ({ name: r.name, ...r.all })), null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
