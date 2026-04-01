import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import * as THREE from "three";

/*
 * 국궁 개량궁 3D 모델 및 탄성 동역학 시뮬레이션
 *
 * 구조 모델:
 *   - 줌통(grip): 중앙 강체 섹션
 *   - 활채(limb): Euler-Bernoulli 탄성 보 (줌통 양쪽)
 *   - 고자(siyah): 활채 끝에 고정 각도로 연결된 강체
 *
 * 시위 경로:
 *   양양고자(고자 끝) → 고자 안쪽면 → 도고자(활채/고자 접합부) → 자유 직선 → 반대편 도고자 → 반대편 고자 → 반대편 양양고자
 *
 * 개량궁 기본 사양 (FRP/카본):
 *   - 전체 길이(현걸이 상태): ~120cm
 *   - 궁력: 30~45 lbs (약 13~20 kgf)
 *   - brace height: 약 15~18cm
 *   - 만작(full draw): 약 75~85cm
 */

// ─── 물리 상수 및 개량궁 파라미터 ───
// 모든 항목이 독립 변수(조절 가능). brace height는 이들로부터 계산되는 종속 변수.
const DEFAULT_PARAMS = {
  // 활체 기하학
  bowLength: 1.20,        // 활 전체 길이 (m)
  gripLength: 0.12,       // 줌통 길이 (m)
  siyahLength: 0.08,      // 고자 길이 (m)
  siyahAngle: 55,         // 고자 각도 (도) - 활채 끝 접선 대비 사대방향 꺾임
  limbWidth: 0.028,       // 활채 폭 (m) - 줌통 접합부 기준
  limbThickness: 0.012,   // 활채 두께 (m) - 줌통 접합부 기준

  // 탄성 특성
  elasticModulus: 45e9,    // FRP/카본 복합재 탄성계수 (Pa) ~45 GPa
  dampingRatio: 0.02,     // 감쇠비

  // 시위 (독립 변수)
  stringLength: 1.08,     // 시위 전체 길이 (m) — 양쪽 고리 포함
  stringDiameter: 0.002,  // 시위 직경 (m)

  // 사용 조건
  maxDraw: 0.80,          // 만작 거리 (m) — 줌통 중심에서 nock point까지

  // 활채 형상 — 반곡(reflex) 특성
  reflexAngle: 35,        // 반곡 각도 (도)
  naturalCurvature: 0.8,  // 자연 곡률 인자

  // 줌통(대림) V자 각도
  // 줌통 양 끝이 사대 방향으로 약간 꺾여 리커브 형태를 이룸
  // 0° = 직선 줌통, 10~15° = 개량궁 전형적 형태
  gripAngle: 10,          // 줌통 V자 각도 (도)
};

// ─── 한쪽 활채의 곡선 생성 (호 길이 보존 곡률 적분 모델) ───
// 활채는 늘어나지 않고 '휘어지기만' 하는 구조.
// 호 길이(arc length)를 보존하면서 곡률(curvature)을 적분하여 형상을 결정한다.
// 두께가 줌통에서 끝으로 갈수록 얇아지므로 EI(s)가 변하고,
// 같은 모멘트에서도 끝쪽이 더 많이 휜다.
function generateOneLimb(limbArcLen, params, loadFactor) {
  const {
    gripLength, reflexAngle, naturalCurvature,
    elasticModulus, limbThickness, limbWidth
  } = params;
  const gripAngle = params.gripAngle || 0;

  const N = 40; // 활채 분할 수
  const ds = limbArcLen / N;
  const reflexRad = (reflexAngle * Math.PI) / 180;

  // 두께 프로파일: 줌통 쪽이 가장 두껍고 끝으로 갈수록 얇아짐
  // h(s) = h_max * (1 - taperRatio * (s/L))
  const taperRatio = 0.55; // 끝에서 줌통 대비 45% 두께
  function thicknessAt(s) {
    const ratio = s / limbArcLen;
    return limbThickness * (1 - taperRatio * ratio);
  }

  // 폭도 약간 줄어듬
  function widthAt(s) {
    const ratio = s / limbArcLen;
    return limbWidth * (1 - 0.3 * ratio);
  }

  // 굽힘 강성 EI(s) = E * b(s) * h(s)³ / 12
  function EI_at(s) {
    const h = thicknessAt(s);
    const b = widthAt(s);
    return elasticModulus * b * h * h * h / 12;
  }

  // 자연 곡률 (현을 걸지 않은 상태의 반곡)
  // 줌통 근처에서 적고, 중간에서 최대, 끝에서 다시 감소
  function naturalCurvatureAt(s) {
    const ratio = s / limbArcLen;
    return -reflexRad * naturalCurvature * Math.sin(ratio * Math.PI * 0.8) * 2.0 / limbArcLen;
  }

  // 하중에 의한 추가 곡률
  // 시위 장력이 도고자(활채 끝)에 힘 F를 가함 → 캔틸레버 모멘트 분포
  //   M(s) = F * (L - s)  (줌통에서 최대, 도고자에서 0)
  //   κ_load(s) = -M(s) / EI(s)  (사대 방향으로 휨 = 자연 곡률과 같은 방향)
  function loadCurvatureAt(s) {
    const moment = loadFactor * (limbArcLen - s);
    return -moment / EI_at(s);
  }

  // 곡률 적분: 호 길이를 정확히 보존하며 위치 계산
  // 시작점: 줌통 끝 (0, gripLength/2), 각도 = π/2 (위쪽)
  const points = [];
  const thicknesses = []; // 렌더링용 두께 정보
  const widths = []; // 렌더링용 폭 정보

  // 줌통 V자 각도 반영: 활채는 줌통 끝에서 사대 방향으로 gripAngle만큼 기울어 시작
  // gripAngle > 0이면 활채 시작점이 사대 방향(-x)으로 이동 → 리커브 프로파일
  const gripAngleRad = (gripAngle * Math.PI) / 180;
  let angle = Math.PI / 2 + gripAngleRad; // 초기 방향: +y에서 gripAngle만큼 사대 방향으로 기울임
  let x = -(gripLength / 2) * Math.sin(gripAngleRad); // 줌통 끝 x (사대 방향 오프셋)
  let y = (gripLength / 2) * Math.cos(gripAngleRad);  // 줌통 끝 y

  points.push({ x, y, angle });
  thicknesses.push(thicknessAt(0));
  widths.push(widthAt(0));

  for (let i = 0; i < N; i++) {
    const s = (i + 0.5) * ds; // 구간 중점

    // 총 곡률 = 자연 곡률 + 하중 곡률
    const kappa = naturalCurvatureAt(s) + loadCurvatureAt(s);

    // 각도 변화
    angle += kappa * ds;

    // 위치 전진 (호 길이 ds만큼 정확히 이동 — 늘어나지 않음)
    x += Math.cos(angle) * ds;
    y += Math.sin(angle) * ds;

    points.push({ x, y, angle });
    thicknesses.push(thicknessAt((i + 1) * ds));
    widths.push(widthAt((i + 1) * ds));
  }

  return { points, thicknesses, widths };
}

