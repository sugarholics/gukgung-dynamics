---
name: physics-engine
description: "국궁 물리 엔진 수정 스킬. 활채 굽힘, 시위 솔버, 탄성에너지, 진동 모델, 비틂, 비대칭, 파라미터 변경 등 물리 계산 코드를 수정할 때 사용. '힘이 이상해', '에너지가 너무 커', '솔버 수정', '물리 모델', '빔 이론', '파라미터 변경', '당김력', '진동', '비틂', 'GJ' 등의 요청에서 이 스킬을 사용할 것."
---

# 국궁 물리 엔진 스킬

## 파일 구조 맵

메인 파일: `국궁_3d_모델.jsx` (~3000줄)

물리 관련 함수들 (함수명으로 Grep 검색할 것, 줄 번호 변동 큼):

### 정적 솔버
| 함수명 | 역할 |
|-------|------|
| `getBeamProfile` | EI(s), 두께/폭/자연곡률 프로파일 (limbSide로 비대칭 지원) |
| `generateFullBeam` | 그립중심→활채끝 연속 곡률 적분 (줌통 10 + 활채 40 분할) |
| `computeRestShape` | 무현 형상 (상하채 독립) |
| `computeBowStateWithTension` | T 기반 형상-힘 자기일관 (dual beam, forcePoint 미러링) |
| `solveBrace` | T 이분법 + nockY 자기일관 루프(2-3회) |
| `solveDraw` | loadFactor 이분법 → T/F_draw 역산 |
| `generateBowGeometry` | 전체 통합 (brace→draw→형상→접촉점) |
| `computeGripReaction` | 줌통 반력/토크/이상점 |
| `computeVibrationParams` | k_eff, E_stored, ω₀ |
| `computeZRotationParams` | 줌손 z축 회전 I_z, k_z, omega_z |

### 동적 솔버 (발시)
| 함수명 | 역할 |
|-------|------|
| `preSampleBowAnchors` | 31점 사전 샘플 + 비틂 z-보정 |
| `simulateRelease` | 마스터: 활채 ODE + 시위 체인 + 화살 3D + impulse 적산 |
| `computeModalAmplitudes` | lumped→모달 투영 (y+z 분리) |
| `computeModalArrowShape` | Phase 2 모달 형상 (ω₀ 축 회전 포함) |

## 좌표계와 부호 규약

- **x축**: 양(+) = 궁사 방향. 음(-) = 과녁 방향.
- **y축**: 양(+) = 위. 음(-) = 아래.
- **z축**: 양(+) = 궁사 왼쪽. 음(-) = 궁사 오른쪽 (화살 위치, z_arrow < 0).
- nockX > 0. 화살은 +x → -x 방향 발사.

### ⚠️ 부호 실수 방지 (세션 경험)
- `Jx_string = ∫Fx dt` (Fx 그대로, 음수). `∫(-Fx) dt`로 하면 vy 부호 반전!
- nockingOffset > 0 → Fy < 0 (아래) → vy < 0 (아래 발사)
- `forcePointMirrored.y = -forcePoint.y`는 올바른 좌표 변환 (하채 적분 좌표계)

## 핵심 수식

### 굽힘 강성 (EI)
```
EI = E × w × t³ / 12     (t가 세제곱 — 최고 민감)
```

### Klopsteg 유효질량
```
m_eff_limb = 2 × (0.123 × m_limb + m_siyah) + m_string/3
m_coupled = m_eff_limb + m_arrow
η = m_arrow / m_coupled = 0.402 (25g 화살)
```
0.123: tapered beam 모드형상 적분 (h(s)=h₀(1-0.55s/L), w(s)=w₀(1-0.3s/L))

### 비틂 강성 (GJ)
```
GJ = β × G × w × h³
β = 0.275 (w/h=3.5)
G = E / (2(1+ν)) = 8.46 GPa (ν=0.3)
GJ = 33.4 N·m² (등방성 FRP). 복합재 UD: 5~8
```

### 비틂 보정
```
M_twist = T × z_arrow × sin(시위각)
φ = M_twist × L_limb / GJ
Δz_anchor = φ × L_siyah
```

## 검증 기준 (2026-04-07)

| 항목 | 정상 범위 | 현재 검증값 |
|------|---------|-----------|
| brace height | 14~18 cm | 15.0 cm |
| F_draw (만작) | 250~400 N | 344 N |
| E_stored | 40~70 J | 56.9 J |
| v_arrow (CoM vx) | 38~50 m/s | -42.70 m/s |
| η (Klopsteg) | 0.35~0.50 | 0.402 |
| t_separation | 15~25 ms | 19.07 ms |
| CoM vy | -5~+2 m/s | -2.80 m/s |
| ω₀ (angular impulse) | -5~+5 rad/s | 0.341 rad/s |

## 자주 발생하는 실수

1. **loadFactor와 drawAmount 혼동**: drawAmount는 0-1 UI 값, loadFactor는 내부 빔 하중 계수
2. **상하채 미러링**: `forcePointMirrored = {x, -y}`는 올바른 좌표 변환. 결합 솔버 불필요
3. **nockY 자기일관**: limbAsymmetryRatio ≠ 1이면 nockY ≠ 0. solveBrace 루프 2-3회 필요
4. **gripOffsetY**: 개량궁(강성비 25)에서 효과 0.02mm → 무시. 나무활(강성비 5-10)에서 5~25배
5. **drawing 애니메이션**: setDrawAmount 매 프레임 → generateBowGeometry 병목. 제거함
