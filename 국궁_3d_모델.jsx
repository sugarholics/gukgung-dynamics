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
  limbAsymmetryRatio: 1.0, // 하채/상채 강성비 (1.0=대칭, 0.8~1.5)

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

  // 줌통 강성비 (연속 탄성체 모델)
  // 줌통 EI = 활채 근부 EI × gripStiffnessRatio
  // 실제 개량궁: FRP/카본 보강으로 활채보다 10~30배 강성
  gripStiffnessRatio: 15, // 줌통/활채 강성비

  // 접촉점 오프셋 (사법 모델링)
  nockingOffset: 0.005,   // 오니 y오프셋 (m) — 시위 힘 중심보다 위 (화살대 직경)
  pullOffset: -0.015,     // 당김점 y오프셋 (m) — 오니보다 아래 (엄지 위치)
  restOffsetY: 0.003,     // 화살걸이 y오프셋 (m) — 줌통 중심보다 위
};

// ─── 연속 보 EI(s) 프로파일 및 자연곡률 κ₀(s) ───
// 활 전체를 하나의 연속 보로 모델링: 하채끝 → 하채 → 줌통 → 상채 → 상채끝
// 줌통도 탄성체로 포함하여 C¹ 연속성 (위치+기울기 연속) 보장

// 한쪽 반(grip center → limb tip)에 대한 EI, 두께, 폭, 자연곡률 프로파일
// sHalf: 그립 중심(0)에서의 호 길이. 0 = 그립 중심, halfGrip = 줌통 끝, halfGrip + limbArcLen = 활채 끝
function getBeamProfile(sHalf, params, limbSide = 'upper') {
  const {
    gripLength, elasticModulus, limbThickness, limbWidth,
    reflexAngle, naturalCurvature
  } = params;
  const gripStiffnessRatio = params.gripStiffnessRatio || 15;
  const asymRatio = (limbSide === 'lower') ? (params.limbAsymmetryRatio || 1.0) : 1.0;
  const halfGrip = gripLength / 2;
  const halfLen = params.bowLength / 2;
  const limbArcLen = halfLen - halfGrip - params.siyahLength;
  const reflexRad = (reflexAngle * Math.PI) / 180;

  // 줌통-활채 전이 구간 (코사인 보간)
  const transitionWidth = 0.015; // 1.5cm

  // 활채 두께/폭 테이퍼 — 하채는 asymRatio^(1/3) 스케일
  const thicknessScale = Math.pow(asymRatio, 1/3);
  const taperRatio = 0.55;
  function limbThicknessAt(sLimb) {
    const ratio = sLimb / limbArcLen;
    return limbThickness * thicknessScale * (1 - taperRatio * Math.min(ratio, 1));
  }
  function limbWidthAt(sLimb) {
    const ratio = sLimb / limbArcLen;
    return limbWidth * (1 - 0.3 * Math.min(ratio, 1));
  }

  // 활채 근부(줌통 접합부) EI — 하채는 asymRatio 적용
  const limbRootEI = elasticModulus * limbWidth * limbThickness * limbThickness * limbThickness / 12 * asymRatio;
  const gripEI = limbRootEI * gripStiffnessRatio;

  let EI, h, w, kappa0;

  if (sHalf <= halfGrip - transitionWidth) {
    // 순수 줌통 구간
    EI = gripEI;
    h = limbThickness * thicknessScale * 1.3; // 줌통은 활채보다 약간 두꺼움 (렌더링용)
    w = limbWidth * 1.2;
    kappa0 = 0; // 줌통 자연곡률 ≈ 0
  } else if (sHalf <= halfGrip + transitionWidth) {
    // 전이 구간: 코사인 보간
    const t = (sHalf - (halfGrip - transitionWidth)) / (2 * transitionWidth);
    const blend = (1 - Math.cos(Math.PI * t)) / 2; // 0→1 부드럽게
    const sLimb = Math.max(0, sHalf - halfGrip);
    const limbEI_here = elasticModulus * limbWidthAt(sLimb) *
      Math.pow(limbThicknessAt(sLimb), 3) / 12;
    EI = gripEI * (1 - blend) + limbEI_here * blend;
    h = limbThickness * thicknessScale * 1.3 * (1 - blend) + limbThicknessAt(sLimb) * blend;
    w = limbWidth * 1.2 * (1 - blend) + limbWidthAt(sLimb) * blend;
    // 자연곡률도 전이
    const ratio = sLimb / limbArcLen;
    const limbK0 = -reflexRad * naturalCurvature * Math.sin(ratio * Math.PI * 0.8) * 2.0 / limbArcLen;
    kappa0 = limbK0 * blend;
  } else {
    // 순수 활채 구간
    const sLimb = sHalf - halfGrip;
    h = limbThicknessAt(sLimb);
    w = limbWidthAt(sLimb);
    EI = elasticModulus * w * h * h * h / 12;
    const ratio = sLimb / limbArcLen;
    kappa0 = -reflexRad * naturalCurvature * Math.sin(ratio * Math.PI * 0.8) * 2.0 / limbArcLen;
  }

  return { EI, h, w, kappa0 };
}

// ─── 전체 보 곡률 적분 (연속 탄성체 모델) ───
// 그립 중심에서 시작하여 상채 방향(+y)으로 적분한 후,
// 대칭으로 하채를 구성한다.
// kappaLoadFn: (sHalf, EI) => 하중 곡률값. 솔버가 주입하는 콜백.
//   - Step 1 호환용: (sHalf, EI) => -loadFactor * (limbArcLen - max(0, sLimb)) / EI
//   - Step 3 이후: (sHalf, EI) => -M(s) / EI  (변형 형상 기반 모멘트)
function generateFullBeam(params, kappaLoadFn, limbSide = 'upper') {
  const { gripLength, bowLength, siyahLength } = params;
  const gripAngle = params.gripAngle || 0;
  const gripAngleRad = (gripAngle * Math.PI) / 180;
  const halfGrip = gripLength / 2;
  const halfLen = bowLength / 2;
  const limbArcLen = halfLen - halfGrip - siyahLength;
  const totalHalf = halfGrip + limbArcLen; // 그립 중심 → 활채 끝

  // 분할: 줌통 10 + 활채 40 = 50구간
  const N_grip = 10;
  const N_limb = 40;
  const N_total = N_grip + N_limb;

  // 각 구간의 ds 계산
  const ds_grip = halfGrip / N_grip;
  const ds_limb = limbArcLen / N_limb;

  // 적분 시작점: 그립 중심 (0, 0), 초기 각도 = π/2 + gripAngle
  const points = [];
  const thicknesses = [];
  const widths = [];

  let angle = Math.PI / 2 + gripAngleRad;
  let x = 0, y = 0;

  points.push({ x, y, angle });
  const profile0 = getBeamProfile(0, params, limbSide);
  thicknesses.push(profile0.h);
  widths.push(profile0.w);

  for (let i = 0; i < N_total; i++) {
    const isGrip = i < N_grip;
    const ds = isGrip ? ds_grip : ds_limb;
    // 구간 중점의 호 길이
    const sHalf = isGrip
      ? (i + 0.5) * ds_grip
      : halfGrip + (i - N_grip + 0.5) * ds_limb;

    const profile = getBeamProfile(sHalf, params, limbSide);

    // 하중 곡률 (솔버 콜백)
    const kappaLoad = kappaLoadFn ? kappaLoadFn(sHalf, profile.EI) : 0;

    // 총 곡률 = 자연 곡률 + 하중 곡률
    const kappa = profile.kappa0 + kappaLoad;

    angle += kappa * ds;
    x += Math.cos(angle) * ds;
    y += Math.sin(angle) * ds;

    points.push({ x, y, angle });
    thicknesses.push(profile.h);
    widths.push(profile.w);
  }

  return {
    points,          // [0]=그립중심, ... [N_total]=활채끝
    thicknesses,
    widths,
    N_grip,
    N_limb,
    limbArcLen,
    halfGrip,
  };
}

