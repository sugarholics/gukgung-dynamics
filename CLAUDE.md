# 국궁 개량궁 3D 동역학 시뮬레이터

## 프로젝트 개요
한국 전통 활(국궁) 개량궁의 3D 구조-탄성 시뮬레이터.
연속 탄성체 모델(줌통 포함) + T-기반 평형 솔버 + 발시 동역학 시뮬레이션 + 조그셔틀 프레임 재생.

## 아키텍처

### 파일 구조
```
국궁 동역학/
├── 국궁_3d_모델.jsx    # 메인 React/Three.js 소스 (~3000줄)
├── index.html           # 빌드 결과 (브라우저용)
├── build_html.js        # 빌드 스크립트
├── CLAUDE.md            # 이 파일
├── docs/arrow-physics.md # 화살 물리 문서
└── .claude/
    ├── skills/          # 스킬 (physics-engine, arrow-dynamics, threejs-viz, sim-build-test, asymmetric-limb)
    ├── agents/          # 에이전트 (physics-reviewer: 물리 검증 전문가)
    └── launch.json      # dev server 설정 (npx http-server -p 8083)
```

### 빌드 프로세스
```bash
node build_html.js   # JSX → HTML 변환 (Babel in-browser 방식)
```
import문 제거, export default 제거, React/Three.js CDN 주입.

### 테스트
- `http://localhost:8083/index.html`에서 확인
- 캐시 주의: URL에 `?v=N` 쿼리 추가로 캐시 우회
- 브라우저 디버그 시 `window.__DEBUG_*` 전역변수로 값 확인 가능 (React 스코프 문제로 console.log 미작동)
- **발시 테스트**: 콘솔에서 `window.__enterJogMode(DEFAULT_PARAMS)` → 즉시 조그셔틀 진입
- **파라미터 스윕**: `window.__paramSweep()` → 48조합 nockOffset×restOffset 결과 테이블
- **시간 이동**: `window.__setJogTime(ms)` → 조그셔틀 프레임 이동

## 물리 모델 구조 (JSX 파일 내부)

### 핵심 함수 체인 — 정적 솔버

```
DEFAULT_PARAMS
    ↓
getBeamProfile(sHalf, params)          ← EI(s), κ₀(s), 두께/폭 프로파일
    ↓
generateFullBeam(params, kappaLoadFn)  ← 그립중심→활채끝 연속 적분 (줌통 포함)
    ↓
computeRestShape(params)               ← 무현 형상 (하중 없이 자연곡률만)
    ↓
computeBowStateWithTension(params, T, forcePoint, options)  ← T 기반 형상-힘 자기일관
    ↓
solveBrace(params)                     ← 기하급수 T 탐색 + 이분법 brace 평형
solveDraw(params, targetNockX, braceResult)  ← loadFactor+T 하이브리드 draw 솔버
    ↓
generateBowGeometry(params, drawAmount)      ← 전체 통합 (brace→draw→형상→접촉점)
    ↓
computeGripReaction(params, bowGeom)          ← 줌통 반력/토크/이상점 계산
    ↓
computeVibrationParams(params)               ← k_eff, E_stored, ω₀, F_draw 기반
```

### 핵심 함수 체인 — 동적 솔버 (발시 시뮬레이션)

```
preSampleBowAnchors(params, 31)        ← 활 기하학 31점 사전 샘플 + 비틂 보정
    ↓
simulateRelease(params)                ← **마스터 함수**: 활채 ODE + 시위 체인 + 화살 3D
  ├── initStringChain()               ← 시위 24노드 유질량 체인 초기화 (3D)
  ├── initLumpedMassArrow()            ← 12노드 lumped-mass chain 초기화 (3D: x,y,z)
  ├── interpolateBowByQ()             ← q(활채 변위) 기반 앵커+nockingPoint 보간
  ├── stepStringChain()               ← 시위 체인 Verlet + SHAKE (3D)
  ├── computeBendingForces()           ← y-축 에너지 구배 굽힘력
  ├── computeBendingForcesZ()          ← z-축 소각도 유한차분 굽힘력
  ├── enforceDistanceConstraints()     ← SHAKE (on-string: 2D, 자유비행: 3D)
  ├── computeRestContactForce()        ← rest 일방향 페널티 접촉
  ├── Jy/Jx impulse 적산             ← y축 발사각 보정 (중력 포함)
  ├── J_angular 적산                  ← angular impulse → 분리 시 ω₀
  └── computeModalAmplitudes()         ← lumped→모달 투영 (y+z 분리, 분리 후)
    ↓
computeModalArrowShape(phase2Data, arrowProps, t)  ← Phase 2 모달 형상 계산 (y+z, ω₀ 축 회전)
```

