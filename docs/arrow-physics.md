# 화살 발시 동역학 — 물리 분석 및 설계 근거

## 1. 목적

국궁 개량궁의 발시(發射) 과정을 물리적으로 시뮬레이션한다.
"발시" 버튼 → 사전 계산 → 조그셔틀로 0.01ms 단위 탐색.

**보여주려는 것:**
- 시위가 풀리면서 활채가 복원되는 과정
- 화살이 시위에 밀려 가속하면서 휘는 현상 (archer's paradox)
- 화살이 rest에 올라가 있다가 이탈하는 접촉 역학
- nock 클립에서 화살이 분리되는 순간
- 분리 후 화살의 자유 진동 (모달)

---

## 2. 물리 모델 구조

### 2.1 상태 변수

```
활채: q(t), q̇(t)                    — 1-DOF 유효 변위 (brace=0, 만작=q_max≈0.6m)
화살: {x_i, y_i, vx_i, vy_i}_{i=0..11}  — 12 lumped-mass 노드
T(t)                                  — 시위 장력 (구속에서 도출)
```

### 2.2 활채 1-DOF 모델

활채를 단일 자유도 진동계로 근사:

```
m_eff × q̈ = -F_restore(q) - c × q̇
```

| 파라미터 | 값 | 근거 |
|---------|-----|------|
| m_eff | 0.042 kg | 2×(0.20×m_limb + m_siyah) + m_string/3 |
| m_limb_each | 0.050 kg | FRP/카본 활채 |
| m_siyah_each | 0.010 kg | 고자(뿔) |
| m_string | 0.005 kg | 합사 시위 |
| 0.20 계수 | | 활채 1차 모드 유효질량 (tapered cantilever, 보정) |
| 1/3 계수 | | 시위 기본 모드 유효질량 |

**왜 1-DOF로 충분한가:**
- 화살 접촉 기간(~10ms) 동안 활채 1차 모드가 에너지의 95%+ 지배
- 활채 1차 주파수 ~25Hz (주기 40ms), 화살 접촉 시간 < 20ms → 반주기 미만
- 고차 모드 (~100Hz, ~200Hz)는 분리 후에만 중요

**F_restore(q) 테이블:**
- `preSampleBowAnchors(params, 31)`로 drawAmount 0~1의 31개 점에서 `generateBowGeometry` 호출
- 각 점에서 `F_draw`, `nockX`, 앵커 위치, 시위 장력 추출
- `q = nockX - nockX_brace`로 변환
- 시뮬레이션 중 `interpolateBowByQ(samples, q)`로 보간

### 2.3 시위 비신장 구속

시위 모델:
- **비신장 (inextensible)**: 총 길이 L_string = const
- **무질량**: 시위 질량은 m_eff에 합산 (1/3 규칙)
- **무굽힘**: 시위는 직선 세그먼트

**왜 무질량이 유효한가:**
- 시위 파동 전파 속도: c = √(T/μ) = √(200/0.0046) ≈ 208 m/s
- 전파 시간 (반 시위): 0.54m / 208 = 2.6ms
- 발시 시간 ~15ms → 전파 시간은 발시 시간의 ~17%
- 준정적 가정이 1차 근사로 유효

**Nock 위치 결정 — 원-원 교점:**

Nock은 시위의 **고정된 위치**에 끼워져 있어 상하로 슬라이드하지 못한다.
시위를 nock 기준으로 상현(L_upper)과 하현(L_lower)으로 분리.

```
|nock - anchorTop| = L_upper (상수)
|nock - anchorBot| = L_lower (상수)
```

두 원의 교점으로 nock 위치가 유일하게 결정:

```
d = |anchorTop - anchorBot|
a = (L_upper² - L_lower² + d²) / (2d)
h = √(L_upper² - a²)
nock = midpoint ± h × perpendicular
```

궁사 쪽(+x) 교점을 선택.

### 2.4 화살 Lumped-Mass 체인

12 노드, Störmer-Verlet 적분, dt = 0.01ms (10μs)

**굽힘력 — 에너지 구배법:**

```
E_bend = Σ EI/(2ds) × θ_i²

dE/dr_a = -EI×θ/(ds×L1) × perp(e1)     [node i-1]
dE/dr_c = -EI×θ/(ds×L2) × perp(e2)     [node i+1]
dE/dr_b = -(dE/dr_a + dE/dr_c)           [node i, Newton 3rd law 보장]
```

**곡률 제한:** |θ| ≤ 0.25 rad (14.3°) — 대각도 발산 방지

**SHAKE 거리 구속:** 30회 반복, 질량 가중 보정

**고주파 감쇠:** Laplacian velocity smoothing (α = 0.05)

### 2.5 접촉 역학

**Rest 접촉 (일방향 페널티):**
```
gap = y_node - y_rest
F_rest = k_rest × max(0, -gap)     k_rest = 5000 N/m
```
- 감쇠: `F_damp = -50 × v_y` (접촉 중만)
- 접촉 전이 추적: FREE→CONTACT 횟수 카운트
- 재접촉(≥2회) = 에러 (불안정 세팅)

**Nock 클립 분리:**
```
F_lateral = |F_string · n_perpendicular_to_string|
if F_lateral > nockClipForce (기본 3N) → 분리
```
- 축방향(시위 방향)은 자유 전달 → 분리에 기여하지 않음
- 횡력만 클립을 벌림

### 2.6 모달 전환 (Phase 2)

분리 후 0.5ms 이내에 lumped-mass → 모달 전환:

**자유-자유 보 모드형상:**
```
φ_k(s) = cosh(β_k s) + cos(β_k s) - σ_k[sinh(β_k s) + sin(β_k s)]
```

| 모드 | β_k×L | 주파수 (tip mass 포함) | 감쇠비 |
|------|-------|---------------------|--------|
| 1차 | 4.730 | 57.8 Hz | 0.01 |
| 2차 | 7.853 | 177 Hz | 0.01 |
| 3차 | 10.996 | 362 Hz | 0.01 |

**투영:**
```
q_k = Σ m_i × u_i × φ_k(s_i) / M_k
A_k = √(q_k² + (q̇_k/ω_k)²)
```

**비행 중 형상:**
```
w(x,t) = Σ A_k × e^{-ζω_k t} × sin(ω_k t + φ_k) × φ_k(x)
```

---

## 3. 에너지 분석 (Klopsteg)

### 3.1 효율

```
η = m_arrow / (m_arrow + m_virtual)
```

| 항목 | 값 | 근거 |
|------|-----|------|
| m_arrow | 0.025 kg | 화살 총 질량 |
| m_virtual | 0.033 kg | 활채+siyah+시위 가중합 |
| **η** | **0.43** | 25g 화살 기준 |

**기존 코드의 η = 0.82는 틀렸다.** 국궁의 가벼운 화살(25g)과 무거운 활채(100g+siyah 20g)의 질량비가 불리하다.

### 3.2 에너지 배분

```
E_stored ≈ 35~50 J (F_draw × nockX 적분)

E_arrow = η × E_stored ≈ 17~22 J → v_arrow ≈ 37~42 m/s
E_limb  = (1-η) × E_stored ≈ 20~29 J → v_limb_tip ≈ 34 m/s
E_vib   = 2~5% (화살 모달 진동)
```

---

## 4. 시간 스케일

| 사건 | 시간 | 근거 |
|------|------|------|
| 활채 1/4 주기 | ~10ms | T₀/4 = 1/(4×25Hz) |
| 화살-시위 접촉 시간 | 8~16ms | m×v/F_avg |
| 화살 1차 모드 반주기 | 8.6ms | 1/(2×58Hz) |
| Rest 이탈 | 3~5ms | 1차 모드 1/4 주기 |
| Verlet 안정 한계 | 0.26ms | √(m×ds³/EI) |
| 시뮬레이션 dt | 0.01ms | 안정 한계의 1/26 |

---

## 5. 화살 파라미터 (Spine 기반)

### 5.1 AMO 정적 스파인 → EI

```
EI = P_test × L_test³ / (48 × δ_test)
P_test = 8.63 N (1.94 lbf)
L_test = 0.7112 m (28")
δ_test = spine × 2.54e-5 m
```

| Spine | EI (N·m²) | 궁력 (#=lbf) |
|-------|-----------|-------------|
| 500 | 5.09 | 35#~45# |
| 700 | 3.64 | 20#~30# |
| 1000 | 2.55 | ~20# |

### 5.2 기본 화살 (DEFAULT_PARAMS)

| 파라미터 | 기본값 | 범위 |
|---------|--------|------|
| arrowLength | 0.82 m | 0.70~0.90 |
| arrowMass | 25 g | 20~35 |
| arrowTipMass | 8 g | 3~15 |
| arrowSpine | 700 | 300~1200 |
| nockClipForce | 3 N | 1~5 |

---

## 6. 활 파라미터 교정

기존 활이 비현실적으로 강했음. 교정 후:

| 파라미터 | 기존 | 교정 | 근거 |
|---------|------|------|------|
| elasticModulus | 45 GPa | **22 GPa** | FRP 복합재 현실값 |
| limbThickness | 12 mm | **8 mm** | EI ∝ t³ |
| maxDraw | 80 cm | **75 cm** | 국궁 표준 |
| gripAngle | 10° | **8°** | 완만한 리커브 |
| gripStiffnessRatio | 15 | **25** | 줌통 강성 |

**교정 결과:**
- EI(활채 근부): 181 → **26.3 N·m²** (7배 감소)
- F_draw(만작): ~3300N → **~313N (32kgf)**
- Brace height: 15.0cm (유지)

---

## 7. Rest 접촉 시나리오

활/화살 세팅에 따라 3가지 거동:

**A. 부드러운 이탈 (lift-off):**
- 시위 횡력이 위쪽이거나 1차 모드로 rest에서 자연 이탈
- 잘 튜닝된 세팅

**B. 1회 충돌 후 이탈 (bounce):**
- 시위 횡력이 아래쪽 → rest를 치고 반발
- 현실에서 흔한 케이스

**C. 반복 충돌 (multiple bounces) → 에러:**
- 스파인 너무 유연하거나 rest 위치 안 맞음
- contactCount ≥ 2 → 시뮬레이션 에러 표시

---

## 8. 구현 아키텍처

### 8.1 데이터 흐름

```
preSampleBowAnchors(31 samples)
  → {drawAmount, q, nockX, anchorTop/Bot, T, F_draw, L_upper, L_lower}
                    ↓
simulateRelease(dt=0.01ms)
  ┌──────────────────────────────────────────┐
  │ 매 스텝:                                  │
  │  1. 활채 ODE: q̈ = -F_restore(q) / m_eff  │
  │  2. 원-원 교점 → nock 위치 결정            │
  │  3. F_nock = T × (e_upper + e_lower)      │
  │  4. 화살 Verlet: bending + gravity + rest  │
  │  5. 분리: |F_lateral| > F_clip?            │
  └──────────────────────────────────────────┘
                    ↓
  phase1Frames[] + phase2Data (모달)
                    ↓
  조그셔틀 재생 (0.01ms / 0.1ms / 10ms)
```

### 8.2 Phase 전환

| Phase | 기간 | 모델 | 화살 렌더 |
|-------|------|------|---------|
| Phase 1 (on-string) | 0~분리 | lumped-mass | TubeGeometry polyline |
| Phase 1→2 전환 | 분리+0.5ms | 모달 투영 | - |
| Phase 2 (free flight) | 분리~∞ | 모달 중첩 | TubeGeometry polyline |

---

## 9. 현재 검증 상태 (2026-04-02)

### 9.1 동작 확인

- [x] 활채 q 감소 (만작→brace 방향): 0.600→0.313 in 10ms ✓
- [x] 시위 분리 자동 감지: t_sep ≈ 16ms ✓
- [x] 재접촉 에러 없음 ✓
- [x] 모달 주파수 57.8 Hz ✓
- [x] 시뮬레이션 시간 174ms ✓

### 9.2 남은 과제

| 문제 | 현재값 | 예상값 | 원인 |
|------|--------|--------|------|
| v_arrow | -19.1 m/s | ~37 m/s | T를 정적 T(q) 사용 → 동적 T 필요 |
| CoM vy | +9.17 m/s | ~0 | 원-원 교점의 y 불연속 |
| 모달 A1 | 81.7 mm | 3~8 mm | on-string 동안 과도 횡변위 |
| yRange@5ms | 27.5 mm | ~5 mm | nock 투영 y-jump |

### 9.3 해결 방향

1. **T 동적 계산**: 정적 T(q) 대신 시위 구속에서 실제 구속력 역산
2. **원-원 교점 초기화**: 만작 시 nock 위치와 교점의 불일치 보정
3. **감쇠 강화**: on-string 동안 고주파 모드 억제
