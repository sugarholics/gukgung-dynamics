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
| `computeNockFromStringConstraint` | 원-원 교점으로 nock 위치 결정 | dynamics 섹션 |
| `initLumpedMassArrow` | 12노드 체인 초기화 | dynamics 섹션 |
| `computeBendingForces` | 에너지 구배 기반 이산 굽힘력 | dynamics 섹션 |
| `enforceDistanceConstraints` | SHAKE 거리 구속 (30회 반복) | dynamics 섹션 |
| `computeRestContactForce` | rest 일방향 페널티 접촉 | dynamics 섹션 |
| `stepLumpedMass` | Störmer-Verlet 1스텝 (분리 후 전용) | dynamics 섹션 |
| `computeFreeFreeModeshapes` | 자유-자유 보 모드형상 1~3차 | dynamics 섹션 |
| `computeModalAmplitudes` | lumped→모달 투영 | dynamics 섹션 |
| `simulateRelease` | **마스터 함수** — 활채 ODE + 시위 구속 + 화살 | dynamics 섹션 |
| `computeModalArrowShape` | Phase 2 모달 형상 계산 | dynamics 섹션 |

## 핵심 물리

### 결합 시스템 (대안 2: 근본 해결)

```
활채 ODE:  m_eff × q̈ = -F_restore(q)
시위 구속: |nock - anchorTop(q)| = L_upper, |nock - anchorBot(q)| = L_lower
Nock 위치: 원-원 교점 (해석적)
화살 힘:   F = T(q) × (e_upper + e_lower)     ← Fx, Fy 모두
분리:      |F_lateral| > nockClipForce(3N)
```

- Nock은 시위의 고정 위치에 끼워짐 (슬라이드 불가)
- L_upper, L_lower는 만작 시점의 값으로 고정
- T는 현재 정적 T(q)를 사용 (동적 T 도출은 TODO)

### 에너지 효율 (Klopsteg)

```
η = m_arrow / (m_arrow + m_virtual) ≈ 0.43  (25g 화살)
m_virtual ≈ 0.033 kg
```

**eta = 0.82는 삭제됨.** computeVibrationParams에서 여전히 참조하지만, simulateRelease에서는 사용 안 함.

### 시간 단위

- dt = 0.01ms (10μs), Verlet 안정 한계 0.26ms의 1/26
- Phase 1 저장 간격: 0.1ms (매 10스텝)
- 조그셔틀 표시: 0.01ms / 0.1ms / 10ms 3단

## 수정 작업 체크리스트

1. **물리 수정 시**: `docs/arrow-physics.md`의 해당 섹션도 업데이트
2. **Grep으로 함수 위치 확인** 후 Read — 줄 번호 변동이 큼 (~3000줄 파일)
3. **빌드 후 테스트**: `node build_html.js` → 브라우저에서 발시 실행
4. **발시 버튼 클릭 주의**: MCP find/click이 React synthetic event를 못 트리거할 수 있음.
   React props에서 직접 onClick 호출 필요:
   ```javascript
   const pk = Object.keys(btn).find(k => k.startsWith('__reactProps'));
   if (pk && btn[pk].onClick) btn[pk].onClick();
   ```
5. **디버그 전역변수**: `window.__DEBUG_RELEASE` — simulateRelease 결과
6. **에너지 검증**: `E_stored`, `KE_arrow = 0.5 × m × vx²`, η 확인

## 검증 기준

| 항목 | 정상 범위 | 비정상 시 |
|------|---------|---------|
| v_arrow (CoM vx) | 35~45 m/s | T 계산 또는 에너지 전달 문제 |
| CoM vy | < 2 m/s | 운동량 비보존 — 힘 분배 확인 |
| 모달 A1 | 3~8 mm | on-string 횡변위 과다 |
| xRange (화살 길이) | 0.815~0.820 m | SHAKE 실패 — 반복 횟수 증가 |
| t_separation | 8~16 ms | 분리 조건 검토 |
| Rest contactCount | 0 또는 1 | ≥2 = 재접촉 에러 |
| Spine 검증 | 입력 = 역산 | AMO 공식 오류 |

## 현재 상태 (2026-04-02)

**동작 확인됨:**
- 활채 q 감소, 시위 분리 자동 감지, 모달 전환, 조그셔틀 3단

**남은 과제:**
- v_arrow = -19.1 (예상 ~37) → T 동적 계산 필요
- CoM vy = +9.17 → 원-원 교점 초기 y 불연속 보정
- 모달 A1 = 81.7mm → on-string 감쇠 강화

## 자주 발생하는 실수

1. **nock 위치 구속 vs 힘 적용 혼동**: nock을 `x[0] = nockX`로 구속하면 에너지 주입/소산 발생. 현재는 원-원 교점 투영 사용.
2. **SHAKE 반복 부족**: 4회 → 체인 전파 불완전. 최소 N×2 = 24회 필요.
3. **θ 클램핑 미적용**: 대각도 굽힘력이 발산 → |θ| ≤ 0.25 rad 제한 필수.
4. **시위력 분배 방식**: nock 노드에만 전체 시위력 적용 → 84,000 m/s² 가속 → 체인 붕괴. 현재는 nock 위치 투영 + 나머지 노드 SHAKE 전파.
5. **분리 후 lumped-mass 장시간 실행**: 분리 후 0.5ms 이내에 모달로 전환 필수 (stiff ODE 발산).