### 함수 상세 — 정적

| 함수명 | 역할 | 입력 → 출력 |
|-------|------|-----------|
| `getBeamProfile` | 연속 보 EI/두께/폭/자연곡률 프로파일 | (sHalf, params, limbSide?) → {EI, h, w, kappa0} |
| `generateFullBeam` | 그립중심→활채끝 연속 곡률 적분 (줌통 10 + 활채 40 분할) | (params, kappaLoadFn, limbSide?) → {points, thicknesses, widths, ...} |
| `computeRestShape` | 무현(unstrung) 기준 형상 | (params) → {beamUpper, beamLower, restPoints, siyahTop/Bottom} |
| `computeBowStateWithTension` | T 기반 형상-힘 자기일관 반복 (dual beam 지원) | (params, T, forcePoint, options?) → {beamUpper, beamLower, doraeTop, doraeBottom, ...} |
| `computeStringLength` | 시위 길이 계산 (감김/직진 모드) | (params, state, nockX) → {computedLen, mode} |
| `solveBrace` | **기하급수 T 탐색** + 이분법 brace 평형 + nockY 자기일관 | (params) → {state, T_brace, braceHeight, stringMode} |
| `solveDraw` | 하이브리드 draw 솔버 (loadFactor + T/F 역산) | (params, targetNockX, braceResult) → {state, T_draw, F_draw, ...} |
| `generateBowGeometry` | 전체 기하학 통합 | (params, drawAmount) → {limbPoints, T_current, F_draw, pullPoint, nockingPoint, ...} |
| `computeGripReaction` | 줌통 반력/토크/이상점 계산 | (params, bowGeom) → {Fx, Fy, M_grip, reactionPointY} |
| `computeVibrationParams` | 진동 파라미터 (F_draw 기반) | (params) → {omega0, omega_d, zeta, A_grip, k_eff, E_stored} |

### 함수 상세 — 동적 (발시)

| 함수명 | 역할 | 입력 → 출력 |
|-------|------|-----------|
| `computeArrowProperties` | Spine → EI 변환, 질량 분배 | (params) → {L, m_total, EI, D_outer, ...} |
| `computeArrowStaticShape` | 정적 처짐 (E-B 보, rest+nock) | (arrowProps, nockPos, restPos) → {nodes, nockAngle, ...} |
| `preSampleBowAnchors` | 활 기하학 31점 사전 샘플 + **비틂 z-보정** | (params, n) → [{drawAmount, anchorTop, anchorBot, nockingPoint, pullPoint, q, dz_anchor_twist, ...}] |
| `initStringChain` | 시위 24노드 유질량 체인 초기화 (3D) | (params, anchorTop, anchorBot, nockPos, L_upper, L_lower) → {N, ds, sx, sy, sz, svx, svy, svz, sm, nockNode, ...} |
| `stepStringChain` | 시위 체인 1스텝 Verlet + SHAKE | (state, anchorTop3d, anchorBot3d, arrowNock3d, dt) → void |
| `initLumpedMassArrow` | 12노드 체인 초기화 (3D) | (arrowProps, nockPos, restPos, z_arrow) → {N, x, y, z, vx, vy, vz, m, ...} |
| `computeBendingForces` | y-축 에너지 구배 이산 굽힘력 | (arrowState) → {fx, fy} |
| `computeBendingForcesZ` | z-축 소각도 유한차분 굽힘력 | (arrowState) → {fz} |
| `enforceDistanceConstraints` | SHAKE (on-string: 2D, 자유비행: 3D) | (state, iterations, pinnedNode) → void |
| `computeRestContactForce` | rest 일방향 페널티 접촉 | (state, restPos) → {nodeIndex, Fy, inContact} |
| `stepLumpedMass` | Störmer-Verlet 1스텝 (분리 후, 3D) | (state, bowState, restPos, dt) → void |
| `simulateRelease` | **마스터 함수**: 시위 체인 + 화살 3D 사전 계산 | (params) → {phase1Frames, phase2Data, arrowProps, samples} |
| `computeFreeFreeModeshapes` | 자유-자유 보 모드형상 1~3차 | (arrowProps) → [{omega, phi[], ...}] |
| `computeModalAmplitudes` | lumped→모달 투영 (y+z 분리) | (arrowState, arrowProps, modes) → {CoM, axisAngle, modalAmps, modalAmpsZ} |
| `computeModalArrowShape` | Phase 2 모달 형상 계산 (y+z, **ω₀ 축 회전**) | (phase2Data, arrowProps, t) → {nodes, cx, cy, cz, flightAngle} |
| `computeZRotationParams` | 줌손 z축 회전 관성/강성/감쇠 계산 | (params) → {I_z, k_z, omega_z, M_wrist, ...} |

