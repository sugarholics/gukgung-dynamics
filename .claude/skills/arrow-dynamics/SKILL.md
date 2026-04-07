---
name: arrow-dynamics
description: "화살 발시 동역학 스킬. lumped-mass 체인, 활채 ODE, 시위 구속, rest 접촉, nock 클립 분리, 모달 전환 등 화살 시뮬레이션 코드를 수정할 때 사용. '화살이 이상해', '발시 시뮬레이션', '조그셔틀', 'archer's paradox', 'spine', '화살 속도', '분리 시점', '진동 모드', '에너지 보존' 등의 요청에서 이 스킬을 사용할 것."
---

# 화살 발시 동역학 스킬

## 관련 문서

- 물리 분석 및 설계 근거: `docs/arrow-physics.md` (수식, 파라미터, 검증 데이터)
- 메인 소스: `국궁_3d_모델.jsx`

## 파일 내 함수 맵

| 함수명 | 역할 | 위치 |
|-------|------|------|
| `computeArrowProperties` | Spine → EI 변환, 질량 분배 | physics 섹션 |
| `verifyArrowSpine` | AMO 역산 검증 | physics 섹션 |
| `computeArrowStaticShape` | 정적 처짐 (Euler-Bernoulli, rest+nock) | physics 섹션 |
| `preSampleBowAnchors` | 활 기하학 31점 사전 샘플 (F_draw, q, L_upper/lower) | dynamics 섹션 |
| `interpolateBowState` | drawAmount 기반 보간 | dynamics 섹션 |
| `interpolateBowByQ` | q(활채 변위) 기반 보간 | dynamics 섹션 |
| `initStringChain` | 시위 24노드 유질량 체인 초기화 (3D) | dynamics 섹션 |
| `stepStringChain` | 시위 체인 1스텝 Verlet + SHAKE | dynamics 섹션 |
| `initLumpedMassArrow` | 12노드 체인 초기화 (3D) | dynamics 섹션 |
| `computeBendingForces` | y-축 에너지 구배 이산 굽힘력 | dynamics 섹션 |
| `computeBendingForcesZ` | z-축 소각도 유한차분 굽힘력 | dynamics 섹션 |
| `enforceDistanceConstraints` | SHAKE 거리 구속 (30회 반복) | dynamics 섹션 |
| `computeRestContactForce` | rest 일방향 페널티 접촉 | dynamics 섹션 |
| `stepLumpedMass` | Störmer-Verlet 1스텝 (분리 후 전용) | dynamics 섹션 |
| `computeFreeFreeModeshapes` | 자유-자유 보 모드형상 1~3차 | dynamics 섹션 |
| `computeModalAmplitudes` | lumped→모달 투영 (y+z 분리) | dynamics 섹션 |
| `simulateRelease` | **마스터 함수** — 활채 ODE + 시위 체인 + 화살 3D | dynamics 섹션 |
| `computeModalArrowShape` | Phase 2 모달 형상 계산 (y+z) | dynamics 섹션 |
| `computeZRotationParams` | 줌손 z축 회전 관성/강성/감쇠 계산 | dynamics 섹션 |

## 핵심 물리

### 결합 시스템

```
활채 ODE:  m_coupled × q̈ = -F_restore(q) - c × q̇
시위 체인: 24노드 3D Verlet + SHAKE, 앵커+nockNode 핀
Nock 위치: nockingPoint = (nockX, nockY + nockingOffset) 보간
화살 힘:   F = T_dynamic × (e_upper + e_lower) / |...|
분리:      |F_lateral| > 3N 또는 Fx > 0
```

- m_coupled = m_eff_limb + m_arrow (Klopsteg 결합질량)
- m_eff_limb = 2×(0.123×m_limb + m_siyah) + m_string/3
- T_dynamic = |F_restore| × m_arrow / m_coupled

### y축 발사각 (impulse ratio)

```
Jy = ∫(Fy + restF.Fy - m_arrow×g) dt   ← 시위력 + rest + 중력
Jx = ∫Fx dt                              ← 시위력 x성분 (음수)
분리 시: vy_correct = vx × (Jy / Jx)     ← 부호 자동 정합
```

- nockingOffset=+50mm → Fy<0(아래) → vy<0 → 발사각 -3.77° (아래)
- nockingOffset=0 → vy=-0.18 (중력만, ≈-g×t)

### z축 모델

```
줌손 z회전:  I_z × θ̈_z = M_wrist - k_z(T) × θ_z - c_z × θ̇_z
엄지 횡력:   F_thumb = thumbReleaseForce × exp(-t/1ms), +z 방향
활채 z접촉:  줌통 ±6cm에서 z > -limbWidth/2 시 페널티
```