// ─── Step 1 호환용: loadFactor 기반 하중 곡률 콜백 ───
// 기존 generateOneLimb의 캔틸레버 모멘트 분포를 연속 보에 매핑
function makeLoadFactorKappaFn(params, loadFactor) {
  const halfGrip = params.gripLength / 2;
  const halfLen = params.bowLength / 2;
  const limbArcLen = halfLen - halfGrip - params.siyahLength;

  return function(sHalf, EI) {
    // 줌통 구간: 모멘트 = loadFactor * limbArcLen (최대, 일정)
    // 활채 구간: 모멘트 = loadFactor * (limbArcLen - sLimb) (캔틸레버 분포)
    const sLimb = Math.max(0, sHalf - halfGrip);
    const moment = loadFactor * Math.max(0, limbArcLen - sLimb);
    return -moment / EI;
  };
}

// ─── 무현(unstrung) 기준 형상 계산 ───
// 외력 없이 자연곡률 κ₀(s)만으로 형상 결정.
// 반환: 전체 보 좌표(상채/하채 독립) + 하채 대칭 + 고자 끝점
function computeRestShape(params) {
  const { siyahLength, siyahAngle } = params;
  const siyahRad = (siyahAngle * Math.PI) / 180;

  // 상채/하채 독립 적분 → 비대칭 강성 지원
  const beamUpper = generateFullBeam(params, null, 'upper');
  const beamLower = generateFullBeam(params, null, 'lower');

  // 상채 고자 끝점 계산 (활채 끝에서 siyahAngle만큼 꺾임)
  const limbEndUpper = beamUpper.points[beamUpper.points.length - 1];
  const endAngleUpper = limbEndUpper.angle;
  const tangentUpper = { x: Math.cos(endAngleUpper), y: Math.sin(endAngleUpper) };
  const cosS = Math.cos(siyahRad);
  const sinS = Math.sin(siyahRad);
  const siyahDirUpper = {
    x: tangentUpper.x * cosS - tangentUpper.y * sinS,
    y: tangentUpper.y * cosS + tangentUpper.x * sinS,
  };
  const normUpper = Math.sqrt(siyahDirUpper.x ** 2 + siyahDirUpper.y ** 2);
  siyahDirUpper.x /= normUpper;
  siyahDirUpper.y /= normUpper;

  const doraeTop = { x: limbEndUpper.x, y: limbEndUpper.y };
  const yangyangiTop = {
    x: doraeTop.x + siyahDirUpper.x * siyahLength,
    y: doraeTop.y + siyahDirUpper.y * siyahLength,
  };

  // 하채 고자 끝점 계산 (beamLower는 +y 방향으로 적분됨 → y 부호 반전)
  const limbEndLower = beamLower.points[beamLower.points.length - 1];
  const endAngleLower = limbEndLower.angle;
  const tangentLower = { x: Math.cos(endAngleLower), y: Math.sin(endAngleLower) };
  const siyahDirLower_raw = {
    x: tangentLower.x * cosS - tangentLower.y * sinS,
    y: tangentLower.y * cosS + tangentLower.x * sinS,
  };
  const normLower = Math.sqrt(siyahDirLower_raw.x ** 2 + siyahDirLower_raw.y ** 2);
  siyahDirLower_raw.x /= normLower;
  siyahDirLower_raw.y /= normLower;

  // 적분 결과의 y 부호를 반전하여 실제 하채 위치 산출
  const doraeBottom = { x: limbEndLower.x, y: -limbEndLower.y };
  const yangyangiBottom = {
    x: limbEndLower.x + siyahDirLower_raw.x * siyahLength,
    y: -(limbEndLower.y + siyahDirLower_raw.y * siyahLength),
  };

  // 전체 활 포인트 (하채 + 그립 + 상채) — 렌더링용
  const restPoints = [];
  // 하채 (beamLower 역순, y 반전)
  for (let i = beamLower.points.length - 1; i > 0; i--) {
    const p = beamLower.points[i];
    restPoints.push({ x: p.x, y: -p.y });
  }
  // 그립 중심
  restPoints.push({ x: beamUpper.points[0].x, y: beamUpper.points[0].y });
  // 상채
  for (let i = 1; i < beamUpper.points.length; i++) {
    restPoints.push({ x: beamUpper.points[i].x, y: beamUpper.points[i].y });
  }

  // 고자 포인트 (상하)
  const siyahTop = [doraeTop, yangyangiTop];
  const siyahBottom = [doraeBottom, yangyangiBottom];

  // 레거시 호환: beam = beamUpper, dorae/yangyangi = 상채 값
  const beam = beamUpper;
  const dorae = doraeTop;
  const yangyangi = yangyangiTop;

  return {
    beamUpper, beamLower,
    beam,         // legacy alias → beamUpper
    restPoints,
    siyahTop, siyahBottom,
    doraeTop, doraeBottom,
    yangyangiTop, yangyangiBottom,
    dorae, yangyangi,  // legacy aliases → top values
  };
}

// ─── 주어진 하중에서 활 형상 + 시위 길이 계산 (솔버 내부 함수) ───
// 연속 보 모델: generateFullBeam으로 그립+활채 일체 적분 후 고자 좌표 계산
// 상채/하채 독립 적분으로 비대칭 강성 지원
function computeBowState(params, loadFactor) {
  const { bowLength, gripLength, siyahLength, siyahAngle } = params;
  const halfLen = bowLength / 2;
  const limbArcLen = halfLen - gripLength / 2 - siyahLength;
  const siyahRad = (siyahAngle * Math.PI) / 180;

  // 상채/하채 독립 적분
  const kappaFn = makeLoadFactorKappaFn(params, loadFactor);
  const beamUpper = generateFullBeam(params, kappaFn, 'upper');
  const beamLower = generateFullBeam(params, kappaFn, 'lower');

  // 상채 고자 끝점 계산
  const limbEndUpper = beamUpper.points[beamUpper.points.length - 1];
  const endAngleUpper = limbEndUpper.angle;
  const tangentUpper = { x: Math.cos(endAngleUpper), y: Math.sin(endAngleUpper) };
  const cosS = Math.cos(siyahRad);
  const sinS = Math.sin(siyahRad);
  const siyahDirUpper = {
    x: tangentUpper.x * cosS - tangentUpper.y * sinS,
    y: tangentUpper.y * cosS + tangentUpper.x * sinS,
  };
  const normUpper = Math.sqrt(siyahDirUpper.x ** 2 + siyahDirUpper.y ** 2);
  siyahDirUpper.x /= normUpper;
  siyahDirUpper.y /= normUpper;

  const doraeTop = { x: limbEndUpper.x, y: limbEndUpper.y };
  const yangyangiTop = {
    x: doraeTop.x + siyahDirUpper.x * siyahLength,
    y: doraeTop.y + siyahDirUpper.y * siyahLength,
  };

  // 하채 고자 끝점 계산 (beamLower는 +y 방향 적분 → y 부호 반전)
  const limbEndLower = beamLower.points[beamLower.points.length - 1];
  const endAngleLower = limbEndLower.angle;
  const tangentLower = { x: Math.cos(endAngleLower), y: Math.sin(endAngleLower) };
  const siyahDirLower_raw = {
    x: tangentLower.x * cosS - tangentLower.y * sinS,
    y: tangentLower.y * cosS + tangentLower.x * sinS,
  };
  const normLower = Math.sqrt(siyahDirLower_raw.x ** 2 + siyahDirLower_raw.y ** 2);
  siyahDirLower_raw.x /= normLower;
  siyahDirLower_raw.y /= normLower;

  // 하채 물리 좌표: beamLower는 +y 적분 → y 반전으로 실제 -y 위치
  const doraeBottom = { x: limbEndLower.x, y: -limbEndLower.y };
  // 하채 siyah 방향: 적분 공간의 방향을 y반전하여 실제 물리 방향으로
  const siyahDirBottom = { x: siyahDirLower_raw.x, y: -siyahDirLower_raw.y };
  const yangyangiBottom = {
    x: doraeBottom.x + siyahDirBottom.x * siyahLength,
    y: doraeBottom.y + siyahDirBottom.y * siyahLength,
  };

  // 시위 길이 계산: 상채 도고자 ↔ 하채 도고자 거리
  const doraeDist = Math.sqrt(
    (doraeTop.x - doraeBottom.x) ** 2 + (doraeTop.y - doraeBottom.y) ** 2
  );
  const stringLenAtBrace = 2 * siyahLength + doraeDist;

  // 호환성: limb 객체를 beamUpper에서 활채 구간만 추출하여 구성
  const limbPoints = beamUpper.points.slice(beamUpper.N_grip);
  const limbThicknesses = beamUpper.thicknesses.slice(beamUpper.N_grip);
  const limbWidths = beamUpper.widths.slice(beamUpper.N_grip);
  const limb = { points: limbPoints, thicknesses: limbThicknesses, widths: limbWidths };

  const beam = beamUpper;
  const dorae = doraeTop;
  const yangyangi = yangyangiTop;
  const siyahDir = siyahDirUpper;

  return {
    limb, beam, beamUpper, beamLower,
    dorae, yangyangi, siyahDir,
    doraeTop, doraeBottom, yangyangiTop, yangyangiBottom,
    siyahDirTop: siyahDirUpper, siyahDirBottom,
    doraeBottom_actual: doraeBottom, // computeNockX/generateBowGeometry에서 통일된 이름으로 접근
    doraeDist, stringLenAtBrace, limbArcLen,
  };
}