### 좌표계
- **x축**: 수평. 양(+) = 궁사 방향 (시위 당기는 쪽). 음(-) = 과녁 방향.
- **y축**: 수직. 양(+) = 위 (상채 방향).
- **z축**: 횡방향. 양(+) = 궁사 기준 왼쪽. 음(-) = 궁사 기준 오른쪽 (화살 위치, z_arrow < 0).
- nockX는 양수 (궁사 쪽). 화살은 양(+)x에서 음(-)x 방향으로 발사.

### 3점 위치 (접촉점 오프셋)
| 점 | 좌표 | 역할 |
|----|------|------|
| pullPoint | (nockX, nockY + nockingOffset + pullOffset) | 시위 꺾임점 (엄지 위치), 정적 당김력 계산 |
| nockingPoint | (nockX, nockY + nockingOffset) | 화살 오니 위치, 시뮬 시위 구속 기준 |
| restPoint | (0, restOffsetY) | 화살걸이 위치 |

**물리 사용 구분**:
- **정적 솔버(solveDraw)**: pullPoint 기준으로 T/F_draw 계산
- **동적 솔버(simulateRelease)**: nockingPoint 기준으로 시위 L_upper/L_lower 계산
- **시위 시각적 렌더(generateStringPath)**: 정적 당김 시 nockingPoint에서 V자

### 연속 보 모델 (v2)
- 줌통+활채를 하나의 연속 보로 모델링 → C¹ 연속성 보장 (꺾임 없음)
- EI(s) 프로파일: 줌통 = limbRootEI × gripStiffnessRatio, 경계에서 코사인 보간 (±1.5cm)
- 무현 형상: 자연곡률 κ₀(s)만으로 적분 (반곡 C자 형태)
- **비대칭 모델**: `limbAsymmetryRatio`로 하채 EI를 독립 스케일링. 상하채 beamUpper/beamLower 별도 생성.
- **nockY 자기일관**: `solveBrace`에서 nockY-형상 재계산 2-3회 반복 → 비대칭 활에서 nockY ≠ 0 자동 결정

### 솔버 구조
- **solveBrace**: 기하급수 T 탐색(10→20→40→...) + 이분법(50회), 내부=형상-힘 자기일관(3회, relaxation 0.5), nockY 자기일관 루프(2-3회)
- **solveDraw**: loadFactor 이분법으로 nockX 맞춤 → T, F_draw를 기하학에서 역산

### 시위 모델 (정적)
- 양양고자(siyah 끝) → 도르래(siyah 접합부) → 자유 직선 → 반대편
- 감김 판정: 시위-당김점 직선이 도르래를 교차하면 'dorae' 모드
- 시위 렌더: **LineCurve3 구간별 직선** (CatmullRom 아님 — V자 꺾임 정확도)

### 발시 동역학 모델
- **화살**: 12노드 lumped-mass chain (x, y, z), Störmer-Verlet, dt=10μs
- **활채**: 1-DOF ODE (q=nock 변위), Klopsteg 결합질량 `m_coupled = m_eff_limb + m_arrow`
- **시위**: 24노드 유질량 체인 (3D), SHAKE 비신장 구속, 5g 균등 분배
  - on-string: 앵커+nockNode 핀, 자유 노드 Verlet+SHAKE, 렌더링 시 x,y 직선 보간
  - 분리 후: nockNode 핀 해제 → 자유 진동
  - z-힘: 체인 nockNode 양옆 노드 방향에서 추출 → archer's paradox 구동
