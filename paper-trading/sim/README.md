# 시뮬레이터 (리스크 + 모의 집행)

스카우트가 쌓은 기록을 처음부터 시간 순서대로 다시 훑어. 그러면서 신호 봇과 같은 규칙(`../signal/rules.json`)으로 신호를 찾고, 신호가 나면 가상으로 사고팔아. "이 규칙대로 매매했으면 수수료까지 내고 얼마가 남았을까"를 숫자로 확인하는 도구야. 진짜 주문은 넣지 않고, 매수 추천도 아니야.

## 실행

```bash
node sim.mjs                     # ../scout/data를 읽어서 results/에 결과를 써
node sim.mjs --data <폴더> --out <폴더> --config ./sim.json
node --test sim.test.mjs
```

결과 파일은 두 개야. `results/trades.csv`에는 거래 하나하나가, `results/summary.json`에는 승률·평균 손익·청산 이유별 집계가 들어가. GitHub Actions에서는 매 실행마다 `scout-data` 브랜치의 `sim/` 폴더에 커밋돼.

## 규칙 (`sim.json`)

| 항목 | 기본값 | 뜻 |
|---|---|---|
| `startingCashUsd` | 10,000 | 가상 시작 자금 |
| `positionPct` | 10 | 한 번 진입할 때 쓰는 자금 비율 (리스크) |
| `maxOpenPositions` | 2 | 동시에 들고 있을 수 있는 종목 수 (리스크) |
| `feePct` | 0.3 | 살 때와 팔 때 각각 내는 DEX 수수료 |
| `slippagePct` | 0.2 | 살 때는 비싸게, 팔 때는 싸게 체결되는 정도 |
| `stopLossPct` | 3 | 진입가 대비 -3%면 손절 |
| `stopConfirmTicks` | 2 | 손절선 아래에 2틱 연속 있어야 손절해. 얇은 풀에서 한 틱만 찍히는 가짜 급락을 거르는 장치야 |
| `takeProfitPct` | 5 | 진입가 대비 +5%면 익절 |
| `maxHoldMin` | 20 | 20분이 지나면 무조건 청산 |

사고팔 때 드는 비용은 왕복 약 1%(수수료 0.3% × 2 + 슬리피지 0.2% × 2)야. 그래서 가격이 1% 넘게 움직여야 본전이야.

## 체결 방식

- 신호가 나온 **다음 틱** 가격으로 진입해. 신호를 보고 주문하는 데 걸리는 시간을 반영한 거야.
- 청산 이유는 이렇게 표시돼.

| 이유 | 뜻 |
|---|---|
| `TAKE_PROFIT` | 익절선에 닿음 |
| `STOP_LOSS` | 손절선 아래에 2틱 연속 있었음 |
| `TIME` | 최대 보유 시간이 지남 |
| `LIQ_DROP` | 유동성 급감 플래그가 뜸 (러그 의심) |
| `DATA_GAP` / `DATA_END` | 수집이 끊겨서 마지막으로 본 가격에 정리함 |

`DATA_GAP`과 `DATA_END`는 `complete: false`로 표시하고, 승률이나 평균 손익 계산에서 빼. 규칙이 아니라 수집이 끊겨서 끝난 거래라서야.
