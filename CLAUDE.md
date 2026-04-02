# 국궁 개량궁 3D 동역학 시뮬레이터

## 프로젝트 개요
한국 전통 활(국궁) 개량궁의 3D 구조-탄성 시뮬레이터.
연속 탄성체 모델(줌통 포함) + T-기반 평형 솔버 + 발시 진동 시뮬레이션.

## 아키텍처

### 파일 구조
```
국궁 동역학/
├── 국궁_3d_모델.jsx    # 메인 React/Three.js 소스 (~2100줄)
├── index.html           # 빌드 결과 (브라우저용)
├── build_html.js        # 빌드 스크립트
├── CLAUDE.md            # 이 파일
└── .claude/skills/      # 에이전트 스킬 (physics-engine, threejs-viz, sim-build-test, asymmetric-limb)
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

### 핵심 함수 체인 (연속 탄성체 모델)

```
DEFAULT_PARAMS
    ↓
getBeamProfile(sHalf, params)          ← EI(s), κ₀(s), 두께/폭 프로파일
    ↓
generateFullBeam(params, kappaLoadFn)  ← 그립중심→활채끝 연속 적분 (줌통 포함)
    ↓
computeRestShape(params)               ← 무현 형상 (하중 없이 자연곡률만)
    ↓
computeBowState(params, loadFactor)    ← loadFactor 기반 형상 (레거시 호환)
computeBowStateWithTension(params, T, forcePoint, options)  ← T 기반 형상-힘 자기일관
    ↓
solveBrace(params)                     ← T 이분법으로 brace 평형 (T_brace ≈ 519 N)
solveDraw(params, targetNockX, braceResult)  ← loadFactor+T 하이브리드 draw 솔버
    ↓
generateBowGeometry(params, drawAmount)      ← 전체 통합 (brace→draw→형상 조립)
    ↓
computeGripReaction(params, bowGeom)          ← 줌통 반력/토크/이상점 계산
    ↓