- **nock 위치**: `interpolateBowByQ`의 nockingPoint 보간값 직접 사용 (원-원 교점 우회)
- **분리 조건**: (1) nock 횡력 > 3N 또는 (2) Fx > 0 (시위가 화살을 밀기 시작)
- **Phase 1**: on-string lumped-mass 3D, 프레임 0.1ms 간격 저장 (화살 z + stringNodes + bowRotZ + CoM + stringForce)
- **Phase 2**: 분리 후 모달 (y+z 독립 모드), axisAngle→velocityAngle 블렌딩 + **ω₀ 축 회전**
- **y축 발사각**: impulse ratio `vy = vx × (Jy/Jx)`, 중력+rest 포함. 분리 시 일괄 보정
- **angular impulse**: `J_angular = ∫(r_along × F_perp) dt` → `ω₀ = J/I_CoM` → Phase 2 축 회전
- **줌손 z축 회전**: `computeZRotationParams`로 I_z, k_z 계산. Phase 1: 동적 k_z(T_current 기반), Phase 2: k_z=0(시위 직선) + 500ms 연장 적분 → `zRotFrames`
- **엄지 이탈 횡력**: `thumbReleaseForce` × exp(-t/1ms), +z 방향 → paradox 구동. 활채 z접촉(페널티)으로 Spine 민감도 반영
- **활채 비틂(torsion)**: 정적 준정적 근사. 시위 z-오프셋 → 비틂 모멘트 → 앵커 z-편향. GJ=33.4 N·m²(등방성), 복합재 5~8
- **조그셔틀**: 발시 버튼 → `__enterJogMode(params)` → 즉시 진입. Phase1/2 전환 기준 = `t_sep`

### 조그셔틀 시각화
- **CoM 마커**: 녹색 구 (Phase 1+2)
- **시위력 화살표**: 빨간 ArrowHelper, nock 위치에서 (Fx,Fy,Fz) 방향, 크기 비례 (Phase 1 only)
- **HUD**: 하단 바에 v, F, Fy 실시간 표시
- **결과 물리량 패널**: 만작 z오프셋, 분리 시간, CoM 속도/위치, 발사각, η, A1y/z, 잔신 z회전

## 핵심 파라미터 (DEFAULT_PARAMS)

| 파라미터 | 기본값 | 물리적 의미 | 민감도 |
|---------|--------|----------|--------|
| elasticModulus | 22 GPa | FRP/카본 복합재 탄성계수 | EI에 선형 |
| limbThickness | 8 mm | 활채 두께 | **EI ∝ t³ (최고 민감)** |
| limbWidth | 28 mm | 활채 폭 | EI에 선형 |
| bowLength | 120 cm | 전체 활 길이 | 높음 |
| stringLength | 108 cm | 시위 길이 | brace height 결정 |
| maxDraw | 75 cm | 만작 거리 | 높음 |
| reflexAngle | 35° | 반곡 각도 | 무현 형태 결정 |
| siyahAngle | 55° | 고자 꺾임 각도 | 시위 감김에 영향 |
| gripAngle | 8° | 줌통 V자 각도 (3~15° 안정) | 리커브 프로파일 |
| gripStiffnessRatio | 25 | 줌통/활채 강성비 | 줌통 탄성 거동 |
| limbAsymmetryRatio | 1.0 | 하채 EI / 상채 EI 비율 (0.8~1.5) | 비대칭 굽힘, nockY 편향 |
| nockingOffset | 0.050 m | 오니 y오프셋 (시위 균형점 기준) | 화살 기울기, **발사각 결정** |
| pullOffset | -0.015 m | 당김점 y오프셋 (**nockingOffset 기준**) | 초기발사각 |
| restOffsetY | 0.003 m | 화살걸이 y오프셋 | 화살 rest 위치, 축-속도 차이 |
| gripTwistTorque | 0.3 N·m | 줌손 비틀기 토크 (빨래 짜기) | 잔신 z축 회전 |
| gripTwistDamping | 0.08 | z축 회전 감쇠비 (줌손 마찰) | 잔신 감쇠 |
| thumbReleaseForce | 5.0 N | 엄지 이탈 횡력 (+z, τ=1ms) | paradox 구동, Spine 민감도 |
| torsionalGJ | 33.4 N·m² | 활채 비틂 강성 (등방성 FRP) | 앵커 z-편향, paradox |

**검증된 물리량** (기본 파라미터):
- Brace height: 15.0 cm ✓
- T_brace: 70 N
- 만작 F_draw: 344 N (35.1 kgf)
- 저장 에너지: 56.9 J
- 화살 속도: -42.70 m/s (η=0.402, Klopsteg 동역학, m_eff 계수 0.123)
- 분리 시간: 19.07 ms (Fx>0 조건)
- y축 발사각: -3.77° (vy=-2.80 m/s, impulse ratio 보정, 아래 방향)
- z-축 paradox A1z: 0.6 mm (Spine 700)
- CoM vz: -0.76 m/s (활채 폭 + 엄지 횡력 효과)
- CoM 위치(만작): x=0.233m (화살 길이 63% 지점, tip 8g)
- 잔신 z회전: 0.53°(분리) → 7.2°(500ms) (M_wrist=0.3, k_z=0 Phase 2)
- angular impulse ω₀: 0.341 rad/s (18.8°/s)
- 비대칭 limbAsymRatio=1.1: nockY=-11.6mm, vx=-42.1 m/s

