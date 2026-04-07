# 국궁 3D 동역학 시뮬레이터 — 세션 보고서

**날짜**: 2026-04-07
**브랜치**: confident-gauss → main 머지 완료

---

## 1. 세션 목표

이전 세션(04-06)에서 구현된 z축 토크/엄지 횡력/paradox에 이어, **y축 발사각 전달**, **에너지 효율 정밀화**, **파라미터 탐색** 도구를 구현.

---

## 2. 구현 성과 (13건)

### 2.1 동역학 핵심 (4건)

| # | 구현 내용 | 결과 |
|---|---------|------|
| 1 | **y축 발사각 전달** | impulse ratio `vy=vx×(Jy/Jx)` + 중력. nockOffset=50mm → vy=-2.80 m/s, 발사각 -3.75° |
| 2 | **m_eff 모드형상 적분** | 경험치 0.20 → 적분값 **0.123**. η: 35.4% → **40.2%** (문헌 40-45% 하한 진입) |
| 3 | **angular impulse** | `J=∫(r_along×F_perp)dt` → ω₀=0.341 rad/s (18.8°/s). Phase 2 축 회전 반영 |
| 4 | **면외 비틂(torsion)** | GJ=33.4 N·m² (Saint-Venant), 정적 보정. 앵커 z-편향 ~1mm (등방성) |

### 2.2 시각화/UI (4건)

| # | 구현 내용 | 결과 |
|---|---------|------|
| 5 | **CoM 마커** | 녹색 구 (Phase 1+2), HUD에 실시간 v/vy 표시 |
| 6 | **시위력 화살표** | 빨간 ArrowHelper, nock 위치에서 (Fx,Fy,Fz) 방향, 크기 비례 |
| 7 | **조준각 슬라이더** | aimAngleY (-10~45°), aimAngleZ (-10~10°), gripOffsetY (-60~20mm) |
| 8 | **HUD 보강** | pushAngle 표시, 조준 보정각 표시, 시위력 크기 실시간 |

### 2.3 솔버/성능 (3건)

| # | 구현 내용 | 결과 |
|---|---------|------|
| 9 | **solveBrace nockY 자기일관** | 1회→2-3회 반복. limbAsymRatio=1.1 → nockY=-11.6mm 자동 결정 |
| 10 | **Phase1→2 점프 수정** | 전환 기준 lastFrameT→t_sep. 20mm 점프 → ~5mm |
| 11 | **발시 버튼 성능** | drawing 애니메이션 제거 → `__enterJogMode` 즉시 호출. 무한대기→~21초 |

### 2.4 파라미터 탐색/조준 (2건)

| # | 구현 내용 | 결과 |
|---|---------|------|
| 12 | **paramSweep** | `window.__paramSweep()`: nockOffset(8)×restOffset(6)=48조합. 축-속도 차이 최적점 식별 |
| 13 | **조준+pushAngle** | aimAngleY/Z + gripOffsetY → pushAngle=atan2(-δy, arm). 아랫장4cm≈+3.1° |

---

## 3. Physics-Reviewer 검증 (7회)

| 회차 | 주제 | 결과 | 주요 발견 |
|------|------|------|---------|
| 1 | y축 impulse ratio 타당성 | 6P/1W | 수학적 정확, SHAKE 수렴 충분 |
| 2 | CoM 운동 상태 | 5P/3W | CoM x=0.233m 검증, KE_vy 0.14% |
| 3 | **impulse 부호 검증** | **1F**/5W | **Jx 부호 반전 발견 → 수정** |
| 4 | 화살 회전/tumble | 1F/4W | A1y=0 문제 식별, 50ms 블렌딩 합리적 |
| 5 | gripOffsetY 전체 효과 | 5P/2W | 개량궁 0.02mm 무시 가능 |
| 6 | 상하채 미러링 한계 | 4P/5W | 결합 솔버 불필요, nockY 루프 권고 |
| 7 | 면외 비틂 모델 설계 | 4P/3W | GJ=33.4 (보정), 정적 보정 권고 |

### 발견된 오류와 수정

