// Run: node --test paper-trading/signal/signal.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluate } from './signal.mjs';

const rules = JSON.parse(readFileSync(new URL('./rules.json', import.meta.url), 'utf8'));

const at = (minute) => new Date(Date.UTC(2026, 9, 21, 0, minute)).toISOString();
const snap = (price, extra = {}) => ({
  ts: at(rules.lookbackTicks), symbol: 'TEST', pair: 'p', priceUsd: String(price),
  liquidityUsd: '500000', buys_m5: '8', sells_m5: '2', chg_m5: '0.5', chg_h1: '1.2', flags: '',
  ...extra,
});
// n one-minute snapshots ending just before snap()'s timestamp.
const flat = (n, price = 1) =>
  Array.from({ length: n }, (_, i) => snap(price, { ts: at(rules.lookbackTicks - n + i) }));

test('warms up until lookback history exists', () => {
  assert.equal(evaluate(snap(1), flat(rules.lookbackTicks - 1), rules), null);
});

test('skips a window that spans a collection gap', () => {
  const history = flat(rules.lookbackTicks);
  history[0] = snap(1, { ts: at(-180) });
  assert.equal(evaluate(snap(1.02), history, rules), null);
});

test('passes when every condition holds', () => {
  const r = evaluate(snap(1.02), flat(rules.lookbackTicks), rules);
  assert.deepEqual(r.failed, []);
  assert.equal(r.pass, true);
});

test('blocks chasing a price far above the rolling mean', () => {
  const r = evaluate(snap(1.2), flat(rules.lookbackTicks), rules);
  assert.deepEqual(r.failed, ['notChasing']);
});

test('blocks when sellers dominate', () => {
  const r = evaluate(snap(1.02, { buys_m5: '2', sells_m5: '8' }), flat(rules.lookbackTicks), rules);
  assert.deepEqual(r.failed, ['buyPressure']);
});

test('blocks after a recent liquidity-drop flag', () => {
  const history = flat(rules.lookbackTicks);
  history[3] = { ...history[3], flags: 'LIQ_DROP_45.0%' };
  assert.deepEqual(evaluate(snap(1.02), history, rules).failed, ['noRecentFlags']);
});

test('treats missing m5 change as no momentum', () => {
  const r = evaluate(snap(1.02, { chg_m5: '' }), flat(rules.lookbackTicks), rules);
  assert.deepEqual(r.failed, ['momentumM5']);
});