## 알려진 제한사항
1. draw 솔버에서 캔틸레버 모멘트 근사 유지 (기하학적 비선형 내부 반복은 brace에서만 적용)
2. 정적 시위는 기하학적 직선 모델 유지 (동적에서만 24노드 체인 사용)
3. 공기저항 미반영 (비행 궤적). Phase 2 블렌딩(50ms)은 깃 복원의 차수 근사
4. **y축 발사각: impulse ratio 사후 보정** — 1-DOF 모델에서 nock y가 기하학적 구속 → on-string vy≈0. 분리 시 Jy/Jx ratio로 vy 사후 보정 (중력 포함, 에너지 추가 ~0.16%). 완전 해결: 화살 y-DOF 독립 (권고사항 B)
5. m_eff 유효질량 계수 0.123 (tapered beam 모드형상 적분: h(s)=h₀(1-0.55s/L), w(s)=w₀(1-0.3s/L))
6. **활채 비틂: 정적 근사** — 동적 비틂(고유주파수 ~1kHz)은 dt=10μs에서 CFL 한계 근접. 준정적으로 충분
7. **상하채 미러링** — 하채는 상채의 y-반전으로 생성. forcePointMirrored는 올바른 좌표 변환이나, nockY 자기일관 루프가 1-2회만 반복. limbAsymmetryRatio > 1.3에서 부정확 가능

## 에이전트

### physics-reviewer (`.claude/agents/physics-reviewer.md`)
- 물리 시뮬레이션 전문가 + 국궁 전문가
- 구현 계획의 물리적 타당성, 수치해석 안정성, 국궁 사법 정합성 검증
- 검증 결과를 [PASS/WARN/FAIL] 형식으로 보고
- **이 세션에서 7회 호출**: 부호 오류 발견(FAIL→수정), gripOffsetY 분석, 미러링 한계, 비틂 GJ 보정 등

## 세션 간 주의사항

### 코드 수정
- ~3000줄 파일이므로 전체 Read 금지: offset/limit로 필요한 부분만 읽기
- Edit tool 사용 시: 반드시 먼저 Read로 정확한 텍스트 확인 후 교체
- Grep으로 함수 위치 확인 후 Read — 줄 번호 변동이 큼

### 빌드/테스트
- 빌드 후 반드시 캐시 우회 (URL `?v=N` 또는 hard reload)
- React 내부 값 디버그: `window.__DEBUG_*` 전역변수 패턴 사용
- `window.__enterJogMode(params)` — 발시 애니메이션 건너뛰고 즉시 조그셔틀 진입
- `window.__paramSweep()` — nockOffset×restOffset 48조합 발사 특성 스윕

### 발시 시뮬레이션 관련
- `simulateRelease`는 ~500ms 소요 (직접 호출 가능)
- 발시 버튼은 `__enterJogMode` 호출 → drawing 애니메이션 없음
- 조그셔틀 Phase1/2 전환 기준: `t_sep` (not `lastFrameT` — 위치 점프 방지)
- **impulse ratio 부호 주의**: `Jx = ∫Fx dt` (음수 그대로 적산). `Jx = ∫(-Fx) dt`로 하면 부호 반전 오류

### 세션 경험에서 얻은 교훈
1. **Fy/m_total 전체 노드 분배 → 과도한 변위**: nock 구속과 이중 계산됨. impulse ratio 사후 보정이 올바른 접근
2. **Phase1→Phase2 전환**: `lastFrameT` 기준이면 ~20mm 점프. 반드시 `t_sep` 기준
3. **gripOffsetY**: 개량궁(gripStiffnessRatio=25)에서 효과 0.02mm — 무시 가능. 나무활에서는 5~25배 증가
4. **상하채 미러링**: `forcePointMirrored.y = -forcePoint.y`는 올바른 좌표 변환. 결합 솔버 불필요
5. **GJ 추정**: 이전 reviewer의 13 N·m²는 과소. 등방성 FRP 보정값 33.4 N·m²
6. **drawing 애니메이션**: setDrawAmount 매 프레임 → generateBowGeometry 재계산 → rAF 병목. 제거하고 즉시 진입이 최선