// ─── 기하학적 비선형 솔버: 시위 장력 T 기반 형상-힘 자기일관 반복 ───
// 핵심 개선: M(s) = T × d⊥(s, shape) — 변형된 형상에서의 수직거리 사용
// 내부 반복 (2-3회)으로 형상-힘 자기일관성 확보
//
// forcePoint: 힘 작용점 {x, y} (brace: 시위 중점 = nock, draw: 당김점)
// T: 시위 장력 (N)
// 반환: computeBowState와 동일한 형식 + beam
function computeBowStateWithTension(params, T, forcePoint, options = {}) {
  const { bowLength, gripLength, siyahLength, siyahAngle } = params;
  const halfGrip = gripLength / 2;
  const halfLen = bowLength / 2;
  const limbArcLen = halfLen - halfGrip - siyahLength;
  const siyahRad = (siyahAngle * Math.PI) / 180;
  const INNER_ITER = options.maxIter || 3;
  const RELAX = 0.5;
  const CONV_TOL = options.convergenceTol || 1e-5;

  // 초기 형상: 상채/하채 독립 초기화
  // backward compat: options.initialBeam은 상채 초기값으로 사용
  let prevBeamUpper = options.initialBeamUpper || options.initialBeam || generateFullBeam(params, null, 'upper');
  let prevBeamLower = options.initialBeamLower || generateFullBeam(params, null, 'lower');

  // 고자 좌표 계산 헬퍼 (beam의 끝점에서 siyah 방향 적분)
  function computeSiyahFromBeam(beam) {
    const limbEnd = beam.points[beam.points.length - 1];
    const endAngle = limbEnd.angle;
    const tangent = { x: Math.cos(endAngle), y: Math.sin(endAngle) };
    const cosS = Math.cos(siyahRad);
    const sinS = Math.sin(siyahRad);
    let dir = {
      x: tangent.x * cosS - tangent.y * sinS,
      y: tangent.y * cosS + tangent.x * sinS,
    };
    const norm = Math.sqrt(dir.x ** 2 + dir.y ** 2);
    dir.x /= norm;
    dir.y /= norm;
    const dorae = { x: limbEnd.x, y: limbEnd.y };
    const yangyangi = {
      x: dorae.x + dir.x * siyahLength,
      y: dorae.y + dir.y * siyahLength,
    };
    return { dorae, yangyangi, siyahDir: dir };
  }

  for (let iter = 0; iter < INNER_ITER; iter++) {
    // ── 상채: forcePoint → yangyangiTop 방향 시위 ──
    const { yangyangi: yangyangiTop_iter } = computeSiyahFromBeam(prevBeamUpper);

    const dxU = yangyangiTop_iter.x - forcePoint.x;
    const dyU = yangyangiTop_iter.y - forcePoint.y;
    const distU = Math.sqrt(dxU * dxU + dyU * dyU);
    if (distU < 1e-8) break;
    const ux_upper = dxU / distU;
    const uy_upper = dyU / distU;

    const kappaFnUpper = function(sHalf, EI) {
      const totalPts = prevBeamUpper.points.length;
      const totalHalf = halfGrip + limbArcLen;
      const idx = sHalf / totalHalf * (totalPts - 1);
      const i0 = Math.min(Math.floor(idx), totalPts - 2);
      const frac = idx - i0;
      const px = prevBeamUpper.points[i0].x * (1 - frac) + prevBeamUpper.points[i0 + 1].x * frac;
      const py = prevBeamUpper.points[i0].y * (1 - frac) + prevBeamUpper.points[i0 + 1].y * frac;
      // 상채 물리적 위치 = (px, py) 그대로
      const d_perp = (px - forcePoint.x) * uy_upper - (py - forcePoint.y) * ux_upper;
      return (T * d_perp) / EI;
    };

    // ── 하채: 적분 좌표계(+y)에서 힘 계산 ──
    // 하채 beam은 +y 방향 적분이므로, forcePoint를 y반전하여 적분 좌표계에서 계산
    // 이렇게 하면 상채와 동일한 굽힘 방향이 보장됨
    const { yangyangi: yangyangiLower_raw } = computeSiyahFromBeam(prevBeamLower);
    // 하채 양양고자 물리적 위치는 y반전 (조립용으로 저장)
    const yangyangiBottom_iter = { x: yangyangiLower_raw.x, y: -yangyangiLower_raw.y };

    // 적분 좌표계에서의 forcePoint (y 반전)
    const forcePointMirrored = { x: forcePoint.x, y: -forcePoint.y };
    const dxL = yangyangiLower_raw.x - forcePointMirrored.x;
    const dyL = yangyangiLower_raw.y - forcePointMirrored.y;
    const distL = Math.sqrt(dxL * dxL + dyL * dyL);
    if (distL < 1e-8) break;
    const ux_lower = dxL / distL;
    const uy_lower = dyL / distL;

    const kappaFnLower = function(sHalf, EI) {
      const totalPts = prevBeamLower.points.length;
      const totalHalf = halfGrip + limbArcLen;
      const idx = sHalf / totalHalf * (totalPts - 1);
      const i0 = Math.min(Math.floor(idx), totalPts - 2);
      const frac = idx - i0;
      const px = prevBeamLower.points[i0].x * (1 - frac) + prevBeamLower.points[i0 + 1].x * frac;
      const py = prevBeamLower.points[i0].y * (1 - frac) + prevBeamLower.points[i0 + 1].y * frac;
      // 적분 좌표계(+y)에서 직접 계산 — forcePointMirrored 사용
      const d_perp = (px - forcePointMirrored.x) * uy_lower - (py - forcePointMirrored.y) * ux_lower;
      return (T * d_perp) / EI;
    };

    const newBeamUpper = generateFullBeam(params, kappaFnUpper, 'upper');
    const newBeamLower = generateFullBeam(params, kappaFnLower, 'lower');

    // 수렴 체크: 상채/하채 모두 확인
    let maxDelta = 0;
    for (let i = 0; i < newBeamUpper.points.length; i++) {
      const dxU2 = newBeamUpper.points[i].x - prevBeamUpper.points[i].x;
      const dyU2 = newBeamUpper.points[i].y - prevBeamUpper.points[i].y;
      maxDelta = Math.max(maxDelta, Math.sqrt(dxU2 * dxU2 + dyU2 * dyU2));
    }
    for (let i = 0; i < newBeamLower.points.length; i++) {
      const dxL2 = newBeamLower.points[i].x - prevBeamLower.points[i].x;
      const dyL2 = newBeamLower.points[i].y - prevBeamLower.points[i].y;
      maxDelta = Math.max(maxDelta, Math.sqrt(dxL2 * dxL2 + dyL2 * dyL2));
    }

    // Relaxation: 마지막 반복 제외
    if (iter < INNER_ITER - 1) {
      for (let i = 0; i < newBeamUpper.points.length; i++) {
        newBeamUpper.points[i].x = prevBeamUpper.points[i].x * RELAX + newBeamUpper.points[i].x * (1 - RELAX);
        newBeamUpper.points[i].y = prevBeamUpper.points[i].y * RELAX + newBeamUpper.points[i].y * (1 - RELAX);
        newBeamUpper.points[i].angle = prevBeamUpper.points[i].angle * RELAX + newBeamUpper.points[i].angle * (1 - RELAX);
      }
      for (let i = 0; i < newBeamLower.points.length; i++) {
        newBeamLower.points[i].x = prevBeamLower.points[i].x * RELAX + newBeamLower.points[i].x * (1 - RELAX);
        newBeamLower.points[i].y = prevBeamLower.points[i].y * RELAX + newBeamLower.points[i].y * (1 - RELAX);
        newBeamLower.points[i].angle = prevBeamLower.points[i].angle * RELAX + newBeamLower.points[i].angle * (1 - RELAX);
      }
    }

    prevBeamUpper = newBeamUpper;
    prevBeamLower = newBeamLower;
    if (maxDelta < CONV_TOL) break; // 조기 수렴
  }

  // 최종 형상에서 고자 좌표 계산 — 상채/하채 독립
  const beamUpper = prevBeamUpper;
  const beamLower = prevBeamLower;

  const { dorae: doraeTop, yangyangi: yangyangiTop, siyahDir: siyahDirTop } = computeSiyahFromBeam(beamUpper);

  // 하채: beam 적분 결과에서 y반전으로 실제 물리 좌표 산출
  const { dorae: doraeTop_lower, yangyangi: yangyangiTop_lower, siyahDir: siyahDirTop_lower } = computeSiyahFromBeam(beamLower);
  const doraeBottom_actual = { x: doraeTop_lower.x, y: -doraeTop_lower.y };
  const yangyangiBottom = { x: yangyangiTop_lower.x, y: -yangyangiTop_lower.y };
  const siyahDirBottom = { x: siyahDirTop_lower.x, y: -siyahDirTop_lower.y };

  // backward compat: dorae/yangyangi/siyahDir/doraeBottom = 상채 기준
  const beam = beamUpper;
  const dorae = doraeTop;
  const yangyangi = yangyangiTop;
  const siyahDir = siyahDirTop;
  const doraeBottom = { x: doraeTop.x, y: -doraeTop.y }; // 상채 y반전 (레거시)

  // doraeDist: 상채 도고자 ↔ 하채 도고자 실제 거리 (asymmetric 고려)
  const doraeDist = Math.sqrt(
    (doraeTop.x - doraeBottom_actual.x) ** 2 + (doraeTop.y - doraeBottom_actual.y) ** 2
  );
  const stringLenAtBrace = 2 * siyahLength + doraeDist;

  // limb 호환 객체 (상채 기준 — backward compat)
  const limbPoints = beamUpper.points.slice(beamUpper.N_grip);
  const limbThicknesses = beamUpper.thicknesses.slice(beamUpper.N_grip);
  const limbWidths = beamUpper.widths.slice(beamUpper.N_grip);
  const limb = { points: limbPoints, thicknesses: limbThicknesses, widths: limbWidths };

  return {
    limb, beam, beamUpper, beamLower,
    dorae, yangyangi, siyahDir, doraeBottom,         // backward compat (상채 기준)
    doraeTop, yangyangiTop, siyahDirTop,             // 상채 명시
    doraeBottom_actual, yangyangiBottom, siyahDirBottom, // 하채 독립 계산
    doraeDist, stringLenAtBrace, limbArcLen,
    T, // 명시적 시위 장력
  };
}

