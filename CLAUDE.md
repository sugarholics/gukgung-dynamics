# 국궁 개량궁 3D 동역학 시뮬레이터

## 프로젝트 개요
한국 전통 활(국궁) 개량궁의 3D 구조-탄성 시뮬레이터.
연속 탄성체 모델(줌통 포함) + T-기반 평형 솔버 + 발시 동역학 시뮬레이션 + 조그셔틀 프레임 재생.

## 아키텍처

### 파일 구조
```
국궁 동역학/
├── 국궁_3d_모델.jsx    # 메인 React/Three.js 소스 (~2500줄)
├── index.html           # 빌드 결과 (브라우저용)
├── build_html.js        # 빌드 스크립트
├── CLAUDE.md            # 이 파일
├── docs/arrow-physics.md # 화살 물리 문서
└── .claude/
    ├── skills/          # 스킬 (physics-engine, arrow-dynamics, threejs-viz, sim-build-test, asymmetric-limb)
    ├── agents/          # 에이전트 (physics-reviewer: 물리 검증 전문가)
    └── launch.json      # dev server 설정 (npx http-server -p 8082)
```

### 빌드 프로세스
```bash
node build_html.js   # JSX → HTML 변환 (Babel in-browser 방식)
```
import문 제거, export default 제거, React/Three.js CDN 주입.

### 테스트
- `http://localhost:8082/index.html`에서 확인
- 캐시 주의: URL에 `?v=N` 쿼리 추가로 캐시 우회
- 브라우저 디버그 시 `window.__DEBUG_*` 전역변수로 값 확인 가능 (React 스코프 문제로 console.log 미작동)

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
preSampleBowAnchors(params, 31)        ← 활 기하학 31점 사전 샘플
    ↓
simulateRelease(params)                ← **마스터 함수**: 활채 ODE + 시위 구속 + 화살
  ├── initLumpedMassArrow()            ← 12노드 lumped-mass chain 초기화
  ├── interpolateBowByQ()             ← q(활채 변위) 기반 앵커 보간
  ├── computeNockFromStringConstraint() ← 원-원 교점 (시위 구속)
  ├── computeBendingForces()           ← 에너지 구배 기반 이산 굽힘력
  ├── enforceDistanceConstraints()     ← SHAKE 거리 구속
  ├── computeRestContactForce()        ← rest 일방향 페널티 접촉
  └── computeModalAmplitudes()         ← lumped→모달 투영 (분리 후)
    ↓
