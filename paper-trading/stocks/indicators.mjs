// Daily technical indicators over an array of bars ({ open, high, low,
// close, volume }). Each returns an array aligned with the bars, with null
// until the indicator has enough history.

export function sma(values, n) {
  const out = Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

// Seeded with the simple average of the first n values.
export function ema(values, n) {
  const out = Array(values.length).fill(null);
  const k = 2 / (n + 1);
  let start = values.findIndex((v) => v != null);
  if (start < 0 || values.length - start < n) return out;
  let prev = values.slice(start, start + n).reduce((a, b) => a + b, 0) / n;
  out[start + n - 1] = prev;
  for (let i = start + n; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// Wilder's smoothing: first value is the simple average, then
// prev + (x - prev) / n.
function wilder(values, n, from = 0) {
  const out = Array(values.length).fill(null);
  if (values.length - from < n) return out;
  let prev = values.slice(from, from + n).reduce((a, b) => a + b, 0) / n;
  out[from + n - 1] = prev;
  for (let i = from + n; i < values.length; i++) {
    prev += (values[i] - prev) / n;
    out[i] = prev;
  }
  return out;
}

export function rsi(bars, n = 14) {
  const gains = [0];
  const losses = [0];
  for (let i = 1; i < bars.length; i++) {
    const d = bars[i].close - bars[i - 1].close;
    gains.push(Math.max(d, 0));
    losses.push(Math.max(-d, 0));
  }
  const g = wilder(gains, n, 1);
  const l = wilder(losses, n, 1);
  return g.map((x, i) => (x == null ? null : l[i] === 0 ? 100 : 100 - 100 / (1 + x / l[i])));
}

function trueRange(bars) {
  return bars.map((b, i) => (i === 0 ? b.high - b.low
    : Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close))));
}

export function atr(bars, n = 14) {
  return wilder(trueRange(bars), n, 1);
}

export function macd(bars, fast = 12, slow = 26, signal = 9) {
  const closes = bars.map((b) => b.close);
  const f = ema(closes, fast);
  const s = ema(closes, slow);
  const line = f.map((x, i) => (x == null || s[i] == null ? null : x - s[i]));
  const sig = ema(line, signal);
  return { line, signal: sig, hist: line.map((x, i) => (x == null || sig[i] == null ? null : x - sig[i])) };
}

export function bollinger(bars, n = 20, k = 2) {
  const closes = bars.map((b) => b.close);
  const mid = sma(closes, n);
  const upper = Array(bars.length).fill(null);
  const lower = Array(bars.length).fill(null);
  for (let i = n - 1; i < bars.length; i++) {
    const w = closes.slice(i - n + 1, i + 1);
    const sd = Math.sqrt(w.reduce((a, x) => a + (x - mid[i]) ** 2, 0) / n);
    upper[i] = mid[i] + k * sd;
    lower[i] = mid[i] - k * sd;
  }
  return { mid, upper, lower };
}

// up[i] is true while the trend is up; line[i] is the trailing stop line.
export function supertrend(bars, n = 10, mult = 3) {
  const a = atr(bars, n);
  const up = Array(bars.length).fill(null);
  const line = Array(bars.length).fill(null);
  let upperBand = null;
  let lowerBand = null;
  for (let i = 0; i < bars.length; i++) {
    if (a[i] == null) continue;
    const hl2 = (bars[i].high + bars[i].low) / 2;
    const basicUpper = hl2 + mult * a[i];
    const basicLower = hl2 - mult * a[i];
    const prevClose = bars[i - 1].close;
    upperBand = upperBand == null || basicUpper < upperBand || prevClose > upperBand ? basicUpper : upperBand;
    lowerBand = lowerBand == null || basicLower > lowerBand || prevClose < lowerBand ? basicLower : lowerBand;
    const wasUp = up[i - 1] ?? true;
    up[i] = wasUp ? bars[i].close >= lowerBand : bars[i].close > upperBand;
    line[i] = up[i] ? lowerBand : upperBand;
  }
  return { up, line };
}

export function mfi(bars, n = 14) {
  const tp = bars.map((b) => (b.high + b.low + b.close) / 3);
  const out = Array(bars.length).fill(null);
  for (let i = n; i < bars.length; i++) {
    let pos = 0;
    let neg = 0;
    for (let j = i - n + 1; j <= i; j++) {
      const flow = tp[j] * bars[j].volume;
      if (tp[j] > tp[j - 1]) pos += flow;
      else if (tp[j] < tp[j - 1]) neg += flow;
    }
    out[i] = neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
  }
  return out;
}

export function obv(bars) {
  const out = [0];
  for (let i = 1; i < bars.length; i++) {
    const d = Math.sign(bars[i].close - bars[i - 1].close);
    out.push(out[i - 1] + d * bars[i].volume);
  }
  return out;
}

export function dmi(bars, n = 14) {
  const plusDm = [0];
  const minusDm = [0];
  for (let i = 1; i < bars.length; i++) {
    const upMove = bars[i].high - bars[i - 1].high;
    const downMove = bars[i - 1].low - bars[i].low;
    plusDm.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDm.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }
  const tr = wilder(trueRange(bars), n, 1);
  const p = wilder(plusDm, n, 1);
  const m = wilder(minusDm, n, 1);
  const plusDi = p.map((x, i) => (x == null || !tr[i] ? null : (100 * x) / tr[i]));
  const minusDi = m.map((x, i) => (x == null || !tr[i] ? null : (100 * x) / tr[i]));
  const dx = plusDi.map((x, i) => (x == null || x + minusDi[i] === 0 ? null : (100 * Math.abs(x - minusDi[i])) / (x + minusDi[i])));
  const first = dx.findIndex((x) => x != null);
  const adx = first < 0 ? dx.map(() => null) : wilder(dx.map((x) => x ?? 0), n, first);
  return { plusDi, minusDi, adx };
}

// VWAP anchored at the lowest low of the last `lookback` days, re-anchored
// each day: a fixed-anchor VWAP needs a hand-picked anchor, and the most
// recent swing low is the usual choice for a long setup.
export function anchoredVwap(bars, lookback = 60) {
  const out = Array(bars.length).fill(null);
  for (let i = lookback - 1; i < bars.length; i++) {
    let anchor = i - lookback + 1;
    for (let j = anchor; j <= i; j++) if (bars[j].low < bars[anchor].low) anchor = j;
    let pv = 0;
    let v = 0;
    for (let j = anchor; j <= i; j++) {
      pv += ((bars[j].high + bars[j].low + bars[j].close) / 3) * bars[j].volume;
      v += bars[j].volume;
    }
    out[i] = v ? pv / v : null;
  }
  return out;
}
