// Run: node --test paper-trading/sim/sim.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { simulate, summarize } from './sim.mjs';

const rules = JSON.parse(readFileSync(new URL('../signal/rules.json', import.meta.url), 'utf8'));
const cfg = JSON.parse(readFileSync(new URL('./sim.json', import.meta.url), 'utf8'));

const at = (minute) => new Date(Date.UTC(2026, 9, 21, 0, minute)).toISOString();
// Snapshots that pass every signal check unless a test overrides a field.
const tick = (minute, price, extra = {}) => ({
  ts: at(minute), symbol: 'TEST', pair: 'p', priceUsd: String(price),
  liquidityUsd: '500000', buys_m5: '8', sells_m5: '2', chg_m5: '0.5', chg_h1: '1.2', flags: '',
  ...extra,
});
// Flat warm-up, a signal at minute 10, entry at minute 11 (price 1), then `path`.
const run = (path, extraCfg = {}) => {
  const rows = [];
  for (let m = 0; m <= 11; m++) rows.push(tick(m, 1));
  path.forEach((p, i) => rows.push(typeof p === 'number' ? tick(12 + i, p) : tick(12 + i, p.price, p)));
  return simulate(rows, rules, { ...cfg, ...extraCfg });
};

test('enters on the tick after the signal and takes profit', () => {
  const { trades } = run([1.01, 1.06]);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].entryTs, at(11));
  assert.equal(trades[0].reason, 'TAKE_PROFIT');
});

test('ignores a one-tick wick below the stop', () => {
  const { trades } = run([0.9, 1.0, 1.06]);
  assert.equal(trades[0].reason, 'TAKE_PROFIT');
});

test('stops out after consecutive ticks below the stop', () => {
  const { trades } = run([0.96, 0.96]);
  assert.equal(trades[0].reason, 'STOP_LOSS');
  assert.equal(trades[0].exitTs, at(13));
});

test('exits on max hold time', () => {
  const { trades } = run(Array(cfg.maxHoldMin).fill(1));
  assert.equal(trades[0].reason, 'TIME');
  assert.equal(trades[0].holdMin, cfg.maxHoldMin);
});

test('books a collection gap at the last seen price as incomplete', () => {
  const rows = [];
  for (let m = 0; m <= 12; m++) rows.push(tick(m, 1));
  rows.push(tick(200, 2));
  const { trades } = simulate(rows, rules, cfg);
  assert.equal(trades[0].reason, 'DATA_GAP');
  assert.equal(trades[0].exitTs, at(12));
  assert.equal(trades[0].complete, false);
});

test('a flat round trip loses exactly the fees and slippage', () => {
  const result = run(Array(cfg.maxHoldMin).fill(1));
  const t = result.trades[0];
  const s = 1 + cfg.slippagePct / 100;
  const f = cfg.feePct / 100;
  const expected = ((1 / s) * (2 - s) * (1 - f) - 1 - f) * 100;
  assert.equal(t.grossPct, 0);
  assert.equal(t.netPct, Number(expected.toFixed(2)));
  assert.equal(summarize(result, cfg).roundTripCostPct, 1);
});
