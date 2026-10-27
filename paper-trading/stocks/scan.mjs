#!/usr/bin/env node
// Daily pullback scanner: for each symbol in the universe, checks whether the
// latest bar is a pullback toward the 20-day line inside an uptrend, and
// writes today's candidates plus the holdings' status to a Markdown report.
// Observation only — not a recommendation to buy or sell.
//
// Usage: node scan.mjs [--data ./data] [--out ./results] [--rules ./rules.json]

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { data: join(HERE, 'data'), out: join(HERE, 'results'), rules: join(HERE, 'rules.json') };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    if (!(key in args)) throw new Error(`unknown option --${key}`);
    args[key] = argv[i + 1];
  }
  return args;
}

export function loadBars(file) {
  if (!existsSync(file)) return [];
  const [, ...lines] = readFileSync(file, 'utf8').trim().split('\n');
  return lines.map((l) => {
    const [date, open, high, low, close, volume] = l.split(',');
    return { date, open: +open, high: +high, low: +low, close: +close, volume: +volume };
  });
}

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const sma = (bars, i, n, key = 'close') => (i + 1 >= n ? mean(bars.slice(i + 1 - n, i + 1).map((b) => b[key])) : null);

// Checks bar i using only bars[0..i]. Returns null without enough history.
export function evaluate(bars, i, rules, currency = 'KRW') {
  if (i + 1 < rules.minBars) return null;
  const b = bars[i];
  const ma5 = sma(bars, i, 5);
  const ma20 = sma(bars, i, 20);
  const ma60 = sma(bars, i, 60);
  const ma60Before = sma(bars, i - rules.ma60SlopeDays, 60);
  const disparity20 = (b.close / ma20) * 100;
  const recentHigh = Math.max(...bars.slice(i + 1 - rules.highLookbackDays, i + 1).map((x) => x.high));
  const fromHighPct = (b.close / recentHigh - 1) * 100;
  const volRatio = sma(bars, i, 5, 'volume') / sma(bars, i, 20, 'volume');
  const avgValue = mean(bars.slice(i - 19, i + 1).map((x) => x.close * x.volume));
  const minValue = rules.minAvgTradingValue[currency] ?? 0;

  const checks = {
    uptrend: ma20 > ma60 && ma60 > ma60Before && b.close > ma60,
    nearMa20: disparity20 >= rules.nearMa20Low && disparity20 <= rules.nearMa20High,
    pulledBack: fromHighPct <= -rules.pullbackFromHighPct,
    volumeDryUp: volRatio <= rules.volumeDryUpRatio,
    liquidity: avgValue >= minValue,
  };
  const r = (x, d = 2) => Number(x.toFixed(d));
  return {
    date: b.date,
    close: b.close,
    aligned: ma5 > ma20 && ma20 > ma60,
    disparity20: r(disparity20, 1),
    fromHighPct: r(fromHighPct, 1),
    volRatio: r(volRatio),
    checks,
    failed: Object.keys(checks).filter((k) => !checks[k]),
    pass: Object.values(checks).every(Boolean),
  };
}

const CHECK_LABELS = {
  uptrend: '추세', nearMa20: '20일선 근처', pulledBack: '고점 대비 조정', volumeDryUp: '거래량 감소', liquidity: '거래대금',
};

function fmtPrice(x, currency) {
  return currency === 'USD' ? `$${x.toFixed(2)}` : `${Math.round(x).toLocaleString('en-US')}원`;
}

