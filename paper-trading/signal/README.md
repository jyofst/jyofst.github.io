# 신호 봇 (모의 매매용)

스카우트가 쌓은 CSV(`../scout/data`)를 읽고, 종목마다 `rules.json`에 적힌 진입 조건을 체크해. 조건을 전부 통과하면 `ENTRY_CANDIDATE` 신호를 `signals/YYYY-MM-DD.jsonl`에 기록해. 주문은 넣지 않고, 매수 추천도 아니야. "조건이 이 시점에 충족됐다"는 관찰 기록일 뿐이야.

## 실행

```bash
node signal.mjs                 # 한 번 실행
node signal.mjs --watch 60      # 60초마다 다시 실행
node --test signal.test.mjs     # 규칙 테스트
```

이미 처리한 시각은 `signals/.state.json`에 기억해 둬. 그래서 여러 번 돌려도 같은 신호가 중복으로 기록되지 않아.

## 체크 항목 (`rules.json`)

| 체크 | 기본값 | 뜻 |
|---|---|---|
| (워밍업) | `lookbackTicks` 10 | 직전 기록이 10틱 이상 쌓이기 전에는 판단하지 않아 |
| `liquidity` | `minLiquidityUsd` 100,000 | 유동성 $10만 이상 |
| `activity` | `minTxnsM5` 5 | 최근 5분 거래가 5건 이상 |
| `buyPressure` | `minBuyRatioM5` 0.6 | 최근 5분 거래 중 매수 비율이 60% 이상 |
| `momentumM5` | `minChgM5` 0 | 5분 변동률이 0보다 커야 해. 값이 비어 있으면 실패야 |
| `momentumH1` | `minChgH1` 0 | 1시간 변동률이 0보다 커야 해 |
| `aboveMean` | - | 현재가가 최근 10틱 평균 이상 |
| `notChasing` | `maxAboveMeanPct` 5 | 현재가가 평균보다 5% 넘게 높지 않아야 해. 급등을 뒤쫓는 진입을 막는 장치야 |
| `noRecentFlags` | - | 최근 10틱 안에 `JUMP`나 `LIQ_DROP` 플래그가 없어야 해 |
| (쿨다운) | `cooldownMin` 30 | 같은 종목은 30분 안에 신호를 다시 내지 않아 |

실행할 때마다 종목별로 마지막 판정이 `[status]` 줄로 출력돼. 거기서 어떤 조건에서 걸렸는지 바로 볼 수 있어.