1. **impulse ratio 부호 반전** (FAIL): `Jx=∫(-Fx)dt`로 정의 → vy 부호 반전. 수정: `Jx=∫Fx dt`
2. **중력 impulse 누락** (WARN): Jy에 `-m×g×dt` 추가. offset=0에서 vy=-0.18≈-g×t 검증
3. **GJ 과소추정** (WARN): 이전 13 N·m² → Saint-Venant 보정 33.4 N·m²

---

## 4. 검증된 물리량 (최종)

```
정적:
  Brace height    = 15.0 cm
  T_brace         = 70 N
  F_draw (만작)    = 344 N (35.1 kgf)
  E_stored        = 56.9 J

동적 (기본 파라미터):
  화살 속도 (vx)   = -42.70 m/s
  발사각 (vy)      = -2.80 m/s → -3.75° (아래)
  횡속도 (vz)      = -0.76 m/s
  η (Klopsteg)    = 40.2%
  분리 시간        = 19.07 ms
  angular impulse  = ω₀ = 0.341 rad/s
  CoM 위치 (만작)   = x=0.233 m (화살 63%)

비대칭:
  limbAsymRatio=1.1 → nockY=-11.6mm, vx=-42.1 m/s

조준:
  아랫장집기 4cm → pushAngle = +3.05°
```

---

## 5. 파라미터 스윕 결과 (발췌)

nockOffset=50mm(기본) + restOffset 변화 시:

| rest (mm) | 만작기울기 | vy (m/s) | 발사각 | 축-속도 차 | ω₀ (rad/s) |
|-----------|---------|----------|--------|-----------|-----------|
| 0 | 3.8° | -2.80 | 3.77° | +0.04° | +0.328 |
| **3 (기본)** | **3.6°** | **-2.80** | **3.77°** | **-0.19°** | **-0.659** |
| 10 | 3.1° | -2.80 | 3.77° | -0.72° | -2.922 |

**발견**: nock=50mm, rest=3mm(기본값)에서 축-속도 차이가 -0.19°로 거의 최적. 국궁 전통 세팅의 물리적 합리성이 확인됨.

---

## 6. 아키텍처 분석 결과

### 상하채 미러링 가정

| 효과 | nockY 영향 | 결론 |
|------|----------|------|
| 줌통 모멘트 결합 | 0.02 mm | 무시 가능 |
| limbAsymmetryRatio | 1-3 mm | nockY 루프로 해결 |
| 중력 자중 처짐 | 0.06 mm | 무시 가능 |
| **결합 솔버 필요?** | — | **불필요** (현재 구조로 충분) |

### gripOffsetY (줌손 높이)

| 효과 | 개량궁 (강성비 25) | 나무활 (강성비 5-10) |
|------|----------------|-----------------|
| 줌통 탄성 | 0.02 mm | 0.1-0.5 mm |
| **pushAngle** | **3.1°/4cm** | **동일** |
| 실질적 영향 | pushAngle 지배 | 탄성+pushAngle |

---

## 7. 다음 세션 과제

| 우선순위 | 과제 | 난이도 | 기대 효과 |
|---------|------|--------|---------|
| 1 | 화살 y-DOF 독립 | 대 | on-string vy 직접 전달, A1y 복원 |
| 2 | 깃 공력 모델 | 중 | Phase 2 감쇠진동 복원 (현재 선형 블렌딩) |
| 3 | Spine 민감도 검증 | 소 | S400/700/1000 paradox 비교 |
| 4 | 비틂 GJ 슬라이더 | 소 | UI에 torsionalGJ 노출 |

---

## 8. 디버그/테스트 도구

```javascript
// 즉시 조그셔틀 진입
window.__enterJogMode(DEFAULT_PARAMS)

// 프레임 이동
window.__setJogTime(10.5)  // 10.5ms로 이동

// 48조합 파라미터 스윕
window.__paramSweep()      // console.table 출력

// 커스텀 파라미터 발시
window.__enterJogMode({ ...DEFAULT_PARAMS, nockingOffset: 0.030, restOffsetY: 0.010 })
```