// ─── 시위 길이 계산 (감김/직진 모드 포함) ───
// state: computeBowState 또는 computeBowStateWithTension의 반환값
// nockX: nock 지점의 x좌표
// nockY: nock 지점의 y좌표 (기본값 0, 상하 비대칭 지원)
// 반환: { computedLen, modeTop, modeBottom, mode }
function computeStringLength(params, state, nockX, nockY = 0) {
  const { siyahLength } = params;

  // 상하 앵커 포인트 (비대칭 지원, 레거시 호환)
  const doraeT = state.doraeTop || state.dorae;
  const yangT = state.yangyangiTop || state.yangyangi;
  const doraeB = state.doraeBottom_actual || { x: state.dorae.x, y: -state.dorae.y };
  const yangB = state.yangyangiBottom || { x: state.yangyangi.x, y: -state.yangyangi.y };

  // 상채 반쪽 길이 계산
  const distYangTop = Math.sqrt((nockX - yangT.x) ** 2 + (nockY - yangT.y) ** 2);
  const distYangBot = Math.sqrt((nockX - yangB.x) ** 2 + (nockY - yangB.y) ** 2);

  // 상채 감김 판정: yangyangi→nock 직선 위의 dorae 높이에서의 x좌표와 비교
  let modeTop = 'yangyangi';
  let topHalf = distYangTop;
  {
    const yy = yangT.y;
    if (Math.abs(yy - nockY) > 1e-6) {
      const t_dorae = (doraeT.y - nockY) / (yangT.y - nockY);
      const x_line = nockX + (yangT.x - nockX) * t_dorae;
      if (doraeT.x > x_line + 1e-6) {
        modeTop = 'dorae';
        const distDoraeTop = Math.sqrt((nockX - doraeT.x) ** 2 + (nockY - doraeT.y) ** 2);
        topHalf = siyahLength + distDoraeTop;
      }
    }
  }

  // 하채 감김 판정
  let modeBottom = 'yangyangi';
  let bottomHalf = distYangBot;
  {
    const yy = yangB.y;
    if (Math.abs(yy - nockY) > 1e-6) {
      const t_dorae = (doraeB.y - nockY) / (yangB.y - nockY);
      const x_line = nockX + (yangB.x - nockX) * t_dorae;
      if (doraeB.x > x_line + 1e-6) {
        modeBottom = 'dorae';
        const distDoraeBot = Math.sqrt((nockX - doraeB.x) ** 2 + (nockY - doraeB.y) ** 2);
        bottomHalf = siyahLength + distDoraeBot;
      }
    }
  }

  const computedLen = topHalf + bottomHalf;
  const mode = (modeTop === 'dorae' || modeBottom === 'dorae') ? 'dorae' : 'yangyangi';
  return { computedLen, modeTop, modeBottom, mode };
}