export function renderReport({ asOf, universe, results, backtest }) {
  const name = (s) => `${s.name} (${s.symbol.replace(/\.(KS|KQ)$/, '')})`;
  const candidates = results.filter((x) => x.res?.pass && !x.s.holding).sort((a, b) => a.res.disparity20 - b.res.disparity20);
  const lines = [
    `# 눌림목 스캔 (${asOf})`,
    '',
    universe.scope === 'market'
      ? `범위: ${universe.symbols.length}종목 (코스피 시총 상위 200 + 코스닥 상위 150 + 보유종목). 데이터 실패 ${universe.failed.length}종목.`
      : `범위: 보유종목 ${universe.symbols.length}개만 봤어. 공공데이터포털 키(DATA_GO_KR_KEY)가 아직 없어서 시장 전체를 못 받았어. 데이터 실패 ${universe.failed.length}종목.`,
    '',
    '조건: 20일선이 60일선 위에 있고 60일선이 오르는 중이야. 그 상태에서 종가가 20일선 97~103% 안에 있고, 20일 고점보다 5% 이상 빠져 있고, 최근 5일 거래량이 20일 평균 이하일 때 걸려. **관찰 기록이고 매수 추천이 아니야.**',
    '',
    `## 오늘 조건 충족 (${candidates.length}종목)`,
    '',
  ];
  if (candidates.length) {
    lines.push('| 종목 | 시장 | 종가 | 20일 이격도 | 20일 고점 대비 | 거래량 5일/20일 | 정배열 |', '|---|---|---|---|---|---|---|');
    for (const { s, res } of candidates) {
      lines.push(`| ${name(s)} | ${s.market} | ${fmtPrice(res.close, s.currency)} | ${res.disparity20} | ${res.fromHighPct}% | ${res.volRatio} | ${res.aligned ? 'O' : 'X'} |`);
    }
  } else {
    lines.push('조건을 모두 통과한 종목이 없어.');
  }
  lines.push('', '## 보유종목 위치', '', '| 종목 | 기준일 | 종가 | 정배열 | 20일 이격도 | 20일 고점 대비 | 조건 결과 |', '|---|---|---|---|---|---|---|');
  for (const { s, res } of results.filter((x) => x.s.holding)) {
    if (!res) {
      lines.push(`| ${name(s)} | - | - | - | - | - | 데이터 부족 |`);
      continue;
    }
    const verdict = res.pass ? '전부 통과' : `미충족: ${res.failed.map((k) => CHECK_LABELS[k]).join(', ')}`;
    lines.push(`| ${name(s)} | ${res.date} | ${fmtPrice(res.close, s.currency)} | ${res.aligned ? 'O' : 'X'} | ${res.disparity20} | ${res.fromHighPct}% | ${verdict} |`);
  }
  if (backtest) {
    const { signal: sg, baseline: bl, cfg } = backtest;
    lines.push(
      '',
      '## 지난 1년 백테스트',
      '',
      `신호 다음 날 시가에 사고, 손절 -${cfg.stopLossPct}% · 익절 +${cfg.takeProfitPct}% · 최대 ${cfg.maxHoldDays}거래일 보유로 종가 기준 청산한 결과야. 비용은 매수 ${cfg.buyCostPct}%, 매도 ${cfg.sellCostPct}%로 잡았어. 비교 기준은 같은 종목에서 아무 날이나 똑같이 샀을 때의 평균이야.`,
      '',
      '| 구분 | 거래 수 | 승률 | 평균 순수익 | 중앙값 |',
      '|---|---|---|---|---|',
      `| 눌림목 신호 | ${sg.trades} | ${sg.winRatePct}% | ${sg.avgNetPct}% | ${sg.medianNetPct}% |`,
      `| 아무 날이나 (비교 기준) | ${bl.trades} | ${bl.winRatePct}% | ${bl.avgNetPct}% | ${bl.medianNetPct}% |`,
      '',
      '범위를 오늘 시가총액 순위로 골랐기 때문에, 1년 사이 크게 오른 종목이 더 많이 들어가 있어(생존 편향). 그래서 두 줄 모두 실제보다 좋게 나올 수 있어. 의미 있게 볼 건 두 줄의 차이야.',
    );
  }
  return lines.join('\n') + '\n';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rules = JSON.parse(readFileSync(args.rules, 'utf8'));
  const universe = JSON.parse(readFileSync(join(args.data, 'universe.json'), 'utf8'));
  const results = universe.symbols.map((s) => {
    const bars = loadBars(join(args.data, 'bars', `${s.symbol}.csv`));
    return { s, res: bars.length ? evaluate(bars, bars.length - 1, rules, s.currency) : null };
  });
  const asOf = results.map((x) => x.res?.date).filter(Boolean).sort().at(-1);
  let backtest = null;
  const btFile = join(args.out, 'backtest.json');
  if (existsSync(btFile)) backtest = JSON.parse(readFileSync(btFile, 'utf8'));

  mkdirSync(args.out, { recursive: true });
  const candidates = results.filter((x) => x.res?.pass).map(({ s, res }) => ({ ...s, ...res }));
  writeFileSync(join(args.out, `signals-${asOf}.json`), JSON.stringify(candidates, null, 2) + '\n');
  writeFileSync(join(args.out, 'report.md'), renderReport({ asOf, universe, results, backtest }));
  console.log(`[scan] ${asOf}: ${candidates.length} candidate(s)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