// ─── 주어진 하중에서 활 형상 + 시위 길이 계산 (솔버 내부 함수) ───
function computeBowState(params, loadFactor) {
  const { bowLength, gripLength, siyahLength, siyahAngle } = params;
  const halfLen = bowLength / 2;
  const limbArcLen = halfLen - gripLength / 2 - siyahLength;
  const siyahRad = (siyahAngle * Math.PI) / 180;

  // 활채 생성
  const limb = generateOneLimb(limbArcLen, params, loadFactor);
  const limbEnd = limb.points[limb.points.length - 1];
  const endAngle = limbEnd.angle;
  const tangent = { x: Math.cos(endAngle), y: Math.sin(endAngle) };

  // 고자 방향 (활채 접선에서 siyahAngle만큼 앞쪽으로 꺾임)
  const cos = Math.cos(siyahRad);
  const sin = Math.sin(siyahRad);
  const siyahDir = {
    x: tangent.x * cos - tangent.y * sin,
    y: tangent.y * cos + tangent.x * sin,
  };
  const norm = Math.sqrt(siyahDir.x ** 2 + siyahDir.y ** 2);
  siyahDir.x /= norm;
  siyahDir.y /= norm;

  // 도고자 = 활채 끝점, 양양고자 = 고자 끝점
  const dorae = { x: limbEnd.x, y: limbEnd.y };
  const yangyangi = {
    x: dorae.x + siyahDir.x * siyahLength,
    y: dorae.y + siyahDir.y * siyahLength,
  };

  // 시위 경로에서 고자 구간 길이 = siyahLength (강체이므로 항상 동일)
  // 자유 구간: 상단 도고자 ↔ 하단 도고자 (대칭이므로 하단은 y 반전)
  const doraeBottom = { x: dorae.x, y: -dorae.y };
  const doraeDist = Math.sqrt(
    (dorae.x - doraeBottom.x) ** 2 + (dorae.y - doraeBottom.y) ** 2
  );

  // 시위 총 길이 (brace height 상태, 자유구간 직선)
  const stringLenAtBrace = 2 * siyahLength + doraeDist;

  return {
    limb, dorae, yangyangi, siyahDir, doraeBottom,
    doraeDist, stringLenAtBrace, limbArcLen,
  };
}

// ─── 순방향 매핑: loadFactor → nockX (도르래/기둥 감김 모델) ───
// 시위는 양양고자(고자 끝)에 고정되며, 도고자(활채/고자 접합부)는
// 밧줄이 기둥에 걸리듯 접촉점(contact post) 역할을 한다.
//
// 감김 판정: 양양고자→nock 직선 경로 위, 도고자 높이에서의 x좌표와
//           도고자 실제 x좌표를 비교한다.
//   • 도고자가 직선보다 앞(사대 방향)에 돌출 → 시위가 기둥에 감김
//   • 도고자가 직선 뒤에 있음 → 시위가 기둥을 지나치지 않고 직진
//
// [감김 모드] stringLength/2 = siyahLength + dist(dorae, nock)
//   → halfFree = stringLength/2 - siyahLength
//   → nockX = dorae.x + √(halfFree² - dorae.y²)
//   → F_draw = 2 × loadFactor × (nockX - dorae.x) / |dorae.y|
//
// [직진 모드] stringLength/2 = dist(yangyangi, nock)
//   → halfStr = stringLength/2
//   → nockX = yangyangi.x + √(halfStr² - yangyangi.y²)
//   → F_draw = 2 × loadFactor × (nockX - yangyangi.x) / |yangyangi.y|
// 매 상태마다 시위-도고자 기하학을 확인하여 감김/직진을 동적 판정.
// 고자 각도는 고정값이지만, 당기는 중 시위와 고자의 상대각도가 변하므로
// 감김↔이탈 전환이 자연스럽게 발생한다.
function computeNockX(params, loadFactor) {
  const { stringLength, siyahLength } = params;
  const state = computeBowState(params, loadFactor);
  const { dorae, yangyangi } = state;
  const halfStr = stringLength / 2;

  // ① 직진 모드 nockX (양양고자→nock 직행 가정)
  const under_y = halfStr * halfStr - yangyangi.y * yangyangi.y;
  if (under_y < 0) return { nockX: null, state, mode: null };
  const nockX_yang = yangyangi.x + Math.sqrt(under_y);

  // ② 감김 판정: 양양고자→nock 직선이 도고자 높이를 지나는 x좌표
  //    도고자가 이 직선보다 앞(+x)에 돌출 → 밧줄이 기둥에 감김
  const dy = dorae.y, yy = yangyangi.y;
  if (Math.abs(yy) > 1e-6) {
    const x_line = nockX_yang + (yangyangi.x - nockX_yang) * dy / yy;
    if (dorae.x > x_line + 1e-6) {
      // 감김 모드: 시위가 도고자에 걸려서 꺾임
      const halfFree = halfStr - siyahLength;
      const under_d = halfFree * halfFree - dy * dy;
      if (under_d < 0) return { nockX: null, state, mode: 'dorae' };
      return { nockX: dorae.x + Math.sqrt(under_d), state, mode: 'dorae' };
    }
  }

  // 직진 모드: 도고자 접촉 없음
  return { nockX: nockX_yang, state, mode: 'yangyangi' };
}