// ─── solveBrace: 이중 루프 평형 솔버 ───
// 외부 루프: T 이분법 → 시위 길이 제약 만족
// 내부 루프: computeBowStateWithTension 내부의 형상-힘 자기일관 반복
// 비대칭 상하채 지원: nockY 수직 균형 조건으로 반복 수렴
// 반환: { state, T_brace, braceHeight, braceNockY, stringMode }
function solveBrace(params) {
  const { stringLength, siyahLength } = params;
  const targetLen = stringLength;

  let T_lo = 0, T_hi = 3000; // 장력 범위 (N)

  let bestState = null;
  let bestMode = 'yangyangi';
  let bestNockX = 0;
  let bestNockY = 0;

  for (let iter = 0; iter < 50; iter++) {
    const T_mid = (T_lo + T_hi) / 2;

    // 초기 forcePoint 추정
    const roughState = computeBowStateWithTension(params, T_mid, { x: 0.15, y: 0 });

    // 비대칭 앵커 포인트 추출
    const yangT = roughState.yangyangiTop || roughState.yangyangi;
    const yangB = roughState.yangyangiBottom || { x: roughState.yangyangi.x, y: -roughState.yangyangi.y };
    const doraeT = roughState.doraeTop || roughState.dorae;
    const doraeB = roughState.doraeBottom_actual || { x: roughState.dorae.x, y: -roughState.dorae.y };

    // nock 위치 반복 수렴 (수직 균형 + 시위 길이 제약)
    let nockY = 0;
    let nockX = 0.15;
    let mode = 'yangyangi';

    for (let nockIter = 0; nockIter < 5; nockIter++) {
      // 감김 모드 판정 (상채)
      let topAnchor = yangT;
      let topFreeAdj = 0;
      if (Math.abs(yangT.y - nockY) > 1e-6) {
        const t_dorae = (doraeT.y - nockY) / (yangT.y - nockY);
        const x_line = nockX + (yangT.x - nockX) * t_dorae;
        if (doraeT.x > x_line + 1e-6) {
          topAnchor = doraeT;
          topFreeAdj = siyahLength;
        }
      }

      // 감김 모드 판정 (하채)
      let botAnchor = yangB;
      let botFreeAdj = 0;
      if (Math.abs(yangB.y - nockY) > 1e-6) {
        const t_dorae = (doraeB.y - nockY) / (yangB.y - nockY);
        const x_line = nockX + (yangB.x - nockX) * t_dorae;
        if (doraeB.x > x_line + 1e-6) {
          botAnchor = doraeB;
          botFreeAdj = siyahLength;
        }
      }
      mode = (topFreeAdj > 0 || botFreeAdj > 0) ? 'dorae' : 'yangyangi';

      const totalFreeLen = targetLen - topFreeAdj - botFreeAdj;

      // nockX 이분법: dist(topAnchor,nock) + dist(botAnchor,nock) = totalFreeLen
      let nxLo = Math.max(topAnchor.x, botAnchor.x);
      let nxHi = nxLo + totalFreeLen;
      for (let nxIter = 0; nxIter < 40; nxIter++) {
        const nxMid = (nxLo + nxHi) / 2;
        const dt = Math.sqrt((nxMid - topAnchor.x) ** 2 + (nockY - topAnchor.y) ** 2);
        const db = Math.sqrt((nxMid - botAnchor.x) ** 2 + (nockY - botAnchor.y) ** 2);
        if (dt + db < totalFreeLen) nxLo = nxMid;
        else nxHi = nxMid;
      }
      nockX = (nxLo + nxHi) / 2;

      // 수직 균형으로 nockY 갱신: ny = (topAnchor.y * db + botAnchor.y * dt) / (dt + db)
      const dt = Math.sqrt((nockX - topAnchor.x) ** 2 + (nockY - topAnchor.y) ** 2);
      const db = Math.sqrt((nockX - botAnchor.x) ** 2 + (nockY - botAnchor.y) ** 2);
      if (dt + db > 1e-8) {
        nockY = (topAnchor.y * db + botAnchor.y * dt) / (dt + db);
      }
    }

    // 정확한 nock 위치로 형상 재계산
    const state = computeBowStateWithTension(params, T_mid, { x: nockX, y: nockY });

    // 시위 길이 확인
    const { computedLen, mode: actualMode } = computeStringLength(params, state, nockX, nockY);

    if (computedLen > targetLen + 0.0001) {
      T_lo = T_mid; // 시위가 너무 김 → 장력 증가
    } else if (computedLen < targetLen - 0.0001) {
      T_hi = T_mid; // 시위가 너무 짧음 → 장력 감소
    } else {
      bestState = state;
      bestMode = actualMode;
      bestNockX = nockX;
      bestNockY = nockY;
      break;
    }

    bestState = state;
    bestMode = actualMode;
    bestNockX = nockX;
    bestNockY = nockY;
  }

  return {
    state: bestState,
    T_brace: (T_lo + T_hi) / 2,
    braceHeight: bestNockX,
    braceNockY: bestNockY,
    stringMode: bestMode,
  };
}

// ─── T-기반 draw 솔버 (하이브리드) ───
// loadFactor 이분법으로 nockX를 맞추고, 형상은 computeBowState(loadFactor)로 생성.
// T와 F_draw는 수렴된 형상의 기하학에서 정확히 역산.
//
// F_draw = 2 × T × sin(θ), T = F_draw / (2 sin(θ))
// sin(θ) = (nockX - anchor.x) / dist(nock, anchor)
// T = loadFactor × dist(nock, anchor) / |anchor.y|  (기하학 관계)
function solveDraw(params, targetNockX, braceResult) {
  const { stringLength, siyahLength } = params;

  // loadFactor 이분법으로 nockX를 맞춤 (안정적, 단조 수렴)
  // 먼저 brace loadFactor를 찾음
  let loadLo = 0, loadHi = 5000;
  for (let iter = 0; iter < 60; iter++) {
    const mid = (loadLo + loadHi) / 2;
    const result = computeNockX(params, mid);
    if (result.nockX === null) loadLo = mid;
    else loadHi = mid;
  }
  const braceLoadFactor = loadHi;

  // 피크 탐색 (loadFactor 모델 기준)
  const braceNockXOld = computeNockX(params, braceLoadFactor).nockX || 0;
  let peakLf = braceLoadFactor, peakNockX = braceNockXOld;
  for (let lf = braceLoadFactor; lf < 10000; lf += Math.max(1, lf * 0.05)) {
    const { nockX } = computeNockX(params, lf);
    if (nockX !== null && nockX > peakNockX) { peakNockX = nockX; peakLf = lf; }
    else if (nockX !== null && nockX < peakNockX - 0.005) break;
  }

  // nockX 이분법
  let dLo = braceLoadFactor, dHi = peakLf;
  for (let iter = 0; iter < 60; iter++) {
    const mid = (dLo + dHi) / 2;
    const { nockX } = computeNockX(params, mid);
    if (nockX === null || nockX < targetNockX) dLo = mid;
    else dHi = mid;
  }
  const finalLf = (dLo + dHi) / 2;
  const drawResult = computeNockX(params, finalLf);
  const actualNockX = drawResult.nockX || targetNockX;
  const mode = drawResult.mode || 'yangyangi';
  const state = drawResult.state;

  // nockY 계산 (비대칭 앵커 지원)
  const nockY = drawResult.nockY || 0;

  // T와 F_draw를 기하학에서 정확히 역산 (비대칭 앵커)
  const anchorTop = mode === 'dorae'
    ? (state.doraeTop || state.dorae)
    : (state.yangyangiTop || state.yangyangi);
  const anchorBot = mode === 'dorae'
    ? (state.doraeBottom_actual || state.doraeBottom || { x: state.dorae.x, y: -state.dorae.y })
    : (state.yangyangiBottom || { x: state.yangyangi.x, y: -state.yangyangi.y });

  const aT = anchorTop;
  const aB = anchorBot;

  // 상채 앵커 기반 T 역산 (레거시 호환: 상채 기준)
  // pullOffset 적용: 당김점 y오프셋 (엄지 위치) — 오프셋 0이면 종전과 동일
  const pullY = nockY + (params.pullOffset || 0);
  const dxTop = actualNockX - aT.x;
  const dyTop = pullY - aT.y;
  const distTop = Math.sqrt(dxTop * dxTop + dyTop * dyTop);

  const dxBot = actualNockX - aB.x;
  const dyBot = pullY - aB.y;
  const distBot = Math.sqrt(dxBot * dxBot + dyBot * dyBot);

  // 시위 장력: T = finalLf × dist / |aT.y - pullY| (수직 모멘트 관계)
  let T_draw = 0, F_draw = 0;
  const vertTop = Math.abs(aT.y - pullY);
  if (vertTop > 1e-6 && distTop > 1e-6) {
    T_draw = finalLf * distTop / vertTop;
    // F_draw = 상채 수평 성분 + 하채 수평 성분 (수평 당김력)
    const fTop = distTop > 1e-8 ? T_draw * dxTop / distTop : 0;
    const fBot = distBot > 1e-8 ? T_draw * dxBot / distBot : 0;
    F_draw = fTop + fBot;
  }

  return { state, T_draw, nockX: actualNockX, nockY, stringMode: mode, F_draw };
}