computeModalArrowShape(phase2Data, arrowProps, t)  ← Phase 2 모달 형상 계산
```

### 함수 상세 — 정적

| 함수명 | 역할 | 입력 → 출력 |
|-------|------|-----------|
| `getBeamProfile` | 연속 보 EI/두께/폭/자연곡률 프로파일 | (sHalf, params, limbSide?) → {EI, h, w, kappa0} |
| `generateFullBeam` | 그립중심→활채끝 연속 곡률 적분 (줌통 10 + 활채 40 분할) | (params, kappaLoadFn, limbSide?) → {points, thicknesses, widths, ...} |
| `computeRestShape` | 무현(unstrung) 기준 형상 | (params) → {beamUpper, beamLower, restPoints, siyahTop/Bottom} |
| `computeBowStateWithTension` | T 기반 형상-힘 자기일관 반복 (dual beam 지원) | (params, T, forcePoint, options?) → {beamUpper, beamLower, doraeTop, doraeBottom, ...} |
| `computeStringLength` | 시위 길이 계산 (감김/직진 모드) | (params, state, nockX) → {computedLen, mode} |
| `solveBrace` | **기하급수 T 탐색** + 이분법 brace 평형 | (params) → {state, T_brace, braceHeight, stringMode} |
| `solveDraw` | 하이브리드 draw 솔버 (loadFactor + T/F 역산) | (params, targetNockX, braceResult) → {state, T_draw, F_draw, ...} |
| `generateBowGeometry` | 전체 기하학 통합 | (params, drawAmount) → {limbPoints, T_current, F_draw, pullPoint, nockingPoint, ...} |
| `computeGripReaction` | 줌통 반력/토크/이상점 계산 | (params, bowGeom) → {Fx, Fy, M_grip, reactionPointY} |
| `computeVibrationParams` | 진동 파라미터 (F_draw 기반) | (params) → {omega0, omega_d, zeta, A_grip, k_eff, E_stored} |

### 함수 상세 — 동적 (발시)

| 함수명 | 역할 | 입력 → 출력 |
|-------|------|-----------|
| `computeArrowProperties` | Spine → EI 변환, 질량 분배 | (params) → {L, m_total, EI, D_outer, ...} |
| `computeArrowStaticShape` | 정적 처짐 (E-B 보, rest+nock) | (arrowProps, nockPos, restPos) → {nodes, nockAngle, ...} |
| `preSampleBowAnchors` | 활 기하학 31점 사전 샘플 | (params, n) → [{drawAmount, anchorTop, anchorBot, nockingPoint, pullPoint, q, ...}] |
| `computeNockFromStringConstraint` | **원-원 교점**으로 nock 위치 결정 | (anchorTop, anchorBot, L_upper, L_lower) → {x, y, valid} |
| `initLumpedMassArrow` | 12노드 체인 초기화 | (arrowProps, nockPos, restPos) → {N, x, y, vx, vy, m, ...} |
| `computeBendingForces` | 에너지 구배 기반 이산 굽힘력 | (arrowState) → {fx, fy} |
| `enforceDistanceConstraints` | SHAKE 거리 구속 (30회 반복) | (state, iterations, pinnedNode) → void |
| `computeRestContactForce` | rest 일방향 페널티 접촉 | (state, restPos) → {nodeIndex, Fy, inContact} |
| `stepLumpedMass` | Störmer-Verlet 1스텝 (분리 후 전용) | (state, bowState, restPos, dt) → void |
| `simulateRelease` | **마스터 함수**: 사전 계산 | (params) → {phase1Frames, phase2Data, arrowProps, samples} |
| `computeFreeFreeModeshapes` | 자유-자유 보 모드형상 1~3차 | (arrowProps) → [{omega, phi[], ...}] |
| `computeModalAmplitudes` | lumped→모달 투영 | (arrowState, arrowProps, modes) → {CoM, axisAngle, modalAmps} |
| `computeModalArrowShape` | Phase 2 모달 형상 계산 | (phase2Data, arrowProps, t) → {nodes, cx, cy, flightAngle} |

### 좌표계
- **x축**: 수평. 양(+) = 궁사 방향 (시위 당기는 쪽). 음(-) = 과녁 방향.
- **y축**: 수직. 양(+) = 위 (상채 방향).
- **z축**: 횡방향. 양(+) = 활 우측 (화살 위치, 궁사 기준 오른쪽).
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

### 솔버 구조
- **solveBrace**: 기하급수 T 탐색(10→20→40→...) + 이분법(50회), 내부=형상-힘 자기일관(3회, relaxation 0.5)
- **solveDraw**: loadFactor 이분법으로 nockX 맞춤 → T, F_draw를 기하학에서 역산

### 시위 모델 (정적)
- 양양고자(siyah 끝) → 도르래(siyah 접합부) → 자유 직선 → 반대편
- 감김 판정: 시위-당김점 직선이 도르래를 교차하면 'dorae' 모드
- 시위 렌더: **LineCurve3 구간별 직선** (CatmullRom 아님 — V자 꺾임 정확도)

### 발시 동역학 모델
- **화살**: 12노드 lumped-mass chain (x, y), Störmer-Verlet, dt=10μs
- **활채**: 1-DOF ODE (q=nock 변위), Klopsteg 결합질량 `m_coupled = m_eff_limb + m_arrow`
- **시위 구속**: `computeNockFromStringConstraint` 원-원 교점 (비신장 무질량)
- **분리 조건**: nock 횡력 > nockClipForce (3N) 또는 q ≤ 0.005
- **Phase 1**: on-string lumped-mass, 프레임 0.1ms 간격 저장
- **Phase 2**: 분리 후 모달 (자유-자유 보 모드 1~3차), axisAngle→velocityAngle 블렌딩
- **조그셔틀**: Phase 1 프레임 재생 (시위는 jogStringRef로 직접 렌더, React 시위 숨김)

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
| nockingOffset | 0.050 m | 오니 y오프셋 (시위 균형점 기준) | 화살 기울기, paradox |
| pullOffset | -0.015 m | 당김점 y오프셋 (**nockingOffset 기준**) | 초기발사각 |
| restOffsetY | 0.003 m | 화살걸이 y오프셋 | 화살 rest 위치 |

**검증된 물리량** (기본 파라미터):
- Brace height: 15.0 cm ✓
- T_brace: 70 N
- 만작 F_draw: 344 N (35.1 kgf)
- 저장 에너지: 56.9 J
- 화살 속도: 61.1 m/s (η=0.82 추정), 실측 37 m/s (Klopsteg η=0.33)

## 알려진 제한사항
1. draw 솔버에서 캔틸레버 모멘트 근사 유지 (기하학적 비선형 내부 반복은 brace에서만 적용)
2. 시위는 비신장 무질량 직선 (정적). 동적에서도 원-원 교점 기하 구속만 사용.
3. 화살은 2D(x,y)만. **Archer's paradox(z축 횡진동) 미반영** → 3D 확장 계획 수립됨
4. 공기저항 미반영 (비행 궤적)
5. 줌손 z축 토크(빨래 짜기) 미반영 → Phase B 계획

## 에이전트

### physics-reviewer (`.claude/agents/physics-reviewer.md`)
- 물리 시뮬레이션 전문가 + 국궁 전문가
- 구현 계획의 물리적 타당성, 수치해석 안정성, 국궁 사법 정합성 검증
- 검증 결과를 [PASS/WARN/FAIL] 형식으로 보고

## 세션 간 주의사항
- 빌드 후 반드시 캐시 우회 (URL `?v=N` 또는 hard reload)
- React 내부 값 디버그: `window.__DEBUG_*` 전역변수 패턴 사용
- Edit tool 사용 시: 반드시 먼저 Read로 정확한 텍스트 확인 후 교체
- ~2500줄 파일이므로 전체 Read 금지: offset/limit로 필요한 부분만 읽기
- 발시 시뮬레이션 버튼: React synthetic event 필요 (`__reactProps` onClick 호출)
- 조그셔틀 활성 시 React 시위 렌더 건너뜀 (`jogMode` 조건)