computeVibrationParams(params)               ← k_eff, E_stored, ω₀, F_draw 기반
```

### 함수 상세

| 함수명 | 역할 | 입력 → 출력 |
|-------|------|-----------|
| `getBeamProfile` | 연속 보 EI/두께/폭/자연곡률 프로파일 | (sHalf, params, limbSide?) → {EI, h, w, kappa0} |
| `generateFullBeam` | 그립중심→활채끝 연속 곡률 적분 (줌통 10 + 활채 40 분할) | (params, kappaLoadFn, limbSide?) → {points, thicknesses, widths, ...} |
| `computeRestShape` | 무현(unstrung) 기준 형상 | (params) → {beamUpper, beamLower, restPoints, siyahTop/Bottom} |
| `computeBowState` | loadFactor 기반 활 형상 (레거시) | (params, loadFactor) → {limb, beam, dorae, yangyangi, ...} |
| `computeBowStateWithTension` | T 기반 형상-힘 자기일관 반복 (dual beam 지원) | (params, T, forcePoint, options?) → {limb, beamUpper, beamLower, doraeTop, doraeBottom, yangyangiTop, yangyangiBottom, ...} |
| `computeStringLength` | 시위 길이 계산 (감김/직진 모드) | (params, state, nockX) → {computedLen, mode} |
| `solveBrace` | T 이분법으로 brace 평형 | (params) → {state, T_brace, braceHeight, stringMode} |
| `solveDraw` | 하이브리드 draw 솔버 (loadFactor + T/F 역산) | (params, targetNockX, braceResult) → {state, T_draw, F_draw, ...} |
| `generateBowGeometry` | 전체 기하학 통합 | (params, drawAmount) → {limbPoints, T_current, F_draw, ...} |
| `computeNockX` | loadFactor→nockX 순방향 매핑 (레거시) | (params, loadFactor) → {nockX, state, mode} |
| `computeGripReaction` | 줌통 반력/토크/이상점 계산 | (params, bowGeom) → {Fx, Fy, M_grip, reactionPointY} |
| `computeVibrationParams` | 진동 파라미터 (F_draw 기반) | (params) → {omega0, omega_d, zeta, A_grip, k_eff, E_stored} |

### 좌표계
- **x축**: 수평. 양(+) = 궁사 방향 (시위 당기는 쪽). 음(-) = 과녁 방향.
- **y축**: 수직. 양(+) = 위 (상채 방향).
- **z축**: 화면 밖으로 나오는 방향.
- nockX는 양수 (궁사 쪽). 화살은 양(+)x에서 음(-)x 방향으로 발사.

### 연속 보 모델 (v2)
- 줌통+활채를 하나의 연속 보로 모델링 → C¹ 연속성 보장 (꺾임 없음)
- EI(s) 프로파일: 줌통 = limbRootEI × gripStiffnessRatio, 경계에서 코사인 보간 (±1.5cm)
- 무현 형상: 자연곡률 κ₀(s)만으로 적분 (반곡 C자 형태)
- **비대칭 모델**: `limbAsymmetryRatio`로 하채 EI를 독립 스케일링. 상하채 beamUpper/beamLower 별도 생성. 줌통 구간은 비대칭 미적용 (항상 대칭). 하채 적분 시 forcePointMirrored = {x, -y} 사용 후 y 좌표 재반전.

### 솔버 구조
- **solveBrace**: 외부=T 이분법(50회), 내부=형상-힘 자기일관(3회, relaxation 0.5)
- **solveDraw**: loadFactor 이분법으로 nockX 맞춤 → T, F_draw를 기하학에서 역산
  - T = loadFactor × dist(nock, anchor) / |anchor.y|
  - F_draw = 2 × T × sin(θ) = 2 × T × (nockX - anchor.x) / dist(nock, anchor)

### 시위 모델
- 양양고자(siyah 끝) → 도르래(siyah 접합부) → 자유 직선 → 반대편
- 감김 판정: 시위-당김점 직선이 도르래를 교차하면 'dorae' 모드
- 상하채 독립 감김 판정

## 핵심 파라미터 (DEFAULT_PARAMS)

| 파라미터 | 기본값 | 물리적 의미 | 민감도 |
|---------|--------|----------|--------|
| elasticModulus | 45 GPa | FRP/카본 복합재 탄성계수 | EI에 선형 |
| limbThickness | 12 mm | 활채 두께 | **EI ∝ t³ (최고 민감)** |
| limbWidth | 28 mm | 활채 폭 | EI에 선형 |
| bowLength | 120 cm | 전체 활 길이 | 높음 |
| stringLength | 108 cm | 시위 길이 | brace height 결정 |
| maxDraw | 80 cm | 만작 거리 | 높음 |
| reflexAngle | 35° | 반곡 각도 | 무현 형태 결정 |
| siyahAngle | 55° | 고자 꺾임 각도 | 시위 감김에 영향 |
| gripAngle | 10° | 줌통 V자 각도 | 리커브 프로파일 |
| gripStiffnessRatio | 15 | 줌통/활채 강성비 | 줌통 탄성 거동 |
| limbAsymmetryRatio | 1.0 | 하채 EI / 상채 EI 비율 (0.8~1.5) | 비대칭 굽힘, nockY 편향 |
| nockingOffset | 0.005 m | 오니 y오프셋 (화살대 직경) | 화살 기울기 |
| pullOffset | -0.015 m | 당김점 y오프셋 (엄지 위치) | 초기발사각 |
| restOffsetY | -0.005 m | 화살걸이 y오프셋 | 화살 rest 위치 |

**검증된 물리량** (기본 파라미터):
- Brace height: 15.0 cm ✓
- T_brace: 519 N
- 50% draw T: 603 N, F_draw: 547 N (55.8 kgf)

**비대칭 테스트값** (limbAsymmetryRatio 변화):
- ratio=1.0 (대칭): Brace 15.0 cm, T_brace 519 N (기본값과 동일)
- ratio=1.3 (하채 강성): Brace 15.3 cm, T_brace 577 N

## 알려진 제한사항
1. draw 솔버에서 캔틸레버 모멘트 근사 유지 (기하학적 비선형 내부 반복은 brace에서만 적용)
2. 시위는 비신장성 가정 (실제로는 약간 늘어남)
3. 화살 패러독스(archer's paradox) 미반영
4. 공기저항 미반영 (비행 궤적)

## 세션 간 주의사항
- 빌드 후 반드시 캐시 우회 (URL `?v=N` 또는 hard reload)
- React 내부 값 디버그: `window.__DEBUG_*` 전역변수 패턴 사용
- Edit tool 사용 시: 반드시 먼저 Read로 정확한 텍스트 확인 후 교체
- 2100줄 파일이므로 전체 Read 금지: offset/limit로 필요한 부분만 읽기