// ─── 순방향 매핑: loadFactor → nockX, nockY (도르래/기둥 감김 모델) ───
// 시위는 양양고자(고자 끝)에 고정되며, 도고자(활채/고자 접합부)는
// 밧줄이 기둥에 걸리듯 접촉점(contact post) 역할을 한다.
//
// 비대칭 상하채 지원: nockY 수직 균형 조건으로 반복 수렴
// 반환: { nockX, nockY, state, mode }
function computeNockX(params, loadFactor) {
  const { stringLength, siyahLength } = params;
  const state = computeBowState(params, loadFactor);

  // 비대칭 앵커 포인트 추출 — 독립 계산값 우선, 없으면 대칭 fallback
  const yangT = state.yangyangiTop || state.yangyangi;
  const yangB = state.yangyangiBottom || { x: state.yangyangi.x, y: -state.yangyangi.y };
  const doraeT = state.doraeTop || state.dorae;
  const doraeB = state.doraeBottom_actual || state.doraeBottom || { x: state.dorae.x, y: -state.dorae.y };

  // nock 위치 반복 수렴 (수직 균형 + 시위 길이 제약)
  let nockY = 0;
  let nockX = (yangT.x + yangB.x) / 2 + 0.01; // 초기 추정
  let mode = 'yangyangi';

  for (let nockIter = 0; nockIter < 5; nockIter++) {
    // 감김 모드 판정 (상채)
    let topAnchor = yangT;
    let topFreeAdj = 0;
    if (Math.abs(yangT.y - nockY) > 1e-6) {
      const t_dorae = (doraeT.y - nockY) / (yangT.y - nockY);
      const x_line = nockX + (yangT.x - nockX) * t_dorae;
      if (doraeT.x > x_line + 1e-6) {
        topAnchor = doraeT;
        topFreeAdj = siyahLength;
      }
    }

    // 감김 모드 판정 (하채)
    let botAnchor = yangB;
    let botFreeAdj = 0;
    if (Math.abs(yangB.y - nockY) > 1e-6) {
      const t_dorae = (doraeB.y - nockY) / (yangB.y - nockY);
      const x_line = nockX + (yangB.x - nockX) * t_dorae;
      if (doraeB.x > x_line + 1e-6) {
        botAnchor = doraeB;
        botFreeAdj = siyahLength;
      }
    }
    mode = (topFreeAdj > 0 || botFreeAdj > 0) ? 'dorae' : 'yangyangi';

    const totalFreeLen = stringLength - topFreeAdj - botFreeAdj;

    // 시위 길이 유효성 체크
    const minPossible = Math.sqrt((topAnchor.x - botAnchor.x) ** 2 + (topAnchor.y - botAnchor.y) ** 2);
    if (totalFreeLen < minPossible - 1e-6) return { nockX: null, nockY: null, state, mode };

    // nockX 이분법: dist(topAnchor,nock) + dist(botAnchor,nock) = totalFreeLen
    let nxLo = Math.max(topAnchor.x, botAnchor.x);
    let nxHi = nxLo + totalFreeLen;
    for (let nxIter = 0; nxIter < 40; nxIter++) {
      const nxMid = (nxLo + nxHi) / 2;
      const dt = Math.sqrt((nxMid - topAnchor.x) ** 2 + (nockY - topAnchor.y) ** 2);
      const db = Math.sqrt((nxMid - botAnchor.x) ** 2 + (nockY - botAnchor.y) ** 2);
      if (dt + db < totalFreeLen) nxLo = nxMid;
      else nxHi = nxMid;
    }
    nockX = (nxLo + nxHi) / 2;

    // 수직 균형으로 nockY 갱신
    const dt = Math.sqrt((nockX - topAnchor.x) ** 2 + (nockY - topAnchor.y) ** 2);
    const db = Math.sqrt((nockX - botAnchor.x) ** 2 + (nockY - botAnchor.y) ** 2);
    if (dt + db > 1e-8) {
      nockY = (topAnchor.y * db + botAnchor.y * dt) / (dt + db);
    }
  }

  return { nockX, nockY, state, mode };
}

// ─── 줌통 반력 계산 ───
// 시위 장력으로부터 줌통에 작용하는 반력/토크를 계산한다.
// 줌통 반력 = -(상채 시위력 + 하채 시위력)
// reactionPointY = 토크 없이 평형이 되는 y좌표 (이상적 반바닥 위치)
function computeGripReaction(params, bowGeom) {
  const T = bowGeom.T_current || 0;
  const pullPoint = bowGeom.pullPoint || { x: bowGeom.nockX, y: bowGeom.nockY || 0 };

  // 상/하채 앵커 (도르래 감김 여부에 따라 다름)
  const topAnchor = bowGeom.stringMode === 'dorae'
    ? { x: bowGeom.doraeTop.x, y: bowGeom.doraeTop.y }
    : { x: bowGeom.yangyangiTop.x, y: bowGeom.yangyangiTop.y };
  const botAnchor = bowGeom.stringMode === 'dorae'
    ? { x: bowGeom.doraeBottom.x, y: bowGeom.doraeBottom.y }
    : { x: bowGeom.yangyangiBottom.x, y: bowGeom.yangyangiBottom.y };

  // 시위 방향 벡터 (pullPoint → 각 앵커)
  const dxT = topAnchor.x - pullPoint.x;
  const dyT = topAnchor.y - pullPoint.y;
  const distT = Math.sqrt(dxT * dxT + dyT * dyT);

  const dxB = botAnchor.x - pullPoint.x;
  const dyB = botAnchor.y - pullPoint.y;
  const distB = Math.sqrt(dxB * dxB + dyB * dyB);

  // 시위 힘 = T × 단위벡터 (pullPoint → anchor 방향)
  let Fx_string = 0, Fy_string = 0;
  if (distT > 1e-8) {
    Fx_string += T * dxT / distT;
    Fy_string += T * dyT / distT;
  }
  if (distB > 1e-8) {
    Fx_string += T * dxB / distB;
    Fy_string += T * dyB / distB;
  }

  // 줌통 반력 = -(시위 힘 합) (뉴턴 3법칙)
  const Fx = -Fx_string;
  const Fy = -Fy_string;

  // 줌통 중심(0,0) 기준 토크: M = r × F (2D cross product)
  // 시위 합력이 pullPoint에서 작용하므로:
  // M_grip = pullPoint.x * Fy_string - pullPoint.y * Fx_string
  // (줌통 중심에서 pullPoint까지의 위치벡터 × 시위 합력)
  const M_grip = -(pullPoint.x * Fy_string - pullPoint.y * Fx_string);

  // 이상적 줌 작용점: Fx가 작용하는 y좌표 (이 점에서 밀면 토크 = 0)
  // reactionPointY = M_grip / Fx (Fx로 나누어 토크를 상쇄하는 y 오프셋)
  const reactionPointY = Math.abs(Fx) > 1e-6 ? -M_grip / Fx : 0;

  return { Fx, Fy, M_grip, reactionPointY };
}