// ─── 시위 길이 구속 조건 솔버를 포함한 활 전체 기하학 생성 ───
// 순방향 매핑(lf → nockX) + 이분법 역전 방식의 강건한 솔버
// drawAmount = 0 → brace height 평형 (시위 직선)
// drawAmount > 0 → 시위 길이 보존하며 nock point 이동
function generateBowGeometry(params, drawAmount = 0) {
  const {
    bowLength, gripLength, siyahLength, siyahAngle, stringLength, maxDraw
  } = params;

  // ─── 1단계: brace height 평형 찾기 (도르래 감김 모델, 통합 솔버) ───
  // 원리: computeNockX는 감김/직진 모드를 자동 판정한다.
  //   loadFactor가 작으면 활채가 많이 펴져서 시위가 닿지 못함 (nockX=null)
  //   loadFactor가 커지면 활채가 충분히 휘어 시위가 팽팽해짐 (nockX=valid)
  //   null→valid 전환점 = brace 평형 = 시위가 처음으로 팽팽해지는 하중
  let loadLo = 0, loadHi = 5000;
  for (let iter = 0; iter < 60; iter++) {
    const mid = (loadLo + loadHi) / 2;
    const result = computeNockX(params, mid);
    if (result.nockX === null) {
      loadLo = mid;  // 하중 부족 — 시위 미도달
    } else {
      loadHi = mid;  // 하중 충분 — 시위 도달
    }
  }
  // loadHi 쪽이 항상 valid (nockX !== null) — 60회 이분법 후 loadHi ≈ loadLo
  const braceLoadFactor = loadHi;
  const braceResult = computeNockX(params, braceLoadFactor);
  const braceHeight = braceResult.nockX || 0;
  let stringMode = braceResult.mode || 'yangyangi';

  // ─── 피크 nockX 찾기 (단조 범위 상한) ───
  // 매 상태마다 시위-도고자 상대각도에 따라 감김/이탈을 동적 판정
  let peakLf = braceLoadFactor;
  let peakNockX = braceHeight;
  for (let lf = braceLoadFactor; lf < 10000; lf += Math.max(1, lf * 0.05)) {
    const { nockX } = computeNockX(params, lf);
    if (nockX !== null && nockX > peakNockX) {
      peakNockX = nockX;
      peakLf = lf;
    } else if (nockX !== null && nockX < peakNockX - 0.005) {
      break; // 피크 지남
    }
  }

  // 도달 가능 최대 draw (피크 nockX 또는 maxDraw 중 작은 값)
  const achievableMaxDraw = Math.min(peakNockX, maxDraw);

  // ─── 2단계: 현재 당김 상태의 하중 찾기 ───
  let finalLoadFactor = braceLoadFactor;
  let currentNockX = braceHeight;

  if (drawAmount > 0.001) {
    // nock 위치: brace height → achievableMaxDraw 사이를 drawAmount로 보간
    const targetNockX = braceHeight + drawAmount * (achievableMaxDraw - braceHeight);
    currentNockX = targetNockX;

    // 역전: find loadFactor such that computeNockX = targetNockX
    let dLo = braceLoadFactor, dHi = peakLf;
    for (let iter = 0; iter < 60; iter++) {
      const mid = (dLo + dHi) / 2;
      const { nockX } = computeNockX(params, mid);
      if (nockX === null || nockX < targetNockX) {
        dLo = mid;
      } else {
        dHi = mid;
      }
    }
    finalLoadFactor = (dLo + dHi) / 2;
    // 실제 nockX와 현재 상태의 stringMode로 업데이트
    const drawResult = computeNockX(params, finalLoadFactor);
    if (drawResult.nockX !== null) {
      currentNockX = drawResult.nockX;
      if (drawResult.mode) stringMode = drawResult.mode;
    }
  }

  // ─── 3단계: 최종 형상 조립 ───
  const finalState = computeBowState(params, finalLoadFactor);
  const topLimb = finalState.limb;

  // 하단 활채 (y 반전)
  const bottomLimbPoints = topLimb.points.map(p => ({ x: p.x, y: -p.y, angle: -p.angle }));

  // 줌통 포인트: V자 형태 (center에서 양 끝이 사대 방향으로 꺾임)
  // 하단끝(-gripEndX, -gripEndY) → 중심(0,0) → 상단끝(-gripEndX, gripEndY)
  const gripSubdiv = 8;
  const gripPoints = [];
  const gAlphaRad = ((params.gripAngle || 0) * Math.PI) / 180;
  const gripEndX = (gripLength / 2) * Math.sin(gAlphaRad); // |x-offset|, 양수
  const gripEndY = (gripLength / 2) * Math.cos(gAlphaRad); // y-extent
  for (let i = 0; i <= gripSubdiv; i++) {
    const t = i / gripSubdiv; // 0(하단끝) → 0.5(중심) → 1(상단끝)
    let gx, gy;
    if (t <= 0.5) {
      // 하단끝 → 중심
      const t2 = t * 2;
      gx = -gripEndX * (1 - t2); // 하단끝 x=-gripEndX, 중심 x=0
      gy = -gripEndY * (1 - t2); // 하단끝 y=-gripEndY, 중심 y=0
    } else {
      // 중심 → 상단끝
      const t2 = (t - 0.5) * 2;
      gx = -gripEndX * t2; // 중심 x=0, 상단끝 x=-gripEndX
      gy = gripEndY * t2;  // 중심 y=0, 상단끝 y=gripEndY
    }
    gripPoints.push(new THREE.Vector3(gx, gy, 0));
  }

  // 전체 활채 포인트 (하단 끝 → 줌통 → 상단 끝)
  const limbPoints = [];
  const limbRadii = [];

  for (let i = bottomLimbPoints.length - 1; i >= 0; i--) {
    const p = bottomLimbPoints[i];
    limbPoints.push(new THREE.Vector3(p.x, p.y, 0));
    limbRadii.push(topLimb.widths[i] * 0.4);
  }

  const gripRadius = params.limbWidth * 0.45;
  for (let i = 0; i <= gripSubdiv; i++) {
    limbPoints.push(gripPoints[i]);
    limbRadii.push(gripRadius);
  }

  for (let i = 0; i < topLimb.points.length; i++) {
    const p = topLimb.points[i];
    limbPoints.push(new THREE.Vector3(p.x, p.y, 0));
    limbRadii.push(topLimb.widths[i] * 0.4);
  }

  // 고자 (Three.js Vector3)
  const doraeTop = new THREE.Vector3(finalState.dorae.x, finalState.dorae.y, 0);
  const doraeBottom = new THREE.Vector3(finalState.dorae.x, -finalState.dorae.y, 0);
  const yangyangiTop = new THREE.Vector3(finalState.yangyangi.x, finalState.yangyangi.y, 0);
  const yangyangiBottom = new THREE.Vector3(finalState.yangyangi.x, -finalState.yangyangi.y, 0);
  const siyahDirTop = new THREE.Vector3(finalState.siyahDir.x, finalState.siyahDir.y, 0);
  const siyahDirBottom = new THREE.Vector3(finalState.siyahDir.x, -finalState.siyahDir.y, 0);

  return {
    limbPoints,
    limbRadii,
    topLimbData: topLimb,
    doraeTop, doraeBottom,
    yangyangiTop, yangyangiBottom,
    siyahDirTop, siyahDirBottom,
    braceHeight,        // 계산된 종속 변수
    loadFactor: finalLoadFactor,
    nockX: currentNockX,
    stringMode,         // 'dorae' (감김) 또는 'yangyangi' (직진)
  };
}

// ─── 시위 경로 생성 (도르래 감김 모델) ───
// 도고자가 밧줄의 기둥 역할: 시위가 도고자에 접촉하면 감겨서 꺾이고,
// 접촉하지 않으면 양양고자에서 nock으로 직진한다.
//
// [감김 모드] 양양고자 → 도고자(접촉) → nock → 도고자 → 양양고자
// [직진 모드] 양양고자 → nock → 양양고자 (도고자 접촉 없음)
function generateStringPath(bowGeom, drawAmount) {
  const { yangyangiTop, yangyangiBottom, doraeTop, doraeBottom, nockX, stringMode } = bowGeom;

  const nockPoint = new THREE.Vector3(nockX, 0, 0);
  const stringPoints = [];
  const subdivPerSeg = 6;

  // 보간 헬퍼
  function lerp(a, b, n, includeStart, includeEnd) {
    const start = includeStart ? 0 : 1;
    const end = includeEnd ? n : n - 1;
    for (let i = start; i <= end; i++) {
      const t = i / n;
      stringPoints.push(new THREE.Vector3(
        a.x + (b.x - a.x) * t,
        a.y + (b.y - a.y) * t, 0
      ));
    }
  }

  if (stringMode === 'dorae') {
    // ── 감김 모드: 시위가 도고자(기둥)에 걸림 ──
    // ① 양양고자_하 → 도고자_하 (고자 앞면, 시위가 걸쳐짐)
    lerp(yangyangiBottom, doraeBottom, subdivPerSeg, true, true);
    if (drawAmount < 0.001) {
      // brace: 도고자_하 → 도고자_상 직선 (자유구간 최단)
      lerp(doraeBottom, doraeTop, subdivPerSeg, false, false);
    } else {
      // ② 도고자_하 → nock (자유구간 하단)
      lerp(doraeBottom, nockPoint, subdivPerSeg, false, true);
      // ③ nock → 도고자_상 (자유구간 상단)
      lerp(nockPoint, doraeTop, subdivPerSeg, false, false);
    }
    // ④ 도고자_상 → 양양고자_상 (고자 앞면)
    lerp(doraeTop, yangyangiTop, subdivPerSeg, true, true);
  } else {
    // ── 직진 모드: 시위가 도고자에 접촉하지 않음 ──
    // 양양고자 → nock → 양양고자 (또는 brace 시 양양고자→양양고자 직선)
    if (drawAmount < 0.001) {
      // brace: 양양고자_하 → 양양고자_상 직선
      lerp(yangyangiBottom, yangyangiTop, subdivPerSeg * 2, true, true);
    } else {
      // ① 양양고자_하 → nock
      lerp(yangyangiBottom, nockPoint, subdivPerSeg, true, true);
      // ② nock → 양양고자_상
      lerp(nockPoint, yangyangiTop, subdivPerSeg, false, true);
    }
  }

  return { stringPoints, nockPoint };
}

