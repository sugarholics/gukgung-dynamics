---
name: asymmetric-limb
description: "상하채 비대칭 탄성 시뮬레이션 스킬. 윗장/아랫장 강성비 조절, 비대칭 솔버, nockY 수직 균형 등을 수정할 때 사용. '상채가 더 뻣뻣해', '비대칭', 'limbAsymmetryRatio', 'nockY 균형', '상하채 분리', 'dual beam' 등의 요청에서 이 스킬을 사용할 것."
---

# 상하채 비대칭 탄성 스킬

## 개요

`limbAsymmetryRatio` 파라미터로 하채(아랫장) EI를 상채(윗장) 대비 스케일링한다.
- ratio = 1.0: 대칭 (기본값)
- ratio < 1.0: 하채가 더 유연 (아랫장이 더 많이 휨)
- ratio > 1.0: 하채가 더 강성 (윗장이 더 많이 휨)
- 유효 범위: 0.8 ~ 1.5

## 핵심 파라미터

| 파라미터 | 기본값 | 범위 | 물리적 의미 |
|---------|--------|------|----------|
| `limbAsymmetryRatio` | 1.0 | 0.8~1.5 | 하채 EI / 상채 EI 비율 |

## 비대칭 모델 함수 체인

```
limbAsymmetryRatio (params)
    ↓
getBeamProfile(sHalf, params, limbSide)     ← limbSide='upper'|'lower'
    ↓                                          lower이면 EI × limbAsymmetryRatio
generateFullBeam(params, kappaLoadFn, limbSide)
    ↓
computeRestShape(params)
    → beamUpper (상채, +y 방향)
    → beamLower (하채, -y 방향, 독립 적분)
    ↓
computeBowStateWithTension(params, T, forcePoint, options)
    → dual beam: beamUpper + beamLower 각각 계산
    → forcePointMirrored = {x: forcePoint.x, y: -forcePoint.y}  ← 하채 부호 반전
    ↓
solveBrace(params)
    → 외부: T 이분법
    → 내부: nockY 수직 균형 반복 (상하채 비대칭 시 nockY ≠ 0)
    ↓
computeStringLength(params, state, nockX)
    → 상채/하채 독립 감김 판정 (doraeTop / doraeBottom 각각)
    ↓
solveDraw(params, targetNockX, braceResult)
    → 상하채 각각의 anchor에서 F_draw 역산
    → F_draw = T × (sin(θ_upper) + sin(θ_lower))
    ↓
generateBowGeometry(params, drawAmount)
    → beamUpper + beamLower 독립 조립
    → limbPoints = [...beamUpper.points.reverse(), ...beamLower.points]
```

## 함수별 비대칭 수정 상세

### getBeamProfile(sHalf, params, limbSide)

```js
// limbSide 추가 인자로 하채 EI 스케일링
function getBeamProfile(sHalf, params, limbSide = 'upper') {
  const ratio = (limbSide === 'lower') ? (params.limbAsymmetryRatio ?? 1.0) : 1.0;
  const EI_base = E * w * Math.pow(h, 3) / 12;
  return { EI: EI_base * ratio, h, w, kappa0 };
}
```

- `limbSide`가 없으면 'upper' 기본값 (하위 호환)
- 줌통 구간(|s| < gripHalfLength)에서는 ratio 미적용 (줌통은 항상 대칭)

### generateFullBeam(params, kappaLoadFn, limbSide)

```js
// limbSide를 getBeamProfile에 그대로 전달
function generateFullBeam(params, kappaLoadFn, limbSide = 'upper') {
  // ... 루프 내부에서:
  const profile = getBeamProfile(s, params, limbSide);
  // ...
}
```

### computeRestShape(params)

대칭 버전과 달리 상하채를 독립적으로 생성:

```js
const beamUpper = generateFullBeam(params, () => 0, 'upper');
const beamLower = generateFullBeam(params, () => 0, 'lower');
return { beamUpper, beamLower, ... };
```

### computeBowStateWithTension(params, T, forcePoint, options)

핵심: 하채는 forcePoint의 y 부호를 반전하여 적분해야 올바른 굽힘 방향을 얻는다.

```js
// 상채 계산 (forcePoint 그대로)
const stateUpper = computeBowStateWithTension(params, T, forcePoint, { limbSide: 'upper' });

// 하채 계산 (y 반전)
const forcePointMirrored = { x: forcePoint.x, y: -forcePoint.y };
const stateLower = computeBowStateWithTension(params, T, forcePointMirrored, { limbSide: 'lower' });
// stateLower.beam.points의 y 좌표를 다시 반전하여 실제 -y 위치로 복원
```

**주의**: 하채 적분 후 점들의 y 좌표를 부호 반전해야 화면에서 올바르게 표시된다.

### solveBrace(params)

