---
name: physics-engine
description: "국궁 물리 엔진 수정 스킬. 활채 굽힘, 시위 솔버, 탄성에너지, 진동 모델, 당김보정, 탄성중심 등 물리 계산 코드를 수정할 때 사용. '힘이 이상해', '에너지가 너무 커', '솔버 수정', '물리 모델', '빔 이론', '파라미터 변경', '당김력', '진동' 등의 요청과 물리량 계산 관련 모든 작업에서 이 스킬을 사용할 것."
---

# 국궁 물리 엔진 스킬

## 파일 구조 맵

메인 파일: `국궁_3d_모델.jsx` (~2100줄)

물리 관련 함수들의 위치와 역할 (줄 번호는 변동 가능하므로, 함수명으로 검색할 것):

| 함수명 | 역할 | 입력 → 출력 |
|-------|------|-----------|
| `getBeamProfile` | 연속 보 EI/두께/폭/자연곡률 프로파일 | (sHalf, params, limbSide?) → {EI, h, w, kappa0} |
| `generateFullBeam` | 그립중심→활채끝 연속 곡률 적분 | (params, kappaLoadFn, limbSide?) → {points, thicknesses, widths, ...} |
| `computeBowState` | 활채 형상 계산 (E-B 빔) | (params, loadFactor) → {limbPoints, dorae, yangyangi, ...} |
| `computeNockX` | 시위 nock점 위치 솔버 | (params, loadFactor) → {nockX, nockY, pullY, state, mode} |
| `computeElasticCenter` | 비대칭 탄성중심 | (params) → elasticCenterY |
| `computeBowStateWithTension` | T 기반 자기일관 반복 (dual beam 지원) | (params, T, forcePoint, options?) → {beamUpper, beamLower, doraeTop, doraeBottom, yangyangiTop, yangyangiBottom, ...} |
| `generateBowGeometry` | 전체 기하학 통합 | (params, drawAmount) → {모든 점, 각도, 3점} |
| `computeGripReaction` | 줌통 반력/토크/이상점 | (params, bowGeom) → {Fx, Fy, M_grip, reactionPointY} |
| `computeVibrationParams` | 진동 파라미터 | (params) → {omega0, zeta, k_eff, E_stored, A_grip} |
| `createVibrationState` | 3-DOF 초기 상태 | (vibParams) → state vector |
| `advanceVibration` | RK4 시간 적분 | (state, dt) → new state |

## 함수 의존 그래프

```
DEFAULT_PARAMS
    ↓
computeBowState(params, loadFactor)
    ↓
computeNockX(params, loadFactor)  ← 1D Newton solver
    ↓
generateBowGeometry(params, drawAmount)  ← 당김보정1 + 탄성중심
    ↓                    ↓
computeGripReaction    4점 계산 (nocking, pulling, rest, gripIdeal)
    ↓
computeVibrationParams  ← E_stored 사다리꼴 적분
    ↓
createVibrationState / advanceVibration  ← 3-DOF RK4
```

## 좌표계와 부호 규약

이 프로젝트에서 가장 혼란을 일으킨 부분이므로 정확히 기억할 것:

- **x축**: 양(+) = 궁사 방향 (시위 당기는 쪽). 음(-) = 과녁 방향.
- **nockX는 양수**: 솔버가 반환하는 nockX > 0. 당기면 더 커짐.
- **화살 방향**: nocking point(양x) → rest point(x≈0) → 과녁(음x). ux < 0.
- **loadFactor**: 0 = 무현(unstrung) → braceLoadFactor = 현걸이 상태 → 1 = 만작

## 핵심 수식

### 굽힘 강성 (EI)
```
EI = E × w × t³ / 12
```
- E: elasticModulus (Pa)
- w: limbWidth (m)
- t: limbThickness (m) ← **가장 민감한 파라미터 (세제곱)**

### nockX 솔버 (v5)
pullY를 고정 입력으로 사용 (y방향 퇴화 방지):
```
pullY = nockingPointY - pullingOffset  (상수)
목적함수: dist(pull, topAttach) + dist(pull, botAttach) = freeStringLength
1D Newton on nX: r = dT + dB - freeStr, dr = dxT/dT + dxB/dB
```

### 탄성에너지
```
E_stored = ∫(brace→만작) F(x) dx  (사다리꼴 적분, 20구간)
```

## 수정 작업 시 체크리스트

1. **수정 전**: `Grep`으로 함수명 검색 → 줄 번호 확인 → `Read`로 해당 부분만 읽기
2. **Edit tool**: old_string은 반드시 파일에서 직접 읽은 텍스트를 사용. 추측 금지.
3. **수정 후**: 의존하는 다른 함수에 영향 없는지 확인
4. **빌드 & 테스트**: sim-build-test 스킬 참조
5. **물리량 검증**: 알려진 값과 비교
   - 개량궁 만작 궁력: 130-200 N (13-20 kgf)
   - Brace height: 15-18 cm
   - EI 목표: 5-25 N·m²
   - 화살 속도: 40-55 m/s
   - limbAsymmetryRatio=1.0 (대칭): Brace 15.0 cm, T_brace 519 N
   - limbAsymmetryRatio=1.3 (하채 강성): Brace 15.3 cm, T_brace 577 N

## 자주 발생하는 실수

- `computeNockX`의 nX 초기값이 잘못되면 솔버가 발산함. 항상 nX > 0 범위에서 시작.
- `loadFactor`와 `drawAmount`는 다른 개념. drawAmount는 0-1 UI 값, loadFactor는 내부 빔 하중 계수.
- 당김보정1 각도가 과도하면 (>20°) 기하학이 왜곡됨. 보정 전후 좌표를 모두 확인할 것.