// ─── 발시 후 활 진동의 물리적 파라미터 계산 ───
//
// 진동의 원인 (물리적 분석):
//   1) 만작 상태에서 활채에 탄성에너지 E_stored가 축적됨
//   2) 화살 이탈 시 η×E_stored(≈82%)가 화살 운동에너지로 전환
//   3) 남은 (1-η)×E_stored가 활채 진동에너지로 남음
//   4) 활채가 현걸이(brace) 위치로 되돌아오며 관성에 의해 오버슛
//   5) 결과: 고유진동수 ω₀ = √(k_eff/m_eff) 로 감쇠진동 발생
//
// 계산 단계:
//   k_eff : brace 근방 당김력(F) / nock 변위 구배 [N/m]
//   E_stored : brace→만작 사다리꼴 적분 [J]
//   m_eff : FRP/카본 활채 1차 굽힘 모드 유효질량 = 2×(0.236×m_limb + m_siyah) [kg]
//   A_grip: 화살 반동 초기속도 → 줌통 진동 진폭으로 환산
//
// 당김력 공식 (도르래 모델에 따라 분기):
//   [감김 모드] F = 2 × loadFactor × (nockX - dorae.x) / |dorae.y|
//   [직진 모드] F = 2 × loadFactor × (nockX - yangyangi.x) / |yangyangi.y|
//
function computeVibrationParams(params) {
  function getDrawForce(g) {
    const st = computeBowState(params, g.loadFactor);
    if (g.stringMode === 'dorae') {
      const doraeY = Math.abs(st.dorae.y);
      if (doraeY < 1e-6) return 0;
      return 2 * g.loadFactor * (g.nockX - st.dorae.x) / doraeY;
    } else {
      const yangY = Math.abs(st.yangyangi.y);
      if (yangY < 1e-6) return 0;
      return 2 * g.loadFactor * (g.nockX - st.yangyangi.x) / yangY;
    }
  }

  // 1) k_eff: brace→5% draw 구간 당김력 구배
  const g0 = generateBowGeometry(params, 0.00);
  const g1 = generateBowGeometry(params, 0.05);
  const F0 = getDrawForce(g0);
  const F1 = getDrawForce(g1);
  const k_eff = Math.max(10, (F1 - F0) / Math.max(g1.nockX - g0.nockX, 1e-4));

  // 2) E_stored: brace→만작 사다리꼴 적분 (20구간)
  let E_stored = 0;
  let prevF = F0, prevX = g0.nockX;
  for (let i = 1; i <= 20; i++) {
    const g = generateBowGeometry(params, i / 20);
    const F = getDrawForce(g);
    E_stored += (F + prevF) / 2 * (g.nockX - prevX);
    prevF = F; prevX = g.nockX;
  }

  // 3) m_eff: FRP/카본 개량궁 추정값
  //    활채 한쪽 ~50g, 고자 한쪽 ~10g
  //    1차 굽힘 모드 유효질량 계수: 0.236 (균일 외팔보 모드형상 적분)
  const m_limb_each = 0.050; // kg
  const m_siyah_each = 0.010; // kg
  const m_eff = 2 * (0.236 * m_limb_each + m_siyah_each); // ≈ 0.044 kg

  // 4) 자연 진동수
  const omega0 = Math.sqrt(k_eff / m_eff);
  const zeta = Math.min(Math.max(params.dampingRatio, 0.001), 0.99);
  const omega_d = omega0 * Math.sqrt(1 - zeta * zeta);

  // 5) 진동 진폭: 화살 반동 → 활 줌통 진동
  //    v_arrow = √(2η·E_stored / m_arrow)  →  p_arrow = m_arrow × v_arrow
  //    줌통 반동 초기속도 = (반동의 ~5%가 진동으로 전환) × p_arrow / m_bow
  //    활 효율 η=0.82, 화살 질량 m_arrow=25g, 활 질량 m_bow=300g
  const eta = 0.82;
  const m_arrow = 0.025; // kg
  const m_bow = 0.300;   // kg
  const v_arrow = Math.sqrt(Math.max(0, 2 * eta * E_stored / m_arrow));
  const p_arrow = m_arrow * v_arrow;
  // f_coupling ≈ 0.05: 반동 에너지 중 ~5%가 줌통 진동으로 전환
  // (나머지는 팔/몸/손가락으로 흡수; 한국 전통 사법: 개방형 손잡이)
  const f_coupling = 0.05;
  const v0_grip = f_coupling * p_arrow / m_bow;
  const A_grip = v0_grip / Math.max(omega_d, 1.0);

  return { omega0, omega_d, zeta, A_grip, k_eff, E_stored };
}