비대칭 시 nock 수직 위치(nockY)가 0이 아닐 수 있다. 내부 반복에 nockY 균형 추가:

```js
// 외부: T 이분법 (brace height 맞춤)
// 내부: nockY 반복 (상하채 수직력 균형)
//   ΔF_y = T × (sin(θ_upper_y) - sin(θ_lower_y))  → 0이 되도록 nockY 조정
//   3~5회 반복으로 수렴
```

### computeStringLength(params, state, nockX)

`nockY`를 추가 인자로 받아 상하채 감김 판정에 반영:

```js
// 상채: nockPoint = {x: nockX, y: nockY}
// 하채: nockPoint = {x: nockX, y: nockY}  (동일 nock점 사용)
// 각각 doraeTop, doraeBottom 모드 독립 판정
```

### solveDraw(params, targetNockX, braceResult)

비대칭 당김력 합산:

```
F_draw = T × sin(θ_upper) + T × sin(θ_lower)
       = T × [(nockX - anchorTopX) / dist_upper + (nockX - anchorBotX) / dist_lower]
```

상하 anchor 위치가 다르므로 각 각도를 독립 계산.

### generateBowGeometry(params, drawAmount)

```js
// 상채와 하채를 독립 계산 후 조립
const upperResult = computeBowStateWithTension(params, T, fp, { limbSide: 'upper' });
const lowerResult = computeBowStateWithTension(params, T, fpMirrored, { limbSide: 'lower' });

// limbPoints 조립: 상채 역순 + 하채
const limbPoints = [
  ...upperResult.beam.points.slice().reverse(),
  ...lowerResult.beam.points.map(p => ({...p, y: -p.y}))
];
```

반환값에 `beamUpper`, `beamLower`, `doraeTop`, `doraeBottom`, `yangyangiTop`, `yangyangiBottom` 포함.

## 검증된 물리량 (비대칭 테스트, 2026-04-07)

| limbAsymmetryRatio | brace nockY | draw nockY | F_draw | 비고 |
|-------------------|------------|-----------|--------|------|
| 0.8 (하채 약함) | -1.61mm | +27.4mm | 310N | nockY 크게 상방 편향 |
| 0.9 | -0.39mm | +12.8mm | 326N | |
| **1.0 (대칭)** | **0.00mm** | **0.00mm** | **344N** | **기본값** |
| 1.1 (하채 강함) | +0.32mm | -11.6mm | 362N | nockY 하방 편향 |
| 1.2 | +1.11mm | -22.3mm | 381N | |
| 1.3 | +2.17mm | -32.3mm | 400N | 솔버 안정 한계 근접 |

**nockY 자기일관 루프**: solveBrace에서 2-3회 반복으로 비대칭 활의 nockY를 자동 결정.

## 디버깅 가이드

### 비대칭 관련 흔한 문제

1. **nock이 한쪽으로 쏠림**: nockY 균형 반복이 수렴하지 않는 경우.
   - `window.__DEBUG_nockY` 로 nockY 수렴 과정 확인
   - relaxation을 0.3으로 낮춰볼 것

2. **하채가 반대 방향으로 휨**: forcePointMirrored 적용 누락.
   - `computeBowStateWithTension` 호출 시 limbSide='lower'에 y 반전 확인

3. **감김 모드 불일치**: 상채는 'dorae', 하채는 'direct'인 경우 시위 길이 계산 오류.
   - `computeStringLength`가 상하채 모드를 독립적으로 반환하는지 확인
   - 총 시위 길이 = upper 구간 + lower 구간

4. **비대칭 ratio 범위 초과**: ratio > 1.5 또는 < 0.8이면 솔버 수렴 불안정.
   - UI 슬라이더에 clamp 적용 권장

5. **줌통 구간 비대칭 적용 오류**: 줌통(그립)은 항상 대칭이어야 함.
   - `getBeamProfile`에서 `|s| < gripHalfLength` 구간은 ratio=1.0 강제

### 디버그 전역변수 패턴

```js
window.__DEBUG_asymmetry = {
  nockY, T_brace, ratio,
  braceUpper, braceLower,
  doraeTop, doraeBottom
};
```

## 수정 작업 체크리스트

1. `getBeamProfile` 시그니처에 `limbSide` 추가 여부 확인 (Grep으로 검색)
2. `generateFullBeam` 호출부 전체에서 limbSide 인자 전달 확인
3. `computeRestShape`가 beamUpper/beamLower 독립 생성하는지 확인
4. `solveBrace` 내부 nockY 반복 로직 포함 여부 확인
5. `generateBowGeometry` 반환 객체에 beamUpper/beamLower 포함 여부 확인
6. 빌드 후 ratio=1.0에서 기존 검증값(15.0cm, 519N)과 일치하는지 반드시 확인