// ─── 시위 길이 구속 조건 솔버를 포함한 활 전체 기하학 생성 ───
// T-기반 완전 물리 솔버: brace = solveBrace, draw = solveDraw
function generateBowGeometry(params, drawAmount = 0) {
  const {
    bowLength, gripLength, siyahLength, siyahAngle, stringLength, maxDraw
  } = params;

  // ─── 1단계: brace height 평형 (T 기반) ───
  const braceResultNew = solveBrace(params);
  const braceHeight = braceResultNew.braceHeight;
  const T_brace = braceResultNew.T_brace;
  let stringMode = braceResultNew.stringMode;

  // achievableMaxDraw: maxDraw 파라미터 기준
  const achievableMaxDraw = maxDraw;

  // ─── 2단계: 현재 당김 상태 (T-기반 solveDraw) ───
  let currentNockX = braceHeight;
  let drawResult = null;
  let T_current = T_brace;
  let F_draw = 0;

  if (drawAmount > 0.001) {
    const targetNockX = braceHeight + drawAmount * (achievableMaxDraw - braceHeight);
    drawResult = solveDraw(params, targetNockX, braceResultNew);
    currentNockX = drawResult.nockX;
    stringMode = drawResult.stringMode;
    T_current = drawResult.T_draw;
    F_draw = drawResult.F_draw;
  }

  // ─── 3단계: 최종 형상 조립 ───
  const finalState = (drawResult && drawResult.state) ? drawResult.state : braceResultNew.state;
  const topLimb = finalState.limb;
  const beam = finalState.beam;

  // 비대칭 상하채 지원: beamUpper/beamLower가 있으면 독립 사용, 없으면 대칭 폴백
  const beamUpper = finalState.beamUpper || finalState.beam;
  const beamLower = finalState.beamLower || finalState.beam;

  // nockY 추적 (비대칭 시 상하채 힘 불균형으로 nock이 y=0에서 벗어날 수 있음)
  const braceNockY = braceResultNew.braceNockY || 0;
  const drawNockY = drawResult ? (drawResult.nockY || 0) : braceNockY;
  const currentNockY = drawAmount > 0.001 ? drawNockY : braceNockY;

  // 접촉점 오프셋 (사법 모델링)
  const pullPoint = { x: currentNockX, y: currentNockY + (params.pullOffset || 0) };
  const nockingPoint = { x: currentNockX, y: currentNockY + (params.nockingOffset || 0) };
  const restPoint = { x: 0, y: params.restOffsetY || 0 };

  // 전체 활 포인트: 하채끝 → (하채 → 줌통 → 상채) → 상채끝
  // beamUpper.points: [0]=그립중심, [1..N_grip]=줌통, [N_grip+1..N_grip+N_limb]=상채
  // beamLower: 독립 하채 (비대칭 지원)
  const limbPoints = [];
  const limbRadii = [];

  // 하채 (beamLower를 y반전하여 역순 배치: 활채끝 → 줌통끝)
  for (let i = beamLower.points.length - 1; i > 0; i--) {
    const p = beamLower.points[i];
    limbPoints.push(new THREE.Vector3(p.x, -p.y, 0));
    limbRadii.push(beamLower.widths[i] * 0.4);
  }

  // 그립 중심 (beamUpper.points[0])
  const center = beamUpper.points[0];
  limbPoints.push(new THREE.Vector3(center.x, center.y, 0));
  limbRadii.push(beamUpper.widths[0] * 0.4);

  // 상채 (beamUpper 순서대로: 줌통 → 활채끝)
  for (let i = 1; i < beamUpper.points.length; i++) {
    const p = beamUpper.points[i];
    limbPoints.push(new THREE.Vector3(p.x, p.y, 0));
    limbRadii.push(beamUpper.widths[i] * 0.4);
  }

  // 고자 (Three.js Vector3) - 상하채 독립 값 사용, 없으면 대칭 폴백
  const dT = finalState.doraeTop || finalState.dorae;
  const dB = finalState.doraeBottom_actual || { x: finalState.dorae.x, y: -finalState.dorae.y };
  const yT = finalState.yangyangiTop || finalState.yangyangi;
  const yB = finalState.yangyangiBottom || { x: finalState.yangyangi.x, y: -finalState.yangyangi.y };
  const sdT = finalState.siyahDirTop || finalState.siyahDir;
  const sdB = finalState.siyahDirBottom || { x: finalState.siyahDir.x, y: -finalState.siyahDir.y };

  const doraeTop = new THREE.Vector3(dT.x, dT.y, 0);
  const doraeBottom = new THREE.Vector3(dB.x, dB.y, 0);
  const yangyangiTop = new THREE.Vector3(yT.x, yT.y, 0);
  const yangyangiBottom = new THREE.Vector3(yB.x, yB.y, 0);
  const siyahDirTop = new THREE.Vector3(sdT.x, sdT.y, 0);
  const siyahDirBottom = new THREE.Vector3(sdB.x, sdB.y, 0);

  // 줌통 반력 계산
  const gripReaction = computeGripReaction(params, {
    T_current, nockX: currentNockX, nockY: currentNockY,
    pullPoint,
    doraeTop, doraeBottom, yangyangiTop, yangyangiBottom,
    stringMode,
  });

  return {
    limbPoints,
    limbRadii,
    topLimbData: topLimb,
    beam,               // 연속 보 데이터 (레거시 호환)
    beamUpper,          // 상채 보 데이터
    beamLower,          // 하채 보 데이터
    doraeTop, doraeBottom,
    yangyangiTop, yangyangiBottom,
    siyahDirTop, siyahDirBottom,
    braceHeight,        // 계산된 종속 변수
    nockX: currentNockX,
    nockY: currentNockY, // 비대칭 시 nock Y 오프셋
    stringMode,         // 'dorae' (감김) 또는 'yangyangi' (직진)
    T_brace,            // brace 시위 장력 (N)
    T_current,          // 현재 시위 장력 (N)
    F_draw,             // 당김력 (N)
    loadFactor: T_current, // 호환용 (레거시)
    pullPoint, nockingPoint, restPoint, gripReaction,
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

  const nockPoint = new THREE.Vector3(nockX, bowGeom.nockY || 0, 0);
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
    // T-기반 솔버가 F_draw를 직접 제공
    return g.F_draw || 0;
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
  const [launchAngleDeg, setLaunchAngleDeg] = useState(null); // 화살 초기발사각 (도)
  const animRef = useRef({ phase: "idle", t: 0 });
  const [showGrid, setShowGrid] = useState(true);
  const [showRestShape, setShowRestShape] = useState(false);
  const restShapeRef = useRef(null);

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

        // 화살 방향: restPoint → nockingPoint
        const restPt = bowGeom.restPoint || { x: 0, y: 0 };
        const nockPt = bowGeom.nockingPoint || { x: nockPoint.x, y: nockPoint.y };
        const arrowDx = nockPt.x - restPt.x;
        const arrowDy = nockPt.y - restPt.y;
        const arrowAngle = Math.atan2(arrowDy, arrowDx);

        // 화살대 (로컬 x축으로 정렬, nock 위치가 그룹 원점)
        const shaftGeom = new THREE.CylinderGeometry(0.004, 0.004, arrowLen, 8);
        const shaftMat = new THREE.MeshPhysicalMaterial({ color: 0x1a1a1a, roughness: 0.4, metalness: 0.6 });
        const shaft = new THREE.Mesh(shaftGeom, shaftMat);
        shaft.rotation.z = Math.PI / 2;
        shaft.position.set(-arrowLen / 2, 0, 0);
        arrowGroup.add(shaft);

        // 촉 (꼭짓점이 -x 방향 = 과녁 방향을 향하도록)
        const tipGeom = new THREE.ConeGeometry(0.006, 0.04, 6);
        const tipMat = new THREE.MeshPhysicalMaterial({ color: 0x888888, metalness: 0.8, roughness: 0.2 });
        const tip = new THREE.Mesh(tipGeom, tipMat);
        tip.rotation.z = Math.PI / 2;
        tip.position.set(-arrowLen - 0.02, 0, 0);
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
          fletch.position.set(0.05, Math.sin(angle) * 0.008, Math.cos(angle) * 0.008);
          fletch.rotation.x = angle;
          arrowGroup.add(fletch);
        }

        // 그룹을 nock 위치에 배치하고 화살 방향으로 회전
        arrowGroup.position.set(nockPt.x, nockPt.y, 0);
        arrowGroup.rotation.z = arrowAngle;

        scene.add(arrowGroup);
        arrowMeshRef.current = arrowGroup;
      }
    }

    // 접촉점 마커 (항상 표시)
    if (bowGeom && bowGeom.restPoint) {
      const restMarker = new THREE.Mesh(
        new THREE.SphereGeometry(0.006, 8, 8),
        new THREE.MeshBasicMaterial({ color: 0x33ff33 })
      );
      restMarker.position.set(bowGeom.restPoint.x, bowGeom.restPoint.y, 0);
      scene.add(restMarker);
    }
    if (bowGeom && bowGeom.gripReaction) {
      const gripMarker = new THREE.Mesh(
        new THREE.SphereGeometry(0.006, 8, 8),
        new THREE.MeshBasicMaterial({ color: 0x3388ff })
      );
      gripMarker.position.set(0, bowGeom.gripReaction.reactionPointY, 0);
      scene.add(gripMarker);
    }
    // 당김 중일 때만 nockingPoint / pullPoint 마커 표시
    if (bowGeom && draw > 0.01) {
      if (bowGeom.nockingPoint) {
        const nockMarker = new THREE.Mesh(
          new THREE.SphereGeometry(0.006, 8, 8),
          new THREE.MeshBasicMaterial({ color: 0xff3333 })
        );
        nockMarker.position.set(bowGeom.nockingPoint.x, bowGeom.nockingPoint.y, 0);
        scene.add(nockMarker);
      }
      if (bowGeom.pullPoint) {
        const pullMarker = new THREE.Mesh(
          new THREE.SphereGeometry(0.006, 8, 8),
          new THREE.MeshBasicMaterial({ color: 0xffcc00 })
        );
        pullMarker.position.set(bowGeom.pullPoint.x, bowGeom.pullPoint.y, 0);
        scene.add(pullMarker);
      }
    }

    if (gridRef.current) gridRef.current.visible = showGrid;

    // 무현 형상 오버레이
    if (restShapeRef.current && scene) {
      scene.remove(restShapeRef.current);
      restShapeRef.current.traverse(c => { if (c.geometry) c.geometry.dispose(); if (c.material) c.material.dispose(); });
      restShapeRef.current = null;
    }
    if (showRestShape && scene) {
      const restData = computeRestShape(params);
      const restPts = restData.restPoints.map(p => new THREE.Vector3(p.x, p.y, 0));
      const restGeo = new THREE.BufferGeometry().setFromPoints(restPts);
      const restMat = new THREE.LineDashedMaterial({ color: 0x66aaff, dashSize: 0.01, gapSize: 0.008, opacity: 0.4, transparent: true });
      const restLine = new THREE.Line(restGeo, restMat);
      restLine.computeLineDistances();
      // 고자 (상/하)
      const siyahGroup = new THREE.Group();
      [restData.siyahTop, restData.siyahBottom].forEach(pts => {
        const geo = new THREE.BufferGeometry().setFromPoints(pts.map(p => new THREE.Vector3(p.x, p.y, 0)));
        const mat = new THREE.LineDashedMaterial({ color: 0x66aaff, dashSize: 0.01, gapSize: 0.008, opacity: 0.4, transparent: true });
        const line = new THREE.Line(geo, mat);
        line.computeLineDistances();
        siyahGroup.add(line);
      });
      const restGroup = new THREE.Group();
      restGroup.add(restLine);
      restGroup.add(siyahGroup);
      scene.add(restGroup);
      restShapeRef.current = restGroup;
    }

  }, [params, showString, showArrow, showGrid, showRestShape, bowGeomData]);

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
            // 화살 초기발사각 계산: restPoint → nockingPoint 방향 (만작 시점의 기하학)
            const bg = bowGeomDataRef.current;
            if (bg) {
              const rp = bg.restPoint || { x: 0, y: 0 };
              const np = bg.nockingPoint || { x: bg.nockX, y: bg.nockY || 0 };
              const angleDeg = Math.atan2(np.y - rp.y, np.x - rp.x) * (180 / Math.PI);
              setLaunchAngleDeg(angleDeg);
            }
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
            tip.rotation.z = Math.PI / 2;
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
    setLaunchAngleDeg(null); // 이전 발사각 초기화
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
            <div>시위 장력: <b style={{ color: "#ff7744" }}>{(bowGeomData.T_current || 0).toFixed(0)} N</b></div>
            {drawAmount > 0.01 && <div>당김력: <b style={{ color: "#ff9966" }}>{(bowGeomData.F_draw || 0).toFixed(0)} N ({((bowGeomData.F_draw || 0) / 9.81).toFixed(1)} kgf / {((bowGeomData.F_draw || 0) / 4.44822).toFixed(1)} lbs)</b></div>}
            <div>당김 비율: <b style={{ color: "#88ff88" }}>{(drawAmount * 100).toFixed(0)}%</b></div>
            {launchAngleDeg !== null && <div>초기발사각: <b style={{ color: "#ffaaff" }}>{launchAngleDeg.toFixed(2)}°</b></div>}
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
              ["showRestShape", showRestShape, setShowRestShape, "무현 형상"],
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
              { key: "gripStiffnessRatio", label: "줌통 강성비", unit: "×", min: 5, max: 40, step: 1, scale: 1 },
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
              { key: "limbAsymmetryRatio", label: "하채 강성비", unit: "×", min: 0.8, max: 1.5, step: 0.05, toVal: v => v, fromVal: v => v },
            ].map(({ key, label, unit, min, max, step, toVal, fromVal }) => (
              <div key={key} style={{ marginBottom: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 2 }}>
                  <span>{label}</span>
                  <span style={{ color: "#ffcc44" }}>{toVal(params[key]).toFixed(key === "limbAsymmetryRatio" ? 2 : key === "limbThickness" ? 1 : 0)} {unit}</span>
                </div>
                <input type="range" min={min} max={max} step={step}
                  value={toVal(params[key])}
                  onChange={e => updateParam(key, fromVal(parseFloat(e.target.value)))}
                  style={{ width: "100%", accentColor: "#6666cc" }} />
              </div>
            ))}
          </div>

          {/* 접촉점 설정 */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontWeight: 700, marginBottom: 8, color: "#aaaacc", borderBottom: "1px solid #333", paddingBottom: 4 }}>
              접촉점 설정
            </div>
            {[
              { key: "nockingOffset", label: "오니 오프셋", unit: "mm", min: -50, max: 150, step: 1, toVal: v => v * 1000, fromVal: v => v / 1000 },
              { key: "pullOffset", label: "당김점 오프셋", unit: "mm", min: -30, max: 0, step: 0.5, toVal: v => v * 1000, fromVal: v => v / 1000 },
              { key: "restOffsetY", label: "화살걸이 오프셋", unit: "mm", min: -50, max: 150, step: 1, toVal: v => v * 1000, fromVal: v => v / 1000 },
            ].map(({ key, label, unit, min, max, step, toVal, fromVal }) => (
              <div key={key} style={{ marginBottom: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 2 }}>
                  <span>{label}</span>
                  <span style={{ color: "#ffcc44" }}>{toVal(params[key] || 0).toFixed(1)} {unit}</span>
                </div>
                <input type="range" min={min} max={max} step={step}
                  value={toVal(params[key] || 0)}
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
              {params.limbAsymmetryRatio !== 1.0 && (
                <div>하채 강성비: <b>{params.limbAsymmetryRatio.toFixed(2)}×</b></div>
              )}
              <div>Brace height: <b>{(computedBraceHeight * 100).toFixed(1)} cm</b></div>
              <div>현재 Nock 위치: <b>{currentDrawCm.toFixed(1)} cm</b></div>
              <div>하중 인자: <b>{computedLoadFactor.toFixed(2)}</b></div>
              <div>활채 호 길이: <b>{((params.bowLength / 2 - params.gripLength / 2 - params.siyahLength) * 100).toFixed(1)} cm</b></div>
            </div>
            {bowGeomData && bowGeomData.gripReaction && (
              <>
                <div style={{ borderTop: "1px solid #333", marginTop: 6, paddingTop: 6 }}>
                  <div style={{ color: "#aaaacc", fontWeight: 600, marginBottom: 4 }}>줌통 반력</div>
                </div>
                <div style={{ lineHeight: 2 }}>
                  <div>미는 힘 Fx: <b>{bowGeomData.gripReaction.Fx.toFixed(1)} N</b></div>
                  <div>수직 반력 Fy: <b>{bowGeomData.gripReaction.Fy.toFixed(1)} N</b></div>
                  <div>토크: <b>{(bowGeomData.gripReaction.M_grip * 1000).toFixed(1)} mN·m</b></div>
                  <div>이상 작용점: <b>{(bowGeomData.gripReaction.reactionPointY * 1000).toFixed(1)} mm</b></div>
                </div>
              </>
            )}
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
