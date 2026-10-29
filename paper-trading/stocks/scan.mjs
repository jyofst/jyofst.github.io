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

// KRX caps a day's move at ±30%, so a bigger close-to-close jump in KRW
// data is a split or merger the unadjusted data.go.kr prices did not absorb.
// Moving averages across such a jump are meaningless, so split there.
export function segments(bars, currency, maxMovePct = 30) {
  if (currency !== 'KRW') return [bars];
  const out = [];
  let start = 0;
  for (let i = 1; i < bars.length; i++) {
    if (Math.abs(bars[i].close / bars[i - 1].close - 1) * 100 > maxMovePct) {
      out.push(bars.slice(start, i));
      start = i;
    }
  }
  out.push(bars.slice(start));
  return out;
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
  // Optional stricter checks, switched on by experiment variants.
  if (rules.requireAligned) checks.aligned = ma5 > ma20 && ma20 > ma60;
  if (rules.requireBounce) checks.bounce = b.close > b.open && b.close > bars[i - 1].close;
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
  aligned: '정배열', bounce: '반등 양봉',
};

function fmtPrice(x, currency) {
  return currency === 'USD' ? `$${x.toFixed(2)}` : `${Math.round(x).toLocaleString('en-US')}원`;
}

export function renderReport({ asOf, universe, results, backtest, portfolio }) {
  const name = (s) => `${s.name} (${s.symbol.replace(/\.(KS|KQ)$/, '')})`;
  const candidates = results.filter((x) => x.res?.pass && !x.s.holding).sort((a, b) => a.res.disparity20 - b.res.disparity20);
  const lines = [
    `# 눌림목 스캔 (${asOf})`,
    '',
    universe.scope === 'market'
      ? `범위: ${universe.symbols.length}종목 (코스피 시총 상위 200 + 코스닥 상위 150 + 보유종목). 데이터 실패 ${universe.failed.length}종목.`
      : universe.keyError
        ? `범위: 보유종목 ${universe.symbols.length}개만 봤어. 공공데이터포털이 요청을 거부해서 시장 전체를 못 받았어 (\`${universe.keyError.slice(0, 200)}\`). 데이터 실패 ${universe.failed.length}종목.`
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
      '',
      `종가가 하루에 30% 넘게 변한 날(분할·합병 등으로 가격이 보정되지 않은 날 ${backtest.priceBreaks ?? 0}건)은 그 앞뒤를 이어서 계산하지 않았어.`,
    );
    if (backtest.variants?.length) {
      lines.push(
        '',
        '### 규칙 비교 실험',
        '',
        '| 규칙 | 거래 수 | 승률 | 평균 순수익 | 비교 기준과 차이 |',
        '|---|---|---|---|---|',
        ...backtest.variants.map((v) => {
          const diff = v.stats.avgNetPct == null ? '-' : `${(v.stats.avgNetPct - bl.avgNetPct).toFixed(2)}%p`;
          return `| ${v.name} | ${v.stats.trades} | ${v.stats.winRatePct ?? '-'}% | ${v.stats.avgNetPct ?? '-'}% | ${diff} |`;
        }),
      );
    }
  }
  if (portfolio) {
    const c = portfolio.config;
    const won = (x) => `${Math.round(x).toLocaleString('en-US')}원`;
    lines.push(
      '',
      '## 계좌 시뮬레이션 (리스크 단계)',
      '',
      `국내 ${portfolio.symbols}종목, ${portfolio.startDate} ~ ${portfolio.endDate}. 시작 자금 ${won(c.startingCashKrw)}으로 출발해. 종목당 계좌의 ${c.positionPct}%씩 사고, 동시에 최대 ${c.maxPositions}종목까지 들고 있어. 같은 날 신호가 자리보다 많으면 거래대금이 큰 종목부터 사. 청산 규칙과 비용은 위 백테스트와 같아. 비교 기준은 같은 종목들을 첫날 똑같은 금액씩 사서 그대로 들고 간 경우야.`,
      '',
      '| 규칙 | 최종 자산 | 수익률 | 최대 낙폭 | 거래 | 승률 | 평균 투자 비중 | 자리 없어 놓친 신호 |',
      '|---|---|---|---|---|---|---|---|',
      ...portfolio.variants.map(({ name, stats: s }) =>
        `| ${name} | ${won(s.endingEquity)} | ${s.returnPct}% | ${s.maxDrawdownPct}% | ${s.trades} | ${s.winRatePct ?? '-'}% | ${s.avgInvestedPct}% | ${s.skippedFull} |`),
      `| 첫날 사서 보유 (비교 기준) | - | ${portfolio.benchmark.returnPct}% | ${portfolio.benchmark.maxDrawdownPct}% | - | - | 100% | - |`,
    );
  }
  return lines.join('\n') + '\n';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rules = JSON.parse(readFileSync(args.rules, 'utf8'));
  const universe = JSON.parse(readFileSync(join(args.data, 'universe.json'), 'utf8'));
  const results = universe.symbols.map((s) => {
    const bars = segments(loadBars(join(args.data, 'bars', `${s.symbol}.csv`)), s.currency).at(-1);
    return { s, res: bars.length ? evaluate(bars, bars.length - 1, rules, s.currency) : null };
  });
  const asOf = results.map((x) => x.res?.date).filter(Boolean).sort().at(-1);
  let backtest = null;
  const btFile = join(args.out, 'backtest.json');
  if (existsSync(btFile)) backtest = JSON.parse(readFileSync(btFile, 'utf8'));
  const pfFile = join(args.out, 'portfolio-result.json');
  const portfolio = existsSync(pfFile) ? JSON.parse(readFileSync(pfFile, 'utf8')) : null;

  mkdirSync(args.out, { recursive: true });
  const candidates = results.filter((x) => x.res?.pass).map(({ s, res }) => ({ ...s, ...res }));
  writeFileSync(join(args.out, `signals-${asOf}.json`), JSON.stringify(candidates, null, 2) + '\n');
  writeFileSync(join(args.out, 'report.md'), renderReport({ asOf, universe, results, backtest, portfolio }));
  console.log(`[scan] ${asOf}: ${candidates.length} candidate(s)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
