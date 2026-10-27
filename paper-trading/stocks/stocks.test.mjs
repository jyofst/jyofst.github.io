// Run: node --test paper-trading/stocks/stocks.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluate } from './scan.mjs';
import { runTrade, backtestSymbol } from './backtest.mjs';
import { topByMarketCap, krxBars } from './collect.mjs';

const rules = JSON.parse(readFileSync(new URL('./rules.json', import.meta.url), 'utf8'));
const cfg = JSON.parse(readFileSync(new URL('./backtest.json', import.meta.url), 'utf8'));

const bar = (i, close, volume = 1_000_000) => ({
  date: `D${String(i).padStart(3, '0')}`, open: close, high: close * 1.01, low: close * 0.99, close, volume,
});
// 90 days rising 1% a day, then a 3-day pullback of 2% a day on light volume:
// the close ends near the 20-day line, well off the recent high.
function pullbackSeries() {
  const bars = [];
  let px = 10_000;
  for (let i = 0; i < 90; i++) bars.push(bar(i, (px *= 1.01)));
  for (let i = 90; i < 93; i++) bars.push(bar(i, (px *= 0.98), 500_000));
  return bars;
}

test('flags a light-volume pullback to the 20-day line in an uptrend', () => {
  const bars = pullbackSeries();
  const r = evaluate(bars, bars.length - 1, rules);
  assert.deepEqual(r.failed, []);
  assert.ok(r.disparity20 >= rules.nearMa20Low && r.disparity20 <= rules.nearMa20High);
});

test('rejects the same shape in a downtrend', () => {
  const bars = pullbackSeries().map((b, i, all) => ({ ...all[all.length - 1 - i], date: b.date }));
  assert.ok(evaluate(bars, bars.length - 1, rules).failed.includes('uptrend'));
});

test('rejects a stock below the trading value floor', () => {
  const bars = pullbackSeries().map((b) => ({ ...b, volume: 10 }));
  assert.ok(evaluate(bars, bars.length - 1, rules).failed.includes('liquidity'));
});

test('waits for enough history', () => {
  assert.equal(evaluate(pullbackSeries(), rules.minBars - 2, rules), null);
});

test('trade exits: take-profit, stop-loss, time, and open at data end', () => {
  const path = (closes) => closes.map((c, i) => bar(i, c));
  assert.equal(runTrade(path([100, 105, 111]), 0, cfg).reason, 'TAKE_PROFIT');
  assert.equal(runTrade(path([100, 96, 94]), 0, cfg).reason, 'STOP_LOSS');
  const flat = runTrade(path(Array(cfg.maxHoldDays).fill(100)), 0, cfg);
  assert.equal(flat.reason, 'TIME');
  assert.equal(flat.heldDays, cfg.maxHoldDays);
  assert.ok(flat.netPct < 0, 'costs make a flat trade lose');
  assert.equal(runTrade(path([100, 101]), 0, cfg), null);
});

test('one open signal trade per symbol at a time', () => {
  const bars = pullbackSeries();
  for (let i = 0; i < cfg.maxHoldDays; i++) bars.push(bar(93 + i, bars.at(-1).close));
  const { signal } = backtestSymbol(bars, rules, cfg, 'KRW');
  for (let k = 1; k < signal.length; k++) assert.ok(signal[k].signalDate > signal[k - 1].exitDate);
});

test('universe keeps common shares and drops preferred shares and SPACs', () => {
  const rows = [
    { srtnCd: '005930', itmsNm: '삼성전자', mrktCtg: 'KOSPI', mrktTotAmt: '900' },
    { srtnCd: '005935', itmsNm: '삼성전자우', mrktCtg: 'KOSPI', mrktTotAmt: '800' },
    { srtnCd: '123450', itmsNm: '어떤스팩1호', mrktCtg: 'KOSPI', mrktTotAmt: '700' },
    { srtnCd: '000660', itmsNm: 'SK하이닉스', mrktCtg: 'KOSPI', mrktTotAmt: '1000' },
    { srtnCd: '196170', itmsNm: '알테오젠', mrktCtg: 'KOSDAQ', mrktTotAmt: '500' },
  ];
  assert.deepEqual(topByMarketCap(rows, 'KOSPI', 5).map((s) => s.symbol), ['000660.KS', '005930.KS']);
  assert.deepEqual(topByMarketCap(rows, 'KOSDAQ', 5).map((s) => s.symbol), ['196170.KQ']);
});

test('KRX rows become sorted bars without halted days', () => {
  const rows = [
    { basDt: '20261027', mkp: '100', hipr: '110', lopr: '90', clpr: '105', trqu: '5' },
    { basDt: '20261024', mkp: '0', hipr: '0', lopr: '0', clpr: '0', trqu: '0' },
    { basDt: '20261023', mkp: '95', hipr: '99', lopr: '94', clpr: '98', trqu: '7' },
  ];
  assert.deepEqual(krxBars(rows).map((b) => b.date), ['2026-10-23', '2026-10-27']);
});
