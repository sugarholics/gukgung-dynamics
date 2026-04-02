---
name: threejs-viz
description: "Three.js 3D 시각화 스킬. 활, 화살, 시위의 3D 렌더링, 메시 생성, 카메라 설정, 애니메이션, 색상/재질 변경 등 시각적 요소를 수정할 때 사용. '화살이 안 보여', '색상 변경', '카메라', '렌더링', '메시', '화면에 표시', '3D', '시각화', 'Three.js' 등의 요청에서 사용할 것."
---

# Three.js 3D 시각화 스킬

## 환경

- Three.js r128 (CDN): `https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js`
- React 18 (CDN)
- Babel standalone (in-browser 트랜스파일)

**r128 제약사항**: CapsuleGeometry 사용 불가 (r142에서 도입). CylinderGeometry나 SphereGeometry로 대체.

## 씬 구조

```
Scene
├── AmbientLight (0x404040)
├── DirectionalLight (0xffffff, position: 2,2,3)
├── bowGroup (THREE.Group) ← 활 전체
│   ├── 활채 메시 (TubeGeometry × 2: 상채/하채)
│   ├── 고자 메시 (CylinderGeometry × 2)
│   ├── 줌통 메시 (CylinderGeometry)
│   └── 도르래 마커 (SphereGeometry × 2, 빨간색)
├── stringMesh (THREE.Line) ← 시위
├── arrowGroup (THREE.Group) ← 정적 화살 (당김 중)
│   ├── 화살대 (TubeGeometry via CatmullRomCurve3)
│   ├── 촉 (ConeGeometry, 회색)
│   └── 깃 (PlaneGeometry × 3, 빨강+흰색)
├── flyingArrow (THREE.Group) ← 비행 화살 (발시 후)
├── 4점 마커
│   ├── 오늬 (SphereGeometry, 노랑) — nocking point
│   ├── 당김점 (SphereGeometry, 빨강) — pulling point
│   ├── 화살걸이 (SphereGeometry, 초록) — rest point
│   └── 줌이상점 (SphereGeometry, 시안) — gripIdeal (토크=0 작용점)
└── GridHelper (선택적)
```

## 좌표계 ↔ 화면 매핑

- **양(+)x** = 화면 **오른쪽** = 궁사 방향
- **음(-)x** = 화면 **왼쪽** = 과녁 방향
- **양(+)y** = 화면 **위** = 상채 방향
- **양(+)z** = 화면 **앞** (카메라 쪽)

기본 카메라: `PerspectiveCamera(50, aspect, 0.01, 100)`, position (0, 0, 1.5), lookAt (0, 0, 0)

## 화살 렌더링 패턴

화살은 가장 문제가 많았던 요소. 검증된 패턴:

### 정적 화살 (당김 중)
```javascript
// 1. 방향 계산: nocking point → rest point
const ux = (rp.x - np.x) / dist;  // ux < 0 (과녁 방향)
const uy = (rp.y - np.y) / dist;

// 2. 경로점 생성 (nock에서 tip 방향으로)
for (let i = 0; i <= nPts; i++) {
  const t = i / nPts;
  arrowPts.push(new THREE.Vector3(
    np.x + ux * t * arrowLen,    // nock → tip
    np.y + uy * t * arrowLen + sag,
    0));
}

// 3. TubeGeometry (CylinderGeometry는 방향 설정이 까다로움)
const curve = new THREE.CatmullRomCurve3(arrowPts);
const tube = new THREE.TubeGeometry(curve, nPts, 0.004, 6, false);

// 4. 촉: 경로의 마지막 점 (과녁쪽)
const tipPos = arrowPts[arrowPts.length - 1];
tip.position.copy(tipPos);
tip.rotation.z = Math.atan2(uy, ux) - Math.PI/2;

// 5. 깃: nocking point 뒤쪽 (궁사쪽)
const fletchPos = new THREE.Vector3(np.x - ux*0.04, np.y - uy*0.04, 0);
```

### 비행 화살 (발시 후)
```javascript
// CylinderGeometry (직선 비행이므로 단순 형태 가능)
shaft.rotation.z = Math.PI / 2;  // Y축 → X축 방향 정렬
tip.rotation.z = -Math.PI / 2;   // 촉은 -x 방향 (과녁)
tip.position.set(-arrowLen/2 - 0.02, 0, 0);  // 그룹 로컬 좌표

// 이동: -x 방향 (과녁으로)
arrowX -= velocity * dt;
// 중력
arrowVy += 9.81 * dt;
arrowY -= arrowVy * dt;
```

## ConeGeometry 방향 규약

Three.js ConeGeometry의 기본 방향은 **+Y축** (위).

| 원하는 방향 | rotation.z 값 |
|-----------|-------------|
| 위 (+Y) | 0 |
| 오른쪽 (+X) | -Math.PI/2 |
| 왼쪽 (-X) | Math.PI/2 |
| 아래 (-Y) | Math.PI |

화살 촉은 **발사 방향**으로 향해야 함:
- 정적 화살: `arrowAngle - Math.PI/2` (arrowAngle = atan2(uy, ux))
- 비행 화살: `-Math.PI/2` (항상 -x 방향)

## 색상 팔레트

| 요소 | 색상 코드 | 설명 |
|------|----------|------|
| 활채 | 0x2a1506 (어두운 갈색) | 나무/FRP |
| 고자 | 0xd4a574 (밝은 갈색) | 뿔/나무 |
| 줌통 | 0x1a0a02 (거의 검정) | 가죽 감김 |
| 화살대 | 0xC8A862 (대나무 금색) | 죽시 |
| 촉 | 0x888888 (회색) | 금속 |
| 깃 | 0xcc2222 / 0xeeeeee | 빨강/흰색 |
| 시위 | 0xdddddd (밝은 회색) | 실 |
| 배경 | 0x0a0a1e (짙은 남색) | — |

## 성능 고려사항

- 매 프레임 메시를 새로 생성하지 말 것. `useCallback` + `useEffect` 의존성으로 필요할 때만 재생성
- geometry/material은 반드시 `.dispose()` 호출 후 제거
- TubeGeometry의 segments 수는 20이면 충분 (너무 높이면 성능 저하)