// ─── Three.js 메인 컴포넌트 ───
export default function KoreanBow3D() {
  const mountRef = useRef(null);
  const sceneRef = useRef(null);
  const rendererRef = useRef(null);
  const cameraRef = useRef(null);
  const frameRef = useRef(null);
  const bowGroupRef = useRef(null);
  const stringMeshRef = useRef(null);
  const arrowMeshRef = useRef(null);
  const gridRef = useRef(null);
  const flyingArrowRef = useRef(null);       // 발시 후 독립 비행하는 화살 메시
  const bowGeomDataRef = useRef(null);       // 렌더 루프에서 최신 bowGeomData 접근용
  const isArrowFlyingRef = useRef(false);    // 화살 비행 중 여부 (nock 화살 숨김)
  const mouseRef = useRef({ isDown: false, x: 0, y: 0, button: 0 });
  const cameraStateRef = useRef({ theta: 0, phi: Math.PI / 6, distance: 2.0, target: new THREE.Vector3(0.15, 0, 0) });

  const [drawAmount, setDrawAmount] = useState(0);
  const [params, setParams] = useState(DEFAULT_PARAMS);
  const [viewMode, setViewMode] = useState("3d");
  const [showString, setShowString] = useState(true);
  const [showArrow, setShowArrow] = useState(true);
  const [isAnimating, setIsAnimating] = useState(false);
  const [animPhase, setAnimPhase] = useState("idle");
  const animRef = useRef({ phase: "idle", t: 0 });
  const [showGrid, setShowGrid] = useState(true);

  // 에너지/힘 계산
  // 솔버 결과를 메모이즈 (활 기하학 + brace height 등 계산)
  const bowGeomData = useMemo(() => generateBowGeometry(params, drawAmount), [params, drawAmount]);
  const computedBraceHeight = bowGeomData.braceHeight;
  const computedLoadFactor = bowGeomData.loadFactor;

  // 렌더 루프(클로저)에서 최신 bowGeomData를 읽을 수 있도록 ref 동기화
  useEffect(() => { bowGeomDataRef.current = bowGeomData; }, [bowGeomData]);

  // ─── 씬 초기화 ───
  useEffect(() => {
    if (!mountRef.current) return;

    const width = mountRef.current.clientWidth;
    const height = mountRef.current.clientHeight;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1a2e);

    const camera = new THREE.PerspectiveCamera(50, width / height, 0.01, 100);
    camera.position.set(1.5, 0.3, 1.5);
    camera.lookAt(0.15, 0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    mountRef.current.appendChild(renderer.domElement);

    const ambientLight = new THREE.AmbientLight(0x404060, 0.6);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xfff5e6, 1.0);
    dirLight.position.set(2, 3, 2);
    dirLight.castShadow = true;
    scene.add(dirLight);

    const backLight = new THREE.DirectionalLight(0x6688cc, 0.3);
    backLight.position.set(-2, -1, -1);
    scene.add(backLight);

    const gridHelper = new THREE.GridHelper(2, 20, 0x444466, 0x2a2a4a);
    gridHelper.rotation.x = Math.PI / 2;
    scene.add(gridHelper);
    gridRef.current = gridHelper;

    const axesHelper = new THREE.AxesHelper(0.3);
    scene.add(axesHelper);

    sceneRef.current = scene;
    rendererRef.current = renderer;
    cameraRef.current = camera;

    const handleResize = () => {
      if (!mountRef.current) return;
      const w = mountRef.current.clientWidth;
      const h = mountRef.current.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      if (mountRef.current && renderer.domElement.parentNode === mountRef.current) {
        mountRef.current.removeChild(renderer.domElement);
      }
      renderer.dispose();
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    };
  }, []);

  // ─── 카메라 컨트롤 ───
  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;

    const onMouseDown = (e) => {
      mouseRef.current = { isDown: true, x: e.clientX, y: e.clientY, button: e.button };
    };
    const onMouseUp = () => { mouseRef.current.isDown = false; };
    const onMouseMove = (e) => {
      if (!mouseRef.current.isDown) return;
      const dx = e.clientX - mouseRef.current.x;
      const dy = e.clientY - mouseRef.current.y;
      mouseRef.current.x = e.clientX;
      mouseRef.current.y = e.clientY;

      const cs = cameraStateRef.current;
      if (mouseRef.current.button === 0) {
        cs.theta -= dx * 0.005;
        cs.phi = Math.max(-Math.PI / 2 + 0.1, Math.min(Math.PI / 2 - 0.1, cs.phi + dy * 0.005));
      } else if (mouseRef.current.button === 2) {
        cs.target.x += dx * 0.001;
        cs.target.y -= dy * 0.001;
      }
    };
    const onWheel = (e) => {
      e.preventDefault();
      const cs = cameraStateRef.current;
      cs.distance = Math.max(0.5, Math.min(5, cs.distance + e.deltaY * 0.001));
    };
    const onContextMenu = (e) => e.preventDefault();

    el.addEventListener("mousedown", onMouseDown);
    el.addEventListener("mouseup", onMouseUp);
    el.addEventListener("mousemove", onMouseMove);
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("contextmenu", onContextMenu);

    return () => {
      el.removeEventListener("mousedown", onMouseDown);
      el.removeEventListener("mouseup", onMouseUp);
      el.removeEventListener("mousemove", onMouseMove);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("contextmenu", onContextMenu);
    };
  }, []);

  // ─── 활 메쉬 업데이트 ───
  const updateBowMesh = useCallback((draw) => {
    const scene = sceneRef.current;
    if (!scene) return;

    // 기존 메쉬 제거
    if (bowGroupRef.current) {
      bowGroupRef.current.traverse(c => { if (c.geometry) c.geometry.dispose(); if (c.material) c.material.dispose(); });
      scene.remove(bowGroupRef.current);
    }
    if (stringMeshRef.current) {
      stringMeshRef.current.traverse(c => { if (c.geometry) c.geometry.dispose(); if (c.material) c.material.dispose(); });
      scene.remove(stringMeshRef.current);
    }
    if (arrowMeshRef.current) {
      arrowMeshRef.current.traverse(c => { if (c.geometry) c.geometry.dispose(); if (c.material) c.material.dispose(); });
      scene.remove(arrowMeshRef.current);
    }

    // 메모이즈된 활 기하학 사용
    const bowGeom = bowGeomData;

    const bowGroup = new THREE.Group();

    // 활체 재질 - FRP/카본
    const bowMaterial = new THREE.MeshPhysicalMaterial({
      color: 0x2a1a0a,
      roughness: 0.3,
      metalness: 0.1,
      clearcoat: 0.8,
      clearcoatRoughness: 0.2,
    });

    // 고자 재질 - 약간 다른 색상
    const siyahMaterial = new THREE.MeshPhysicalMaterial({
      color: 0x1a0f05,
      roughness: 0.25,
      metalness: 0.15,
      clearcoat: 0.9,
      clearcoatRoughness: 0.15,
    });

    // 도고자 재질 (빨간 가죽)
    const doraeMaterial = new THREE.MeshPhysicalMaterial({
      color: 0xaa2222,
      roughness: 0.7,
      metalness: 0.0,
    });

    // 활채 (줌통 포함) - 테이퍼링 적용 커스텀 튜브
    // TubeGeometry는 균일 반경만 지원하므로, 각 구간별로 개별 튜브 생성
    // limbRadii 배열에 각 점의 반경이 들어있음
    const limbPts = bowGeom.limbPoints;
    const limbRad = bowGeom.limbRadii;
    const radialSegments = 8;

    // 커스텀 BufferGeometry: 각 단면 링을 연결
    const positions = [];
    const normals = [];
    const indices = [];

    for (let i = 0; i < limbPts.length; i++) {
      const p = limbPts[i];
      const r = limbRad[i];

      // 접선 방향 계산
      let tangent;
      if (i === 0) {
        tangent = new THREE.Vector3().subVectors(limbPts[1], limbPts[0]).normalize();
      } else if (i === limbPts.length - 1) {
        tangent = new THREE.Vector3().subVectors(limbPts[i], limbPts[i - 1]).normalize();
      } else {
        tangent = new THREE.Vector3().subVectors(limbPts[i + 1], limbPts[i - 1]).normalize();
      }

      // 법선 프레임 구성 (Frenet-like)
      let up = new THREE.Vector3(0, 0, 1);
      const binormal = new THREE.Vector3().crossVectors(tangent, up).normalize();
      const normal = new THREE.Vector3().crossVectors(binormal, tangent).normalize();

      // 단면 링 생성
      for (let j = 0; j <= radialSegments; j++) {
        const theta = (j / radialSegments) * Math.PI * 2;
        const cos = Math.cos(theta);
        const sin = Math.sin(theta);

        const px = p.x + r * (cos * binormal.x + sin * normal.x);
        const py = p.y + r * (cos * binormal.y + sin * normal.y);
        const pz = p.z + r * (cos * binormal.z + sin * normal.z);

        const nx = cos * binormal.x + sin * normal.x;
        const ny = cos * binormal.y + sin * normal.y;
        const nz = cos * binormal.z + sin * normal.z;

        positions.push(px, py, pz);
        normals.push(nx, ny, nz);
      }
    }

    // 인덱스: 인접 링 사이 삼각형
    for (let i = 0; i < limbPts.length - 1; i++) {
      for (let j = 0; j < radialSegments; j++) {
        const a = i * (radialSegments + 1) + j;
        const b = a + radialSegments + 1;
        const c = a + 1;
        const d = b + 1;
        indices.push(a, b, c);
        indices.push(c, b, d);
      }
    }

    const limbGeom = new THREE.BufferGeometry();
    limbGeom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    limbGeom.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
    limbGeom.setIndex(indices);
    const limbMesh = new THREE.Mesh(limbGeom, bowMaterial);
    limbMesh.castShadow = true;
    bowGroup.add(limbMesh);

    // 상단 고자
    const topSiyahPoints = [];
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      topSiyahPoints.push(new THREE.Vector3(
        bowGeom.doraeTop.x + bowGeom.siyahDirTop.x * params.siyahLength * t,
        bowGeom.doraeTop.y + bowGeom.siyahDirTop.y * params.siyahLength * t,
        0
      ));
    }
    const topSiyahCurve = new THREE.CatmullRomCurve3(topSiyahPoints);
    const topSiyahGeom = new THREE.TubeGeometry(topSiyahCurve, 8, params.limbWidth * 0.35, 8, false);
    bowGroup.add(new THREE.Mesh(topSiyahGeom, siyahMaterial));

    // 하단 고자
    const bottomSiyahPoints = [];
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      bottomSiyahPoints.push(new THREE.Vector3(
        bowGeom.doraeBottom.x + bowGeom.siyahDirBottom.x * params.siyahLength * t,
        bowGeom.doraeBottom.y + bowGeom.siyahDirBottom.y * params.siyahLength * t,
        0
      ));
    }
    const bottomSiyahCurve = new THREE.CatmullRomCurve3(bottomSiyahPoints);
    const bottomSiyahGeom = new THREE.TubeGeometry(bottomSiyahCurve, 8, params.limbWidth * 0.35, 8, false);
    bowGroup.add(new THREE.Mesh(bottomSiyahGeom, siyahMaterial));

    // 도고자 표시 (빨간 가죽 링)
    const doraeRadius = params.limbWidth * 0.5;
    const doraeGeom = new THREE.SphereGeometry(doraeRadius, 8, 8);
    const doraeTopMesh = new THREE.Mesh(doraeGeom, doraeMaterial);
    doraeTopMesh.position.copy(bowGeom.doraeTop);
    bowGroup.add(doraeTopMesh);
    const doraeBottomMesh = new THREE.Mesh(doraeGeom.clone(), doraeMaterial);
    doraeBottomMesh.position.copy(bowGeom.doraeBottom);
    bowGroup.add(doraeBottomMesh);

    scene.add(bowGroup);
    bowGroupRef.current = bowGroup;

    // 시위 (양양고자 → nock → 양양고자 직선 경로)
    if (showString) {
      const { stringPoints, nockPoint } = generateStringPath(bowGeom, draw);
      const stringGroup = new THREE.Group();

      const stringMat = new THREE.MeshPhysicalMaterial({
        color: 0xe8d8b8,
        roughness: 0.6,
        metalness: 0.0,
      });
      const strR = params.stringDiameter * 0.5;

      // 시위는 직선 구간이므로 CatmullRomCurve3로 렌더링
      const stringCurve = new THREE.CatmullRomCurve3(stringPoints);
      const stringGeom = new THREE.TubeGeometry(stringCurve, 30, strR, 6, false);
      stringGroup.add(new THREE.Mesh(stringGeom, stringMat));

      // 양양고자 고리 표시 (시위가 고자에 걸리는 O고리)
      const loopMat = new THREE.MeshPhysicalMaterial({ color: 0xd0c0a0, roughness: 0.5 });
      const loopGeom = new THREE.TorusGeometry(params.stringDiameter * 2, params.stringDiameter * 0.8, 8, 12);
      const loopTop = new THREE.Mesh(loopGeom, loopMat);
      loopTop.position.copy(bowGeom.yangyangiTop);
      stringGroup.add(loopTop);
      const loopBottom = new THREE.Mesh(loopGeom.clone(), loopMat);
      loopBottom.position.copy(bowGeom.yangyangiBottom);
      stringGroup.add(loopBottom);

      scene.add(stringGroup);
      stringMeshRef.current = stringGroup;

      // 화살 (비행 중이면 nock 화살 숨김 — 독립 flyingArrowRef가 담당)
      if (showArrow && draw > 0.01 && !isArrowFlyingRef.current) {
        const arrowGroup = new THREE.Group();
        const arrowLen = 0.82; // 82cm (죽시 기준)

        // 화살대
        const shaftGeom = new THREE.CylinderGeometry(0.004, 0.004, arrowLen, 8);
        const shaftMat = new THREE.MeshPhysicalMaterial({ color: 0x1a1a1a, roughness: 0.4, metalness: 0.6 });
        const shaft = new THREE.Mesh(shaftGeom, shaftMat);
        shaft.rotation.z = Math.PI / 2;
        shaft.position.set(nockPoint.x - arrowLen / 2, 0, 0);
        arrowGroup.add(shaft);

        // 촉
        const tipGeom = new THREE.ConeGeometry(0.006, 0.04, 6);
        const tipMat = new THREE.MeshPhysicalMaterial({ color: 0x888888, metalness: 0.8, roughness: 0.2 });
        const tip = new THREE.Mesh(tipGeom, tipMat);
        tip.rotation.z = -Math.PI / 2;
        tip.position.set(nockPoint.x - arrowLen - 0.02, 0, 0);
        arrowGroup.add(tip);

        // 깃
        for (let fi = 0; fi < 3; fi++) {
          const angle = (fi / 3) * Math.PI * 2;
          const fletchGeom = new THREE.PlaneGeometry(0.06, 0.015);
          const fletchMat = new THREE.MeshPhysicalMaterial({
            color: fi === 0 ? 0xcc2222 : 0xeeeeee,
            side: THREE.DoubleSide, roughness: 0.8
          });
          const fletch = new THREE.Mesh(fletchGeom, fletchMat);
          fletch.position.set(nockPoint.x + 0.05, Math.sin(angle) * 0.008, Math.cos(angle) * 0.008);
          fletch.rotation.x = angle;
          arrowGroup.add(fletch);
        }

        scene.add(arrowGroup);
        arrowMeshRef.current = arrowGroup;
      }
    }

    if (gridRef.current) gridRef.current.visible = showGrid;

  }, [params, showString, showArrow, showGrid, bowGeomData]);

  // ─── 렌더 루프 ───
  useEffect(() => {
    const animate = () => {
      frameRef.current = requestAnimationFrame(animate);

      const camera = cameraRef.current;
      const renderer = rendererRef.current;
      const scene = sceneRef.current;
      if (!camera || !renderer || !scene) return;

      if (isAnimating) {
        const anim = animRef.current;
        anim.t += 0.008;

        if (anim.phase === "drawing") {
          const d = Math.min(1, anim.t * 0.5);
          setDrawAmount(d);
          if (d >= 1) { anim.phase = "holding"; anim.t = 0; setAnimPhase("holding"); }
        } else if (anim.phase === "holding") {
          if (anim.t > 0.5) { anim.phase = "releasing"; anim.t = 0; setAnimPhase("releasing"); }
        } else if (anim.phase === "releasing") {
          // 실제 발시 시간 ~0.1초 반영: anim.t * 20 → d=0 when anim.t=0.05 (≈0.1 real s)
          const d = Math.max(0, 1 - anim.t * 20);
          setDrawAmount(d);
          if (d <= 0) {
            anim.phase = "bowVibration";
            anim.t = 0;
            // 발사 순간의 nock 위치 캡처 (화살 초기 위치)
            anim.arrowX = bowGeomDataRef.current ? bowGeomDataRef.current.nockX : 0.8;
            anim.needArrowCreate = true;
            isArrowFlyingRef.current = true;
            setAnimPhase("bowVibration");
          }
        } else if (anim.phase === "bowVibration") {
          // 발시 후 1초: 활 진동 + 화살 비행
          // anim.t * (1/0.48) = 실제 시간(초), 0.48 t-units ≈ 1 real second
          const t_real = anim.t / 0.48;

          // ── 활 진동: 물리 기반 감쇠진동 ──
          // 원인: 활채 탄성복원력(k_eff)과 유효질량(m_eff)의 결합 → ω₀ = √(k_eff/m_eff)
          // 진폭: 화살 반동 운동량 → 개방형 손잡이를 통한 줌통 진동 초기속도
          if (bowGroupRef.current && stringMeshRef.current) {
            const { omega0, omega_d, zeta, A_grip } = anim.vibParams;
            const vib = A_grip * Math.exp(-zeta * omega0 * t_real) * Math.sin(omega_d * t_real);
            bowGroupRef.current.position.x = vib;
            stringMeshRef.current.position.x = vib;
          }

          // ── 화살 생성 (첫 프레임) ──
          if (anim.needArrowCreate && sceneRef.current) {
            anim.needArrowCreate = false;
            const arrowLen = 0.82;
            const ag = new THREE.Group();

            const shaftGeom = new THREE.CylinderGeometry(0.004, 0.004, arrowLen, 8);
            const shaftMat = new THREE.MeshPhysicalMaterial({ color: 0x1a1a1a, roughness: 0.4, metalness: 0.6 });
            const shaft = new THREE.Mesh(shaftGeom, shaftMat);
            shaft.rotation.z = Math.PI / 2;
            ag.add(shaft);

            const tipGeom = new THREE.ConeGeometry(0.006, 0.04, 6);
            const tipMat = new THREE.MeshPhysicalMaterial({ color: 0x888888, metalness: 0.8, roughness: 0.2 });
            const tip = new THREE.Mesh(tipGeom, tipMat);
            tip.rotation.z = -Math.PI / 2;
            tip.position.set(-arrowLen / 2 - 0.02, 0, 0);
            ag.add(tip);

            for (let fi = 0; fi < 3; fi++) {
              const ang = (fi / 3) * Math.PI * 2;
              const fletchGeom = new THREE.PlaneGeometry(0.06, 0.015);
              const fletchMat = new THREE.MeshPhysicalMaterial({
                color: fi === 0 ? 0xcc2222 : 0xeeeeee, side: THREE.DoubleSide, roughness: 0.8
              });
              const fletch = new THREE.Mesh(fletchGeom, fletchMat);
              fletch.position.set(arrowLen / 2 + 0.05, Math.sin(ang) * 0.008, Math.cos(ang) * 0.008);
              fletch.rotation.x = ang;
              ag.add(fletch);
            }

            // 화살 그룹의 원점 = 화살 중심. nock 위치에서 반 화살 길이만큼 앞쪽이 중심
            ag.position.set(anim.arrowX - arrowLen / 2, 0, 0);
            sceneRef.current.add(ag);
            flyingArrowRef.current = ag;
          }

          // ── 화살 비행: 46 m/s (≈150 fps) 음의 x방향 (표적 방향) ──
          if (flyingArrowRef.current) {
            const dt = 0.008 / 0.48; // 1 t-unit = 1/0.48 s, 1 frame = 0.008 t-units
            anim.arrowX -= 46 * dt;
            flyingArrowRef.current.position.x = anim.arrowX - 0.41; // 중심 오프셋(arrowLen/2)
            flyingArrowRef.current.visible = (anim.arrowX > -3);
          }

          // ── 1초 경과 → 종료 및 정리 ──
          if (anim.t > 0.48) {
            anim.phase = "idle";
            setIsAnimating(false);
            setAnimPhase("idle");
            setDrawAmount(0);
            isArrowFlyingRef.current = false;
            if (bowGroupRef.current) bowGroupRef.current.position.x = 0;
            if (stringMeshRef.current) stringMeshRef.current.position.x = 0;
            if (flyingArrowRef.current && sceneRef.current) {
              flyingArrowRef.current.traverse(c => {
                if (c.geometry) c.geometry.dispose();
                if (c.material) c.material.dispose();
              });
              sceneRef.current.remove(flyingArrowRef.current);
              flyingArrowRef.current = null;
            }
          }
        }
      }

      const cs = cameraStateRef.current;
      if (viewMode === "side") {
        camera.position.set(cs.target.x, cs.target.y, cs.distance);
        camera.lookAt(cs.target.x, cs.target.y, 0);
      } else if (viewMode === "top") {
        camera.position.set(cs.target.x, cs.distance, cs.target.y);
        camera.lookAt(cs.target.x, 0, cs.target.y);
      } else {
        camera.position.set(
          cs.target.x + cs.distance * Math.cos(cs.phi) * Math.sin(cs.theta),
          cs.target.y + cs.distance * Math.sin(cs.phi),
          cs.distance * Math.cos(cs.phi) * Math.cos(cs.theta)
        );
        camera.lookAt(cs.target);
      }

      renderer.render(scene, camera);
    };

    animate();
    return () => { if (frameRef.current) cancelAnimationFrame(frameRef.current); };
  }, [viewMode, isAnimating]);

  useEffect(() => {
    updateBowMesh(drawAmount);
  }, [drawAmount, params, showString, showArrow, showGrid, updateBowMesh]);

  const startAnimation = () => {
    // 이전 비행 화살 정리
    if (flyingArrowRef.current && sceneRef.current) {
      flyingArrowRef.current.traverse(c => {
        if (c.geometry) c.geometry.dispose();
        if (c.material) c.material.dispose();
      });
      sceneRef.current.remove(flyingArrowRef.current);
      flyingArrowRef.current = null;
    }
    isArrowFlyingRef.current = false;
    if (bowGroupRef.current) bowGroupRef.current.position.x = 0;
    if (stringMeshRef.current) stringMeshRef.current.position.x = 0;

    // 물리 기반 진동 파라미터 사전 계산 (params에 접근 가능한 시점에서 수행)
    const vibParams = computeVibrationParams(params);
    animRef.current = { phase: "drawing", t: 0, vibParams };
    setAnimPhase("drawing");
    setIsAnimating(true);
    setDrawAmount(0);
  };

  const updateParam = (key, value) => {
    setParams(prev => ({ ...prev, [key]: value }));
  };

  const currentDrawCm = bowGeomData.nockX * 100;

  return (
    <div style={{
      width: "100%", height: "100vh", display: "flex", flexDirection: "column",
      fontFamily: "'Pretendard', 'Noto Sans KR', sans-serif", background: "#0f0f23", color: "#e8e8f0"
    }}>
      {/* 타이틀 바 */}
      <div style={{
        padding: "12px 20px", background: "linear-gradient(135deg, #1a1a3e, #2a1a3e)",
        borderBottom: "1px solid #333366", display: "flex", justifyContent: "space-between", alignItems: "center"
      }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "#fff" }}>
            국궁 개량궁 3D 동역학 모델
          </h1>
          <span style={{ fontSize: 12, color: "#8888aa" }}>FRP/카본 복합재 반곡궁 — 줌통·활채·고자·시위 구조 모델</span>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {["3d", "side", "top"].map(v => (
            <button key={v} onClick={() => setViewMode(v)}
              style={{
                padding: "4px 12px", fontSize: 12, border: "1px solid #444", borderRadius: 4,
                background: viewMode === v ? "#4a4a8a" : "#2a2a4a", color: "#ddd", cursor: "pointer"
              }}>
              {v === "3d" ? "3D" : v === "side" ? "측면" : "상면"}
            </button>
          ))}
        </div>
      </div>

      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        {/* 3D 뷰포트 */}
        <div ref={mountRef} style={{ flex: 1, position: "relative" }}>
          <div style={{
            position: "absolute", top: 12, left: 12, background: "rgba(10,10,30,0.85)",
            borderRadius: 8, padding: 12, fontSize: 12, lineHeight: 1.8, minWidth: 200,
            border: "1px solid #333366"
          }}>
            <div style={{ fontWeight: 700, marginBottom: 4, color: "#aaaacc" }}>실시간 물리량</div>
            <div>Nock 위치: <b style={{ color: "#ffcc44" }}>{currentDrawCm.toFixed(1)} cm</b></div>
            <div>Brace height: <b style={{ color: "#88ddff" }}>{(computedBraceHeight * 100).toFixed(1)} cm</b> (계산값)</div>
            <div>활채 하중: <b style={{ color: "#ff7744" }}>{computedLoadFactor.toFixed(1)} N</b></div>
            <div>당김 비율: <b style={{ color: "#88ff88" }}>{(drawAmount * 100).toFixed(0)}%</b></div>
          </div>

          {/* 구조 범례 */}
          <div style={{
            position: "absolute", bottom: 12, left: 12, background: "rgba(10,10,30,0.85)",
            borderRadius: 8, padding: 10, fontSize: 11, lineHeight: 1.6,
            border: "1px solid #333366"
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
              <span style={{ width: 12, height: 4, background: "#5a3a1a", display: "inline-block", borderRadius: 2 }}></span>
              활채 (탄성체)
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
              <span style={{ width: 12, height: 4, background: "#3a2010", display: "inline-block", borderRadius: 2 }}></span>
              고자 (강체)
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
              <span style={{ width: 8, height: 8, background: "#aa2222", display: "inline-block", borderRadius: 4 }}></span>
              도고자 (접합부)
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 12, height: 2, background: "#e8d8b8", display: "inline-block" }}></span>
              시위 (비신장 유연체)
            </div>
          </div>

          {isAnimating && (
            <div style={{
              position: "absolute", top: 12, right: 12, background: "rgba(200,50,50,0.8)",
              borderRadius: 8, padding: "8px 16px", fontSize: 13, fontWeight: 600
            }}>
              {animPhase === "drawing" ? "당기는 중..." : animPhase === "holding" ? "만작 유지" : animPhase === "releasing" ? "발시!" : "화살 비행 중..."}
            </div>
          )}
        </div>

        {/* 컨트롤 패널 */}
        <div style={{
          width: 300, background: "#12122a", borderLeft: "1px solid #333366",
          overflowY: "auto", padding: 16, fontSize: 13
        }}>
          {/* 당김 슬라이더 */}
          <div style={{ marginBottom: 20 }}>
            <label style={{ display: "block", fontWeight: 700, marginBottom: 8, color: "#aaaacc" }}>
              당김 조절 (0% = brace height, 100% = 만작)
            </label>
            <input type="range" min="0" max="1" step="0.01" value={drawAmount}
              onChange={e => setDrawAmount(parseFloat(e.target.value))}
              style={{ width: "100%", accentColor: "#6666cc" }} />
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#666" }}>
              <span>Brace height ({(computedBraceHeight * 100).toFixed(1)}cm)</span>
              <span>만작 ({(params.maxDraw * 100).toFixed(0)}cm)</span>
            </div>
          </div>

          <button onClick={startAnimation} disabled={isAnimating}
            style={{
              width: "100%", padding: "10px", marginBottom: 20, fontSize: 14, fontWeight: 700,
              background: isAnimating ? "#333" : "linear-gradient(135deg, #cc4444, #884422)",
              color: "#fff", border: "none", borderRadius: 6, cursor: isAnimating ? "default" : "pointer"
            }}>
            {isAnimating ? "시뮬레이션 진행 중..." : "▶ 발시 시뮬레이션"}
          </button>

          {/* 표시 옵션 */}
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontWeight: 700, marginBottom: 8, color: "#aaaacc" }}>표시 옵션</div>
            {[
              ["showString", showString, setShowString, "시위"],
              ["showArrow", showArrow, setShowArrow, "화살"],
              ["showGrid", showGrid, setShowGrid, "격자"],
            ].map(([key, val, setter, label]) => (
              <label key={key} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, cursor: "pointer" }}>
                <input type="checkbox" checked={val} onChange={e => setter(e.target.checked)}
                  style={{ accentColor: "#6666cc" }} />
                {label}
              </label>
            ))}
          </div>

          {/* 활 구조 파라미터 */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontWeight: 700, marginBottom: 8, color: "#aaaacc", borderBottom: "1px solid #333", paddingBottom: 4 }}>
              활 구조
            </div>

            {[
              { key: "bowLength", label: "활 전체 길이", unit: "cm", min: 100, max: 150, step: 1, scale: 100 },
              { key: "gripLength", label: "줌통 길이", unit: "cm", min: 8, max: 20, step: 0.5, scale: 100 },
              { key: "siyahLength", label: "고자 길이", unit: "cm", min: 4, max: 14, step: 0.5, scale: 100 },
              { key: "siyahAngle", label: "고자 각도", unit: "°", min: 45, max: 90, step: 1, scale: 1 },
              { key: "stringLength", label: "시위 길이", unit: "cm", min: 95, max: 125, step: 0.5, scale: 100 },
              { key: "maxDraw", label: "만작 거리", unit: "cm", min: 65, max: 95, step: 1, scale: 100 },
            ].map(({ key, label, unit, min, max, step, scale }) => (
              <div key={key} style={{ marginBottom: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 2 }}>
                  <span>{label}</span>
                  <span style={{ color: "#ffcc44" }}>
                    {(params[key] * scale).toFixed(scale >= 100 ? 0 : 1)} {unit}
                  </span>
                </div>
                <input type="range" min={min} max={max} step={step}
                  value={params[key] * scale}
                  onChange={e => updateParam(key, parseFloat(e.target.value) / scale)}
                  style={{ width: "100%", accentColor: "#6666cc" }} />
              </div>
            ))}
          </div>

          {/* 활채 형상 */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontWeight: 700, marginBottom: 8, color: "#aaaacc", borderBottom: "1px solid #333", paddingBottom: 4 }}>
              활채 형상
            </div>

            {[
              { key: "gripAngle", label: "줌통 V각도", unit: "°", min: 0, max: 25, step: 1, scale: 1 },
              { key: "reflexAngle", label: "반곡 각도", unit: "°", min: 15, max: 55, step: 1, scale: 1 },
              { key: "naturalCurvature", label: "자연 곡률", unit: "", min: 0.3, max: 1.5, step: 0.05, scale: 1 },
            ].map(({ key, label, unit, min, max, step, scale }) => (
              <div key={key} style={{ marginBottom: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 2 }}>
                  <span>{label}</span>
                  <span style={{ color: "#ffcc44" }}>
                    {(params[key] * scale).toFixed(key === "naturalCurvature" ? 2 : 1)} {unit}
                  </span>
                </div>
                <input type="range" min={min} max={max} step={step}
                  value={params[key] * scale}
                  onChange={e => updateParam(key, parseFloat(e.target.value) / scale)}
                  style={{ width: "100%", accentColor: "#6666cc" }} />
              </div>
            ))}
          </div>

          {/* 재질 */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontWeight: 700, marginBottom: 8, color: "#aaaacc", borderBottom: "1px solid #333", paddingBottom: 4 }}>
              재질 특성
            </div>
            {[
              { key: "elasticModulus", label: "탄성계수", unit: "GPa", min: 20, max: 80, step: 1, toVal: v => v / 1e9, fromVal: v => v * 1e9 },
              { key: "limbWidth", label: "활채 폭", unit: "mm", min: 20, max: 40, step: 1, toVal: v => v * 1000, fromVal: v => v / 1000 },
              { key: "limbThickness", label: "활채 두께", unit: "mm", min: 8, max: 18, step: 0.5, toVal: v => v * 1000, fromVal: v => v / 1000 },
            ].map(({ key, label, unit, min, max, step, toVal, fromVal }) => (
              <div key={key} style={{ marginBottom: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 2 }}>
                  <span>{label}</span>
                  <span style={{ color: "#ffcc44" }}>{toVal(params[key]).toFixed(key === "limbThickness" ? 1 : 0)} {unit}</span>
                </div>
                <input type="range" min={min} max={max} step={step}
                  value={toVal(params[key])}
                  onChange={e => updateParam(key, fromVal(parseFloat(e.target.value)))}
                  style={{ width: "100%", accentColor: "#6666cc" }} />
              </div>
            ))}
          </div>

          {/* 물리량 요약 */}
          <div style={{
            background: "#1a1a3a", borderRadius: 8, padding: 12, fontSize: 12,
            border: "1px solid #333366"
          }}>
            <div style={{ fontWeight: 700, marginBottom: 8, color: "#aaaacc" }}>물리량 요약</div>
            <div style={{ lineHeight: 2 }}>
              <div>줌통부 EI: <b>{((params.elasticModulus * params.limbWidth * Math.pow(params.limbThickness, 3)) / 12).toFixed(2)} N·m²</b></div>
              <div>Brace height: <b>{(computedBraceHeight * 100).toFixed(1)} cm</b></div>
              <div>현재 Nock 위치: <b>{currentDrawCm.toFixed(1)} cm</b></div>
              <div>하중 인자: <b>{computedLoadFactor.toFixed(2)}</b></div>
              <div>활채 호 길이: <b>{((params.bowLength / 2 - params.gripLength / 2 - params.siyahLength) * 100).toFixed(1)} cm</b></div>
            </div>
          </div>

          <div style={{ marginTop: 16, fontSize: 11, color: "#666", lineHeight: 1.8 }}>
            <div style={{ fontWeight: 600, color: "#888" }}>조작 방법</div>
            <div>좌클릭 드래그: 회전</div>
            <div>우클릭 드래그: 이동</div>
            <div>스크롤: 줌</div>
          </div>
        </div>
      </div>
    </div>
  );
}