### 조준 + pushAngle

```
aimAngleY: 조준 앙각 (°) → Phase 2 CoM 속도를 회전
aimAngleZ: 조준 횡각 (°) → Phase 2 z-탄도
pushAngleY = atan2(-gripOffsetY, armLength) → 아랫장집기 4cm ≈ +3.1°
총 보정 = aimAngleY + pushAngleY → CoM 속도 회전 후 탄도 계산
```

### 시간 단위

- dt = 0.01ms (10μs), Verlet 안정 한계 0.26ms의 1/26
- Phase 1 저장 간격: 0.1ms (매 10스텝)
- 조그셔틀 표시: 0.01ms / 0.1ms / 10ms 3단

## 수정 작업 체크리스트

1. **물리 수정 시**: `docs/arrow-physics.md`의 해당 섹션도 업데이트
2. **Grep으로 함수 위치 확인** 후 Read — 줄 번호 변동이 큼 (~3000줄 파일)
3. **빌드 후 테스트**: `node build_html.js` → `window.__enterJogMode(DEFAULT_PARAMS)` 또는 발시 버튼
4. **디버그 전역변수**: `window.__DEBUG_RELEASE` — simulateRelease 결과
5. **조그 진입**: `window.__enterJogMode(params)` — 즉시 진입, `window.__setJogTime(t)` — 프레임 이동
6. **에너지 검증**: `E_stored`, `KE_arrow = 0.5 × m × v²`, η, `KE_vy_correction`

## 검증 기준

| 항목 | 정상 범위 | 비정상 시 |
|------|---------|---------|
| v_arrow (CoM vx) | 35~45 m/s | T 계산 또는 에너지 전달 문제 |
| CoM vy | -5~+5 m/s | impulse ratio 부호/크기 확인 |
| paradox A1z | 0.3~3 mm | 엄지 횡력/활채 z접촉 확인 |
| xRange (화살 길이) | 0.815~0.820 m | SHAKE 실패 — 반복 횟수 증가 |
| t_separation | 15~25 ms | 분리 조건 검토 |
| η (Klopsteg) | 0.33~0.45 | m_eff 계수 또는 에너지 전달 문제 |
| CoM 위치(만작) | x≈0.23m | 질량 분배 확인 |

## 현재 상태 (2026-04-06)

**동작 확인됨:**
- v_arrow = -41.09 m/s (Klopsteg η = 0.372, m_eff 계수 0.17) ✓
- CoM vy = -2.71 m/s (impulse ratio, nockingOffset=50mm) ✓
- 발사각 = -3.77° (아래, 물리적 올바름) ✓
- CoM vz = -0.76 m/s (활채 폭 + 엄지 횡력) ✓
- paradox A1z = 0.8 mm (Spine 700) ✓
- t_separation = 19.82 ms ✓
- CoM x(만작) = 0.233m (화살 63% 지점, tip 8g 반영) ✓
- KE_vy_correction = 91.8 mJ (0.16%) ✓
- nockingOffset=0 → vy=-0.18 ≈ -g×t ✓

**조그셔틀 시각화:**
- 녹색 CoM 구 마커 (Phase 1+2)
- 빨간 시위력 화살표 (ArrowHelper, Phase 1 only)
- HUD: 실시간 v, F, Fy 표시

## 자주 발생하는 실수

1. **SHAKE 수렴 부족으로 에너지 배분 왜곡**: on-string에서 **강체 병진 + 굽힘 섭동** 방식 사용 (SHAKE에 의존하지 않음).
2. **x_old 저장 시점 중요**: nock 투영 전에 x_old를 저장해야 nock 속도가 올바르게 계산됨.
3. **활채 ODE에 화살 질량 결합 필수**: `m_coupled = m_eff_limb + m_arrow`.
4. **impulse ratio 부호**: Jx = ∫Fx dt (음수 그대로), vy = vx × (Jy/Jx). `-Fx`로 정의하면 부호 반전 오류 발생.
5. **Phase1→Phase2 전환**: 조그셔틀에서 `jogTime <= t_sep` 기준으로 전환. `lastFrameT` 사용하면 위치 점프 발생.
6. **θ 클램핑 미적용**: 대각도 굽힘력이 발산 → |θ| ≤ 0.25 rad 제한 필수.
7. **분리 후 lumped-mass 장시간 실행**: 분리 후 0.5ms 이내에 모달로 전환 필수 (stiff ODE 발산).
