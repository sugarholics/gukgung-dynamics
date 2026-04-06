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
  limbThickness: 0.008,   // 활채 두께 (m) - 줌통 접합부 기준

  // 탄성 특성
  elasticModulus: 22e9,    // FRP/카본 복합재 탄성계수 (Pa) ~22 GPa
  dampingRatio: 0.02,     // 감쇠비
  limbAsymmetryRatio: 1.0, // 하채/상채 강성비 (1.0=대칭, 0.8~1.5)

  // 시위 (독립 변수)
  stringLength: 1.08,     // 시위 전체 길이 (m) — 양쪽 고리 포함
  stringDiameter: 0.002,  // 시위 직경 (m)

  // 사용 조건
  maxDraw: 0.75,          // 만작 거리 (m) — 줌통 중심에서 nock point까지

  // 활채 형상 — 반곡(reflex) 특성
  reflexAngle: 35,        // 반곡 각도 (도)
  naturalCurvature: 0.8,  // 자연 곡률 인자

  // 줌통(대림) V자 각도
  // 줌통 양 끝이 사대 방향으로 약간 꺾여 리커브 형태를 이룸
  // 0° = 직선 줌통, 10~15° = 개량궁 전형적 형태
  gripAngle: 8,           // 줌통 V자 각도 (도)

  // 줌통 강성비 (연속 탄성체 모델)
  // 줌통 EI = 활채 근부 EI × gripStiffnessRatio
  // 실제 개량궁: FRP/카본 보강으로 활채보다 10~30배 강성
  gripStiffnessRatio: 25, // 줌통/활채 강성비

  // 접촉점 오프셋 (사법 모델링)
  nockingOffset: 0.050,   // 오니 y오프셋 (m) — 시위 힘 중심보다 위
  pullOffset: -0.015,     // 당김점 y오프셋 (m) — 오니보다 아래 (엄지 위치)
  restOffsetY: 0.003,     // 화살걸이 y오프셋 (m) — 줌통 중심보다 위

  // 줌손 사법 (z축 비틀기 — "빨래 짜기")
  gripTwistTorque: 0.3,   // 줌손 비틀기 토크 (N·m) — 만작 시 1시 방향 기울임
  gripTwistDamping: 0.08, // z축 회전 감쇠비 — 줌손 마찰

  // 화살 물리 (Spine 기반 카본 튜브)
  arrowLength: 0.82,          // 화살 전체 길이 (m) — 오니~촉 끝
  arrowMass: 0.025,           // 총 질량 (kg) — 슬라이더: 0.020~0.035
  arrowTipMass: 0.008,        // 촉 질량 (kg) — 금속성 촉
  arrowSpine: 700,            // 정적 스파인 번호 — AMO 표준으로 EI 결정 (주 파라미터)
  arrowOuterDiam: 0.0052,     // 카본 튜브 외경 (m) — 5.2mm, 시각용
  nockClipForce: 3.0,         // nock 클립 보유력 (N) — 횡방향, 1~5N
  thumbReleaseForce: 5.0,     // 엄지 이탈 횡력 (N) — archer's paradox 구동, +z방향
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

    // Relaxation: 마지막 반복 제외 (마지막은 raw 자기일관 해)
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

  let bestState = null;
  let bestMode = 'yangyangi';
  let bestNockX = 0;
  let bestNockY = 0;

  // ── Phase 1: 기하급수 탐색으로 T 상한 좁히기 ──
  // T를 작은 값부터 2배씩 증가시켜, computedLen < targetLen인 첫 T를 찾음
  // 이렇게 하면 내부 솔버가 항상 안정적인 T 범위에서만 동작
  let T_lo = 0, T_hi = 10; // 시작: 10N
  for (let probe = 0; probe < 15; probe++) { // 10, 20, 40, ..., 163840
    const state = computeBowStateWithTension(params, T_hi, { x: 0.15, y: 0 });
    const { computedLen } = computeStringLength(params, state, 0.15, 0);
    if (computedLen <= targetLen) {
      // T_hi에서 시위가 충분히 짧음 → [T_hi/2, T_hi]가 유효 범위
      T_lo = T_hi / 2;
      break;
    }
    T_hi *= 2;
  }

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
  // pullOffset 적용: nockingOffset 기준으로 당김점 위치 계산
  // 당김점 = nock 균형점 + 오니 오프셋 + 당김점 오프셋 (엄지는 오니 아래)
  const pullY = nockY + (params.nockingOffset || 0) + (params.pullOffset || 0);
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

// ─── 화살 물리 (Spine 기반 카본 튜브 모델) ───

// AMO/ATA 정적 스파인 테스트 → EI 변환
// 지지간격 28"(0.7112m), 하중 1.94lbf(8.63N), 처짐 = spine/1000"
function computeArrowProperties(params) {
  const L = params.arrowLength || 0.82;
  const m_total = params.arrowMass || 0.025;
  const m_tip = Math.min(params.arrowTipMass || 0.008, m_total * 0.6);
  const m_shaft = m_total - m_tip;
  const rho_linear = m_shaft / L;
  const spine = params.arrowSpine || 700;
  const D_outer = params.arrowOuterDiam || 0.0052;

  // AMO spine → EI: δ = PL³/(48EI), ∴ EI = PL³/(48δ)
  const P_test = 8.63;               // N (1.94 lbf)
  const L_test = 0.7112;             // m (28")
  const delta_test = spine * 2.54e-5; // m (spine/1000 inches)
  const EI = P_test * Math.pow(L_test, 3) / (48 * delta_test);

  return { L, m_total, m_tip, m_shaft, rho_linear, D_outer, spine, EI };
}

// Spine 검증: EI → AMO 테스트 재현 → spine 역산
function verifyArrowSpine(arrowProps) {
  const P = 8.63, L = 0.7112;
  const delta = P * L * L * L / (48 * arrowProps.EI);
  const spineComputed = delta / 2.54e-5;
  return { delta_mm: delta * 1000, spineComputed: Math.round(spineComputed) };
}

// 화살 정적 처짐 형상 계산 (Euler-Bernoulli 보)
// 경계조건: nock = 핀 지지 (위치 고정, 회전 자유), rest = 일방향 접촉
// 하중: 자중(분포) + 촉 질량(집중)
function computeArrowStaticShape(arrowProps, nockPos, restPos) {
  const { L, m_total, m_tip, m_shaft, rho_linear, EI } = arrowProps;
  const g = 9.81;
  const N = 20; // 이산화 노드 수

  // 화살 축 방향: nock → target (과녁 방향, -x)
  // rest는 nock과 target 사이에 위치
  const dx = restPos.x - nockPos.x;
  const dy = restPos.y - nockPos.y;
  const distNR = Math.sqrt(dx * dx + dy * dy);

  // 화살 로컬 좌표계: s축 = nock(0) → tip(L), v축 = s에 수직 (중력 방향 성분)
  // 화살 기울기 각도 (수평 대비)
  const axisX = -1; // nock → 과녁 방향 = -x
  const axisY = dy / Math.max(distNR, 1e-6);
  const alpha = Math.atan2(axisY, axisX); // 화살 기울기 각도

  // nock에서 rest까지의 화살 축 방향 거리
  // rest는 x≈0에 위치, nock은 x=nockX (양수)
  // 화살 축을 따른 거리 a = 투영 거리
  const a = distNR; // nock-rest 간 거리 ≈ 화살 축을 따른 rest 위치

  // 수직 방향 중력 성분 (화살 축에 수직)
  const cosAlpha = Math.cos(alpha);
  const w = rho_linear * g * Math.abs(cosAlpha); // 분포하중 (N/m), 수직 성분
  const W_tip = m_tip * g * Math.abs(cosAlpha);   // 촉 집중하중 (N)

  // a가 너무 작거나 L보다 크면 외팔보로 처리
  const useOverhang = (a > 0.05 && a < L - 0.02);

  let deflections = new Array(N + 1).fill(0);

  if (useOverhang) {
    // ── 오버행 보: 지지 A(s=0, nock), B(s=a, rest) ──
    // 모멘트 평형 (A 기준): R_B × a = 분포하중 모멘트 + 촉 하중 모멘트
    const R_B = (w * L * L / 2 + W_tip * L) / a;
    const R_A = w * L + W_tip - R_B;

    // 접촉 판정: R_B < 0이면 rest에서 들뜸 → 외팔보
    if (R_B < 0) {
      // 외팔보: nock에서만 지지 (실제로는 화살이 rest에서 떨어진 상태)
      // 이 경우는 거의 발생하지 않음 (촉이 항상 아래로 누름)
      for (let i = 0; i <= N; i++) {
        const s = (i / N) * L;
        // 자유단 외팔보 처짐 (nock 고정, 회전 자유 → 실제로는 단순지지 한쪽)
        // 단순화: 처짐 = 0 (rest 접촉 해제 시)
        deflections[i] = 0;
      }
      // rest 접촉 없음
      const nodes = [];
      for (let i = 0; i <= N; i++) {
        const s = (i / N) * L;
        const localX = -s; // nock에서 tip 방향 = -x (과녁 쪽)
        nodes.push({
          x: nockPos.x + localX * Math.cos(alpha) - deflections[i] * Math.sin(alpha),
          y: nockPos.y + localX * Math.sin(alpha) + deflections[i] * Math.cos(alpha)
        });
      }
      const tipNode = nodes[N];
      const tangentAngle = alpha; // 처짐 없으므로 기울기 = 축 방향
      return {
        nodes, restContact: false, restForce: 0,
        nockAngle: tangentAngle, tipPos: tipNode,
        arrowProps
      };
    }

    // ── 처짐 계산: EI y'' = M(s) 적분 ──
    // 구간1: 0 ≤ s ≤ a (nock ~ rest)
    //   M(s) = R_A × s - w × s²/2
    // 구간2: a ≤ s ≤ L (rest ~ tip)
    //   M(s) = R_A × s - w × s²/2 - R_B × (s - a)
    //        = -(w × s²/2 - (R_A + R_B) × s + R_B × a) + (R_A + R_B) × s - R_B × a ...
    //   더 간단하게: 오른쪽 끝에서 보면
    //   M(s) = -W_tip × (L - s) - w × (L - s)²/2  (s > a에서, 오른쪽 자유단 기준)

    // 수치 적분 (직접 적분보다 안정적)
    // EI × y'' = M(s)를 이중 적분
    // y(0) = 0 (nock 핀 지지), y(a) = 0 (rest 지지)
    const ds = L / N;
    const M = new Array(N + 1);
    for (let i = 0; i <= N; i++) {
      const s = i * ds;
      if (s <= a) {
        M[i] = R_A * s - w * s * s / 2;
      } else {
        M[i] = R_A * s - w * s * s / 2 - R_B * (s - a);
      }
    }

    // EI y'' = M → y' = ∫M/EI ds + C1, y = ∫y' ds + C2
    // 경계: y(0) = 0, y(a) = 0
    // 사다리꼴 적분
    const kappa = M.map(m => m / EI); // 곡률
    const slope = new Array(N + 1).fill(0); // y'
    const defl = new Array(N + 1).fill(0);  // y

    // 1차 적분: slope(s) = ∫₀ˢ kappa ds + C1
    for (let i = 1; i <= N; i++) {
      slope[i] = slope[i - 1] + (kappa[i - 1] + kappa[i]) / 2 * ds;
    }

    // C1을 결정하기 위해: y(a) = 0
    // y(s) = ∫₀ˢ slope ds + C2, y(0) = 0 → C2 = 0
    // 먼저 C1 = 0으로 y를 계산한 뒤, y(a)에서 보정

    // 임시 defl (C1 = 0)
    for (let i = 1; i <= N; i++) {
      defl[i] = defl[i - 1] + (slope[i - 1] + slope[i]) / 2 * ds;
    }

    // rest 위치 인덱스
    const iRest = Math.round(a / ds);
    const yAtRest = defl[Math.min(iRest, N)];
    // C1 보정: y(a) = 0이 되려면 slope에 -yAtRest/a를 더해야 함
    const C1_correction = -yAtRest / Math.max(a, 1e-6);

    // 재계산
    for (let i = 0; i <= N; i++) {
      const s = i * ds;
      slope[i] += C1_correction;
    }
    for (let i = 0; i <= N; i++) {
      defl[i] = 0;
    }
    for (let i = 1; i <= N; i++) {
      defl[i] = defl[i - 1] + (slope[i - 1] + slope[i]) / 2 * ds;
    }

    deflections = defl;

    // 세계 좌표 변환
    const nodes = [];
    // 화살 방향: nock에서 과녁 방향
    const dirX = dx / Math.max(distNR, 1e-6);
    const dirY = dy / Math.max(distNR, 1e-6);
    // 수직 방향 (화살 축에 수직, 아래 = 음)
    const perpX = dirY;  // 90도 회전
    const perpY = -dirX;

    for (let i = 0; i <= N; i++) {
      const s = (i / N) * L;
      const ratio = s / Math.max(distNR, 1e-6); // 축 방향 비율 (rest까지)
      // 화살 축을 따른 세계 좌표
      const baseX = nockPos.x + dirX * s;
      const baseY = nockPos.y + dirY * s;
      // 처짐 (수직 방향, 아래가 양수 → 중력 방향)
      nodes.push({
        x: baseX - perpX * deflections[i],
        y: baseY - perpY * deflections[i]
      });
    }

    const tipNode = nodes[N];
    // nock에서의 기울기 (발사 각도)
    const nockSlope = slope[0]; // rad
    const nockAngle = alpha + nockSlope;

    return {
      nodes,
      restContact: true,
      restForce: R_B,
      nockAngle,
      tipPos: tipNode,
      arrowProps
    };
  } else {
    // rest 접촉 불가 (거리 부적합) → 직선 화살
    const nodes = [];
    for (let i = 0; i <= N; i++) {
      const s = (i / N) * L;
      nodes.push({
        x: nockPos.x - s * Math.cos(alpha),
        y: nockPos.y - s * Math.sin(alpha)
      });
    }
    return {
      nodes,
      restContact: false,
      restForce: 0,
      nockAngle: alpha,
      tipPos: nodes[N],
      arrowProps
    };
  }
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
  const pullPoint = { x: currentNockX, y: currentNockY + (params.nockingOffset || 0) + (params.pullOffset || 0) };
  const nockingPoint = { x: currentNockX, y: currentNockY + (params.nockingOffset || 0) };
  const restPoint = { x: 0, y: params.restOffsetY || 0 };

  // 화살 물리 계산
  const arrowProps = computeArrowProperties(params);
  const arrowShape = (drawAmount > 0.001)
    ? computeArrowStaticShape(arrowProps, nockingPoint, restPoint)
    : null;

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
    arrowProps, arrowShape,
  };
}

// ─── 시위 경로 생성 (도르래 감김 모델) ───
// 도고자가 밧줄의 기둥 역할: 시위가 도고자에 접촉하면 감겨서 꺾이고,
// 접촉하지 않으면 양양고자에서 nock으로 직진한다.
//
// [감김 모드] 양양고자 → 도고자(접촉) → nock → 도고자 → 양양고자
// [직진 모드] 양양고자 → nock → 양양고자 (도고자 접촉 없음)
function generateStringPath(bowGeom, drawAmount, limbWidth) {
  const { yangyangiTop, yangyangiBottom, doraeTop, doraeBottom, nockX, stringMode } = bowGeom;

  // 시위 시각적 경로: nockingPoint를 통과 (화살 nock이 시위에 걸린 위치)
  // pullPoint는 물리 계산(solveDraw)에만 사용하고 시각적으로는 nockingPoint
  const nockY_vis = (drawAmount > 0.001 && bowGeom.nockingPoint)
    ? bowGeom.nockingPoint.y : (bowGeom.nockY || 0);
  // 당김 시 nock의 z는 화살 위치 (국궁 우궁: 궁사 오른쪽 = -z), 앵커는 z=0
  const nockZ_vis = (drawAmount > 0.001) ? -(((limbWidth || 0.028) / 2) + 0.003) : 0;
  const nockPoint = new THREE.Vector3(nockX, nockY_vis, nockZ_vis);
  const stringPoints = [];
  const subdivPerSeg = 6;

  // 보간 헬퍼: 3D (z도 보간)
  function lerp(a, b, n, includeStart, includeEnd) {
    const start = includeStart ? 0 : 1;
    const end = includeEnd ? n : n - 1;
    for (let i = start; i <= end; i++) {
      const t = i / n;
      stringPoints.push(new THREE.Vector3(
        a.x + (b.x - a.x) * t,
        a.y + (b.y - a.y) * t,
        (a.z || 0) + ((b.z || 0) - (a.z || 0)) * t
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
  const m_arrow = params.arrowMass || 0.025; // kg
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

// ─── z축 회전 파라미터 (줌손 빨래 짜기) ───
function computeZRotationParams(params) {
  // 1) 활의 수직축(z축) 관성모멘트
  const m_limb_each = 0.050;   // kg (활채 한쪽)
  const m_siyah_each = 0.010;  // kg (고자 한쪽)
  const halfLen = (params.bowLength || 1.20) / 2;
  const gripHalf = (params.gripLength || 0.12) / 2;
  const siyahLen = params.siyahLength || 0.08;
  const limbLen = halfLen - gripHalf - siyahLen;

  // 활채: 균일 봉 ∫(a→b) (m/L)s² ds = m(a²+ab+b²)/3, 회전축=줌통중심(s=0)
  const limbStart = gripHalf;
  const limbEnd = gripHalf + limbLen;
  const I_limb = m_limb_each * (limbEnd * limbEnd + limbEnd * limbStart + limbStart * limbStart) / 3;
  // 고자: 점질량 근사
  const r_siyah = gripHalf + limbLen + siyahLen / 2;
  const I_siyah = m_siyah_each * r_siyah * r_siyah;
  const I_z = 2 * (I_limb + I_siyah); // 양쪽 대칭

  // 2) 시위의 z축 복원 강성
  // k_z = T × halfLen² / L_string (nock V자 기하 → 복원력, Phase 1에서만 유효)
  // 분리 후(Phase 2): 시위 직선 → k_z = 0
  const g_brace = generateBowGeometry(params, 0.0);
  const T_brace = g_brace.T_current || 100;
  const L_string = params.stringLength || 1.08;
  const k_z_per_T = halfLen * halfLen / L_string; // 동적 k_z용 계수
  const k_z = T_brace * k_z_per_T; // brace 기준 (초기조건용)

  // 3) 진동 파라미터 (brace 기준)
  const zeta_z = Math.min(Math.max(params.gripTwistDamping || 0.08, 0.001), 0.99);
  const omega_z = Math.sqrt(k_z / I_z);
  const omega_d_z = omega_z * Math.sqrt(1 - zeta_z * zeta_z);

  // 4) 줌손 토크 및 정상상태 각도
  const M_wrist = params.gripTwistTorque || 0.3;
  const theta_ss = M_wrist / k_z; // 만작 정상상태 (rad)

  return { I_z, k_z, k_z_per_T, omega_z, omega_d_z, zeta_z, M_wrist, theta_ss };
}

// ─── Lumped-Mass 화살 동역학 엔진 ───

// bowGeometry를 drawAmount 균등 분할로 사전 샘플링 (시뮬레이션 중 보간용)
function preSampleBowAnchors(params, n = 21) {
  const samples = [];
  for (let i = 0; i < n; i++) {
    const d = i / (n - 1);
    const g = generateBowGeometry(params, d);
    const anchorTop = g.stringMode === 'dorae'
      ? { x: g.doraeTop.x, y: g.doraeTop.y }
      : { x: g.yangyangiTop.x, y: g.yangyangiTop.y };
    const anchorBot = g.stringMode === 'dorae'
      ? { x: g.doraeBottom.x, y: g.doraeBottom.y }
      : { x: g.yangyangiBottom.x, y: g.yangyangiBottom.y };
    const nockPt = g.nockingPoint || { x: g.nockX, y: g.nockY || 0 };
    const pullPt = g.pullPoint || nockPt;

    // 시위 상현/하현 길이 (nock 고정 위치에서)
    const dxT = anchorTop.x - nockPt.x, dyT = anchorTop.y - nockPt.y;
    const dxB = anchorBot.x - nockPt.x, dyB = anchorBot.y - nockPt.y;
    const L_upper = Math.sqrt(dxT * dxT + dyT * dyT);
    const L_lower = Math.sqrt(dxB * dxB + dyB * dyB);

    samples.push({
      drawAmount: d,
      anchorTop, anchorBot,
      T_current: g.T_current || 0,
      F_draw: g.F_draw || 0,
      nockX: g.nockX,
      nockY: g.nockY || 0,
      nockingPoint: { ...nockPt },
      pullPoint: { ...pullPt },
      restPoint: g.restPoint ? { ...g.restPoint } : { x: 0, y: params.restOffsetY || 0 },
      L_upper, L_lower,
      // q = nock 변위 (brace 기준, 나중에 채움)
      q: 0,
    });
  }
  // q = nockX - nockX_brace
  const nockX_brace = samples[0].nockX;
  for (let i = 0; i < n; i++) {
    samples[i].q = samples[i].nockX - nockX_brace;
  }
  return samples;
}

// 사전 샘플에서 선형 보간 (drawAmount 기반)
function interpolateBowState(samples, drawAmount) {
  const d = Math.max(0, Math.min(1, drawAmount));
  const n = samples.length;
  const idx = d * (n - 1);
  const i0 = Math.min(Math.floor(idx), n - 2);
  const i1 = i0 + 1;
  const frac = idx - i0;
  const s0 = samples[i0], s1 = samples[i1];
  const lerp = (a, b) => a + (b - a) * frac;
  return {
    anchorTop: { x: lerp(s0.anchorTop.x, s1.anchorTop.x), y: lerp(s0.anchorTop.y, s1.anchorTop.y) },
    anchorBot: { x: lerp(s0.anchorBot.x, s1.anchorBot.x), y: lerp(s0.anchorBot.y, s1.anchorBot.y) },
    T_current: lerp(s0.T_current, s1.T_current),
    F_draw: lerp(s0.F_draw, s1.F_draw),
    nockX: lerp(s0.nockX, s1.nockX),
    nockY: lerp(s0.nockY, s1.nockY),
    nockingPoint: {
      x: lerp(s0.nockingPoint.x, s1.nockingPoint.x),
      y: lerp(s0.nockingPoint.y, s1.nockingPoint.y),
    },
    restPoint: s0.restPoint,
    q: lerp(s0.q, s1.q),
  };
}

// q 기반 보간: 활채 유효변위 q → 앵커 위치, 복원력
function interpolateBowByQ(samples, q) {
  // q가 샘플 범위 내에서 해당하는 두 샘플 찾기
  const n = samples.length;
  let i0 = 0;
  for (let i = 1; i < n; i++) {
    if (samples[i].q >= q) break;
    i0 = i;
  }
  const i1 = Math.min(i0 + 1, n - 1);
  if (i0 === i1) return samples[i0];
  const frac = (q - samples[i0].q) / (samples[i1].q - samples[i0].q || 1e-10);
  const s0 = samples[i0], s1 = samples[i1];
  const lerp = (a, b) => a + (b - a) * frac;
  return {
    anchorTop: { x: lerp(s0.anchorTop.x, s1.anchorTop.x), y: lerp(s0.anchorTop.y, s1.anchorTop.y) },
    anchorBot: { x: lerp(s0.anchorBot.x, s1.anchorBot.x), y: lerp(s0.anchorBot.y, s1.anchorBot.y) },
    F_draw: lerp(s0.F_draw, s1.F_draw),
    T_current: lerp(s0.T_current, s1.T_current),
    nockX: lerp(s0.nockX, s1.nockX),
    nockY: lerp(s0.nockY, s1.nockY),
    nockingPoint: {
      x: lerp(s0.nockingPoint.x, s1.nockingPoint.x),
      y: lerp(s0.nockingPoint.y, s1.nockingPoint.y),
    },
    drawAmount: lerp(s0.drawAmount, s1.drawAmount),
    restPoint: s0.restPoint,
    q,
  };
}

// 원-원 교점: nock 위치를 시위 상현/하현 길이로 결정
// nock은 시위의 고정 위치에 끼워져 있으므로 L_upper, L_lower는 상수
// anchorTop, anchorBot + L_upper, L_lower → nock 위치 (궁사 쪽 교점)
function computeNockFromStringConstraint(anchorTop, anchorBot, L_upper, L_lower) {
  const dx = anchorTop.x - anchorBot.x;
  const dy = anchorTop.y - anchorBot.y;
  const d = Math.sqrt(dx * dx + dy * dy);

  // 시위가 도달 불가하면 최대 연장 위치 반환
  if (d > L_upper + L_lower || d < 1e-6) {
    return {
      x: (anchorTop.x + anchorBot.x) / 2,
      y: (anchorTop.y + anchorBot.y) / 2,
      valid: false,
    };
  }

  // 표준 원-원 교점 공식
  // a = anchorTop(L_upper의 중심)에서 교점 연결선까지의 거리
  const a = (L_upper * L_upper - L_lower * L_lower + d * d) / (2 * d);
  const h2 = L_upper * L_upper - a * a;
  const h = h2 > 0 ? Math.sqrt(h2) : 0;

  // m = anchorTop에서 anchorBot 방향으로 a만큼 이동한 점
  const mx = anchorTop.x - (a / d) * dx;
  const my = anchorTop.y - (a / d) * dy;

  // 법선 (두 교점 중 궁사 쪽 = +x 방향을 선택)
  const nx = -dy / d;
  const ny = dx / d;

  // 두 교점
  const p1x = mx + h * nx, p1y = my + h * ny;
  const p2x = mx - h * nx, p2y = my - h * ny;

  // 궁사 쪽 (+x) 교점 선택
  if (p1x >= p2x) {
    return { x: p1x, y: p1y, valid: true };
  } else {
    return { x: p2x, y: p2y, valid: true };
  }
}

// ─── 시위 유질량 체인 초기화 (24노드 3D) ───
function initStringChain(params, anchorTop, anchorBot, nockPos, L_upper, L_lower) {
  const N_str = 24;
  const stringLen = params.stringLength || 1.08;
  const ds_str = stringLen / (N_str - 1);
  const m_string = params.stringMass || 0.005; // 5g

  // z-축: 앵커 = 활 중심면(z=0), 화살 = z_arrow (국궁 우궁: 궁사 오른쪽 = -z)
  const z_arrow = -((params.limbWidth || 0.028) / 2 + 0.003);

  // nockNode 인덱스: 상현 길이 비율
  const nockNode = Math.max(1, Math.min(N_str - 2, Math.round(L_upper / ds_str)));

  const sx = new Float64Array(N_str);
  const sy = new Float64Array(N_str);
  const sz = new Float64Array(N_str);
  const svx = new Float64Array(N_str);
  const svy = new Float64Array(N_str);
  const svz = new Float64Array(N_str);
  const sm = new Float64Array(N_str);

  // 질량 균등 분배
  const m_node = m_string / N_str;
  for (let i = 0; i < N_str; i++) sm[i] = m_node;

  // 상현: node 0(anchorTop) → nockNode
  for (let i = 0; i <= nockNode; i++) {
    const frac = i / nockNode;
    sx[i] = anchorTop.x + (nockPos.x - anchorTop.x) * frac;
    sy[i] = anchorTop.y + (nockPos.y - anchorTop.y) * frac;
    sz[i] = 0 + z_arrow * frac; // 앵커 z=0 → nock z=z_arrow
  }

  // 하현: nockNode → node N-1(anchorBot)
  for (let i = nockNode + 1; i < N_str; i++) {
    const frac = (i - nockNode) / (N_str - 1 - nockNode);
    sx[i] = nockPos.x + (anchorBot.x - nockPos.x) * frac;
    sy[i] = nockPos.y + (anchorBot.y - nockPos.y) * frac;
    sz[i] = z_arrow + (0 - z_arrow) * frac; // nock z=z_arrow → 앵커 z=0
  }

  return {
    N: N_str, ds: ds_str, sx, sy, sz, svx, svy, svz, sm,
    nockNode, z_arrow,
    nockPinned: true, // 화살 연결 상태
  };
}

// 시위 체인 SHAKE (3D, 앵커+nock 핀 가능, pinned = boolean array)
function shakeStringChain(state, pinned) {
  const { N, ds, sx, sy, sz, sm } = state;
  const iterations = 10; // 시위는 굽힘 없으므로 10회면 충분
  for (let iter = 0; iter < iterations; iter++) {
    for (let i = 0; i < N - 1; i++) {
      const dx = sx[i + 1] - sx[i];
      const dy = sy[i + 1] - sy[i];
      const dz = sz[i + 1] - sz[i];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist < 1e-12) continue;
      const err = dist - ds;
      const correction = err / dist * 0.5;

      const iP = pinned[i], jP = pinned[i + 1];
      if (iP && jP) continue;

      if (iP) {
        sx[i + 1] -= correction * dx;
        sy[i + 1] -= correction * dy;
        sz[i + 1] -= correction * dz;
      } else if (jP) {
        sx[i] += correction * dx;
        sy[i] += correction * dy;
        sz[i] += correction * dz;
      } else {
        // 균등 질량이므로 0.5/0.5
        sx[i] += correction * 0.5 * dx;
        sy[i] += correction * 0.5 * dy;
        sz[i] += correction * 0.5 * dz;
        sx[i + 1] -= correction * 0.5 * dx;
        sy[i + 1] -= correction * 0.5 * dy;
        sz[i + 1] -= correction * 0.5 * dz;
      }
    }
  }
}

// 시위 체인 1스텝 적분 (Störmer-Verlet + SHAKE)
// 사전 할당: _sx_old 등은 initStringChain에서 생성
function stepStringChain(state, anchorTop3d, anchorBot3d, arrowNock3d, dt) {
  const { N, sx, sy, sz, svx, svy, svz, nockNode, nockPinned } = state;
  const g = 9.81;

  // 이전 위치 저장 (사전 할당 배열 사용)
  if (!state._sx_old) {
    state._sx_old = new Float64Array(N);
    state._sy_old = new Float64Array(N);
    state._sz_old = new Float64Array(N);
    state._pinned = new Uint8Array(N);
  }
  const sx_old = state._sx_old, sy_old = state._sy_old, sz_old = state._sz_old;
  for (let i = 0; i < N; i++) { sx_old[i] = sx[i]; sy_old[i] = sy[i]; sz_old[i] = sz[i]; }

  // pinned 배열 구성 (Set 대신)
  const pinned = state._pinned;
  pinned.fill(0);
  pinned[0] = 1; pinned[N - 1] = 1;
  if (nockPinned) pinned[nockNode] = 1;

  // 앵커 핀
  sx[0] = anchorTop3d.x; sy[0] = anchorTop3d.y; sz[0] = anchorTop3d.z;
  sx[N - 1] = anchorBot3d.x; sy[N - 1] = anchorBot3d.y; sz[N - 1] = anchorBot3d.z;

  // nock 핀 (화살 연결 시)
  if (nockPinned && arrowNock3d) {
    sx[nockNode] = arrowNock3d.x;
    sy[nockNode] = arrowNock3d.y;
    sz[nockNode] = arrowNock3d.z;
  }

  // Verlet 위치 업데이트 (내부 노드만)
  const damping = 0.005; // 시위 감쇠 (다크론/다이니마 저감쇠)
  for (let i = 1; i < N - 1; i++) {
    if (pinned[i]) continue;
    sx[i] += svx[i] * dt + 0.5 * (-damping * svx[i]) * dt * dt;
    sy[i] += svy[i] * dt + 0.5 * (-g - damping * svy[i]) * dt * dt;
    sz[i] += svz[i] * dt + 0.5 * (-damping * svz[i]) * dt * dt;
  }

  // SHAKE
  shakeStringChain(state, pinned);

  // 핀 노드 재고정
  sx[0] = anchorTop3d.x; sy[0] = anchorTop3d.y; sz[0] = anchorTop3d.z;
  sx[N - 1] = anchorBot3d.x; sy[N - 1] = anchorBot3d.y; sz[N - 1] = anchorBot3d.z;
  if (nockPinned && arrowNock3d) {
    sx[nockNode] = arrowNock3d.x;
    sy[nockNode] = arrowNock3d.y;
    sz[nockNode] = arrowNock3d.z;
  }

  // 속도 재계산
  for (let i = 0; i < N; i++) {
    svx[i] = (sx[i] - sx_old[i]) / dt;
    svy[i] = (sy[i] - sy_old[i]) / dt;
    svz[i] = (sz[i] - sz_old[i]) / dt;
  }
}

// Lumped-mass 화살 초기화 (만작 상태, 3D)
function initLumpedMassArrow(arrowProps, nockPos, restPos, z_arrow) {
  const N = 12;
  const ds = arrowProps.L / (N - 1);
  const x = new Float64Array(N);
  const y = new Float64Array(N);
  const z = new Float64Array(N);
  const vx = new Float64Array(N);
  const vy = new Float64Array(N);
  const vz = new Float64Array(N);
  const m = new Float64Array(N);

  // 화살 방향: nock에서 과녁(-x) 방향
  const dx = restPos.x - nockPos.x;
  const dy = restPos.y - nockPos.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const ux = dx / Math.max(dist, 1e-6);
  const uy = dy / Math.max(dist, 1e-6);

  // 노드 배치: nock(0) → tip(N-1)
  const zArrow = z_arrow || 0;
  for (let i = 0; i < N; i++) {
    x[i] = nockPos.x + ux * ds * i;
    y[i] = nockPos.y + uy * ds * i;
    z[i] = zArrow; // 화살 전체가 z_arrow 위치
  }

  // 질량 분배
  const m_node = arrowProps.m_shaft / N;
  for (let i = 0; i < N; i++) m[i] = m_node;
  m[0] += m_node * 0.5; // nock 끝 보정 (반 세그먼트)
  m[N - 1] = m_node * 0.5 + arrowProps.m_tip; // tip = 반 세그먼트 + 촉 질량

  // rest에 가장 가까운 노드
  let restNodeIdx = 0;
  let minDist = Infinity;
  for (let i = 0; i < N; i++) {
    const d2 = (x[i] - restPos.x) ** 2 + (y[i] - restPos.y) ** 2;
    if (d2 < minDist) { minDist = d2; restNodeIdx = i; }
  }

  return {
    N, ds, x, y, z, vx, vy, vz, m,
    EI: arrowProps.EI,
    restNodeIdx,
    onString: true,
    contactCount: 0,
    wasInContact: true,
    recontactError: false,
  };
}

// 이산 곡률 기반 굽힘력 계산
function computeBendingForces(state) {
  const { N, x, y, EI, ds } = state;
  const fx = new Float64Array(N);
  const fy = new Float64Array(N);

  // 에너지 구배 방식: E = Σ EI/(2ds) × θ²
  // 3노드 (a,b,c)의 굽힘 에너지에서 힘을 유도 → F_a + F_b + F_c = 0 보장
  for (let i = 1; i < N - 1; i++) {
    const ax = x[i - 1], ay = y[i - 1];
    const bx = x[i],     by = y[i];
    const cx = x[i + 1], cy = y[i + 1];

    // 세그먼트 벡터
    const e1x = bx - ax, e1y = by - ay;
    const e2x = cx - bx, e2y = cy - by;
    const L1 = Math.sqrt(e1x * e1x + e1y * e1y) || ds;
    const L2 = Math.sqrt(e2x * e2x + e2y * e2y) || ds;

    // 굽힘 각도 θ (signed, cross product)
    const cross = e1x * e2y - e1y * e2x;
    const dot = e1x * e2x + e1y * e2y;
    let theta = Math.atan2(cross, dot);

    // 곡률 제한: 화살의 물리적 휨 범위는 ±15° 이내
    // 이를 넘으면 시뮬레이션 불안정 → 클램핑
    const MAX_THETA = 0.25; // ~14.3°
    theta = Math.max(-MAX_THETA, Math.min(MAX_THETA, theta));

    // dE/dθ = EI * θ / ds
    const coeff = EI * theta / ds;

    // dθ/d(node a) = perp(e1) / L1  (e1의 왼쪽 법선)
    const pa_x = -e1y / (L1 * L1);
    const pa_y =  e1x / (L1 * L1);

    // dθ/d(node c) = -perp(e2) / L2
    const pc_x =  e2y / (L2 * L2);
    const pc_y = -e2x / (L2 * L2);

    // F = -dE/dr = -coeff * dθ/dr
    const fa_x = -coeff * pa_x;
    const fa_y = -coeff * pa_y;
    const fc_x = -coeff * pc_x;
    const fc_y = -coeff * pc_y;

    // Newton 3rd law: F_b = -(F_a + F_c)
    fx[i - 1] += fa_x;
    fy[i - 1] += fa_y;
    fx[i]     += -(fa_x + fc_x);
    fy[i]     += -(fa_y + fc_y);
    fx[i + 1] += fc_x;
    fy[i + 1] += fc_y;
  }

  return { fx, fy };
}

// z-축 굽힘력 (소각도 유한차분, archer's paradox)
// 화살 z-변위가 작으므로 (< 8mm) 소각도 근사 정확
function computeBendingForcesZ(state) {
  const { N, z, EI, ds } = state;
  const fz = new Float64Array(N);
  // 유한차분 4차 미분: F = -EI × d⁴z/dx⁴ → 3노드 스텐실
  // E_bend = Σ EI/(2ds) × κ², κ = (z[i-1] - 2z[i] + z[i+1])/ds²
  // dE/dz[i-1] = EI×κ/(ds×ds²) = EI×κ/ds³
  for (let i = 1; i < N - 1; i++) {
    const kappa = (z[i - 1] - 2 * z[i] + z[i + 1]) / (ds * ds);
    // 곡률 제한 (y-축과 동일)
    const MAX_KAPPA = 0.25 / ds; // ~14.3°/ds
    const kappaClamped = Math.max(-MAX_KAPPA, Math.min(MAX_KAPPA, kappa));
    const coeff = EI * kappaClamped / ds;
    fz[i - 1] += -coeff;
    fz[i]     +=  2 * coeff;
    fz[i + 1] += -coeff;
  }
  return { fz };
}

// SHAKE 거리 구속
// on-string(pinnedNode=0): x,y만 2D SHAKE (z는 소변위이므로 분리 처리)
// 자유비행: 완전 3D SHAKE
function enforceDistanceConstraints(state, iterations = 4, pinnedNode = -1) {
  const { N, ds, x, y, z, m } = state;
  if (pinnedNode === 0) {
    // 선형 체인 + nock 고정: x,y 2D 순방향 직접 풀이
    // z는 소변위(< 20mm / 74mm seg = 3%)이므로 x,y 거리에 미치는 영향 무시
    for (let i = 0; i < N - 1; i++) {
      const dx = x[i + 1] - x[i];
      const dy = y[i + 1] - y[i];
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 1e-12) continue;
      const scale = ds / dist;
      x[i + 1] = x[i] + dx * scale;
      y[i + 1] = y[i] + dy * scale;
    }
  } else {
    // 일반 SHAKE (분리 후 자유 비행): 3D
    for (let iter = 0; iter < iterations; iter++) {
      for (let i = 0; i < N - 1; i++) {
        const dx = x[i + 1] - x[i];
        const dy = y[i + 1] - y[i];
        const dz = z ? (z[i + 1] - z[i]) : 0;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist < 1e-12) continue;
        const err = dist - ds;
        const correction = err / dist * 0.5;

        const wi = 1 / m[i], wj = 1 / m[i + 1];
        const sumW = wi + wj;

        x[i] += correction * (wi / sumW) * dx;
        y[i] += correction * (wi / sumW) * dy;
        x[i + 1] -= correction * (wj / sumW) * dx;
        y[i + 1] -= correction * (wj / sumW) * dy;
        if (z) {
          z[i] += correction * (wi / sumW) * dz;
          z[i + 1] -= correction * (wj / sumW) * dz;
        }
      }
    }
  }
}

// 시위력 계산 (nock 노드에 작용)
// drawAmount를 받아 분리 조건에 사용
function computeStringForceOnNock(state, bowState, drawAmount) {
  if (!state.onString) return { Fx: 0, Fy: 0 };

  // 분리 조건 1: drawAmount가 0에 도달 (시위가 brace로 완전 복원)
  if (drawAmount <= 0.001) {
    state.onString = false;
    return { Fx: 0, Fy: 0 };
  }

  const nockX = state.x[0], nockY = state.y[0];
  const T = bowState.T_current;

  // 상현/하현 방향
  const dxT = bowState.anchorTop.x - nockX;
  const dyT = bowState.anchorTop.y - nockY;
  const distT = Math.sqrt(dxT * dxT + dyT * dyT) || 1e-6;

  const dxB = bowState.anchorBot.x - nockX;
  const dyB = bowState.anchorBot.y - nockY;
  const distB = Math.sqrt(dxB * dxB + dyB * dyB) || 1e-6;

  const Fx = T * (dxT / distT + dxB / distB);
  const Fy = T * (dyT / distT + dyB / distB);

  // 분리 조건 2: 시위가 뒤로 당기려 함 (Fx > 0 = +x = 궁사 방향)
  if (Fx > 0) {
    state.onString = false;
    return { Fx: 0, Fy: 0 };
  }

  return { Fx, Fy };
}

// Rest 접촉력 (일방향 페널티)
function computeRestContactForce(state, restPos, k_rest = 5e3) {
  // rest 접촉 노드는 초기화 시 고정 (동적 변경 안 함)
  const ci = state.restNodeIdx;

  // rest에서 화살이 벗어났으면 (nock이 rest를 지나감) 접촉 불가
  // 화살의 tip이 rest보다 오른쪽에 있어야 접촉 가능
  if (state.x[ci] < restPos.x - 0.05 || state.x[ci] > restPos.x + 0.05) {
    state.wasInContact = false;
    return { nodeIndex: ci, Fy: 0, inContact: false };
  }

  const gap = state.y[ci] - restPos.y;
  let Fy = 0;
  let inContact = false;

  if (gap < 0) {
    Fy = k_rest * (-gap); // 위로 밀어냄
    // 감쇠 (반발 줄임)
    const dampForce = -50 * state.vy[ci];
    Fy += dampForce;
    if (Fy < 0) Fy = 0; // 당기는 힘은 불가
    inContact = true;
  }

  // 접촉 전이 추적 (FREE→CONTACT)
  if (inContact && !state.wasInContact) {
    state.contactCount++;
    if (state.contactCount >= 2) {
      state.recontactError = true;
    }
  }
  state.wasInContact = inContact;

  return { nodeIndex: ci, Fy, inContact };
}

// Störmer-Verlet 1스텝 (자유 비행 전용 — on-string은 simulateRelease가 직접 처리)
function stepLumpedMass(state, bowState, restPos, dt, drawAmount) {
  const { N, x, y, z, vx, vy, vz, m } = state;
  const g_accel = 9.81;

  const x_old = Float64Array.from(x);
  const y_old = Float64Array.from(y);
  const z_old = Float64Array.from(z);

  // 힘 계산: bending + gravity + rest (시위력 없음 — 이미 분리됨)
  const bend = computeBendingForces(state);
  const bendZ = computeBendingForcesZ(state);
  const restF = computeRestContactForce(state, restPos);

  const ax = new Float64Array(N);
  const ay = new Float64Array(N);
  const az = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    ax[i] = bend.fx[i] / m[i];
    ay[i] = (bend.fy[i] - m[i] * g_accel) / m[i];
    az[i] = bendZ.fz[i] / m[i]; // z: 중력 없음
  }
  if (restF.Fy !== 0) {
    ay[restF.nodeIndex] += restF.Fy / m[restF.nodeIndex];
  }

  for (let i = 0; i < N; i++) {
    x[i] += vx[i] * dt + 0.5 * ax[i] * dt * dt;
    y[i] += vy[i] * dt + 0.5 * ay[i] * dt * dt;
    z[i] += vz[i] * dt + 0.5 * az[i] * dt * dt;
  }

  enforceDistanceConstraints(state, 30);

  // 5) 속도 = (보정된 위치 - 이전 위치) / dt (구속력 임펄스 자동 반영)
  for (let i = 0; i < N; i++) {
    vx[i] = (x[i] - x_old[i]) / dt;
    vy[i] = (y[i] - y_old[i]) / dt;
    vz[i] = (z[i] - z_old[i]) / dt;
  }

  // 6) 고주파 감쇠: Laplacian smoothing of velocity
  const alpha = 0.05;
  for (let i = 1; i < N - 1; i++) {
    const avgVx = (vx[i - 1] + vx[i + 1]) / 2;
    const avgVy = (vy[i - 1] + vy[i + 1]) / 2;
    const avgVz = (vz[i - 1] + vz[i + 1]) / 2;
    vx[i] += alpha * (avgVx - vx[i]);
    vy[i] += alpha * (avgVy - vy[i]);
    vz[i] += alpha * (avgVz - vz[i]);
  }
}

// 자유-자유 보 모드형상 (해석적, 균일 보 + tip mass 근사)
function computeFreeFreeModeshapes(arrowProps, N_nodes) {
  const L = arrowProps.L;
  const rhoA = arrowProps.rho_linear;
  const EI = arrowProps.EI;
  const m_tip = arrowProps.m_tip;
  const mu = m_tip / (rhoA * L); // tip mass ratio

  // 자유-자유 보 beta*L 근: cos(bL)*cosh(bL) = 1
  // 1차: 4.730, 2차: 7.853, 3차: 10.996 (균일 보)
  const betaL_base = [4.7300, 7.8532, 10.9956];
  // tip mass에 의한 주파수 저하 (근사)
  const alpha_factors = [1.0, 0.4, 0.2]; // 모드별 tip 참여 계수

  const modes = [];
  for (let k = 0; k < 3; k++) {
    const bL = betaL_base[k];
    const omega = (bL * bL) * Math.sqrt(EI / (rhoA * Math.pow(L, 4)));
    const omega_corrected = omega / Math.sqrt(1 + alpha_factors[k] * mu);

    // 모드형상 계산 (N_nodes 점)
    const phi = new Float64Array(N_nodes);
    const beta = bL / L;
    const coshBL = Math.cosh(bL), cosBL = Math.cos(bL);
    const sinhBL = Math.sinh(bL), sinBL = Math.sin(bL);
    const sigma = (coshBL - cosBL) / (sinhBL - sinBL);

    for (let i = 0; i < N_nodes; i++) {
      const s = (i / (N_nodes - 1)) * L;
      const bs = beta * s;
      phi[i] = Math.cosh(bs) + Math.cos(bs) - sigma * (Math.sinh(bs) + Math.sin(bs));
    }

    // 정규화 (최대값 = 1)
    let maxPhi = 0;
    for (let i = 0; i < N_nodes; i++) maxPhi = Math.max(maxPhi, Math.abs(phi[i]));
    if (maxPhi > 0) for (let i = 0; i < N_nodes; i++) phi[i] /= maxPhi;

    modes.push({ omega: omega_corrected, phi, damping: 0.01 }); // zeta = 0.01 (카본)
  }
  return modes;
}

// lumped mass 상태 → 모달 진폭 투영
function computeModalAmplitudes(state, arrowProps, modes) {
  const { N, x, y, z, vx, vy, vz, m } = state;
  const M_total = arrowProps.m_total;

  // 무게중심 (3D)
  let cmx = 0, cmy = 0, cmz = 0, cmvx = 0, cmvy = 0, cmvz = 0;
  for (let i = 0; i < N; i++) {
    cmx += m[i] * x[i]; cmy += m[i] * y[i]; cmz += m[i] * z[i];
    cmvx += m[i] * vx[i]; cmvy += m[i] * vy[i]; cmvz += m[i] * vz[i];
  }
  cmx /= M_total; cmy /= M_total; cmz /= M_total;
  cmvx /= M_total; cmvy /= M_total; cmvz /= M_total;

  // 화살 축 방향 (node 0 → node N-1, x-y 면)
  const adx = x[N - 1] - x[0], ady = y[N - 1] - y[0];
  const aLen = Math.sqrt(adx * adx + ady * ady) || 1;
  const ex = adx / aLen, ey = ady / aLen;
  const nx = -ey, ny = ex; // y-축 법선

  const axisAngle = Math.atan2(ey, ex);

  // y-축 횡방향 변위 (x-y 면내)
  const u = new Float64Array(N);
  const udot = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const rx = x[i] - cmx, ry = y[i] - cmy;
    u[i] = rx * nx + ry * ny;
    udot[i] = (vx[i] - cmvx) * nx + (vy[i] - cmvy) * ny;
  }

  // z-축 횡방향 변위 (화살 축이 x-y 면에 있으므로 z 자체가 횡변위)
  const uz = new Float64Array(N);
  const uzdot = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    uz[i] = z[i] - cmz;
    uzdot[i] = vz[i] - cmvz;
  }

  // y-축 모달 투영
  const modalAmps = [];
  for (let k = 0; k < modes.length; k++) {
    const phi = modes[k].phi;
    const omega = modes[k].omega;
    let Mk = 0, qk = 0, qdotk = 0;
    for (let i = 0; i < N; i++) {
      Mk += m[i] * phi[i] * phi[i];
      qk += m[i] * u[i] * phi[i];
      qdotk += m[i] * udot[i] * phi[i];
    }
    qk /= Mk; qdotk /= Mk;
    const A = Math.sqrt(qk * qk + (qdotk / omega) * (qdotk / omega));
    const phase = Math.atan2(qk, qdotk / omega);
    modalAmps.push({ A, phase, omega, damping: modes[k].damping });
  }

  // z-축 모달 투영 (동일 mode shapes — 원형 단면)
  const modalAmpsZ = [];
  for (let k = 0; k < modes.length; k++) {
    const phi = modes[k].phi;
    const omega = modes[k].omega;
    let Mk = 0, qk = 0, qdotk = 0;
    for (let i = 0; i < N; i++) {
      Mk += m[i] * phi[i] * phi[i];
      qk += m[i] * uz[i] * phi[i];
      qdotk += m[i] * uzdot[i] * phi[i];
    }
    qk /= Mk; qdotk /= Mk;
    const A = Math.sqrt(qk * qk + (qdotk / omega) * (qdotk / omega));
    const phase = Math.atan2(qk, qdotk / omega);
    modalAmpsZ.push({ A, phase, omega, damping: modes[k].damping });
  }

  return {
    CoM: { x: cmx, y: cmy, z: cmz, vx: cmvx, vy: cmvy, vz: cmvz },
    axisAngle,
    modalAmps,
    modalAmpsZ,
  };
}

// 마스터 시뮬레이션 함수: 전체 발시 과정 사전 계산
// 결합 동역학: 활채 1-DOF ODE + 시위 24노드 체인(SHAKE) + 화살 12노드 3D lumped-mass
function simulateRelease(params) {
  const dt = 0.00001;        // 10μs = 0.01ms
  const T_MAX = 0.030;       // 30ms
  const storeInterval = 10;  // 매 10스텝 (0.1ms) 마다 저장

  // 1) 사전 샘플링
  const samples = preSampleBowAnchors(params, 31);
  const arrowProps = computeArrowProperties(params);

  // 2) 활채 유효질량 (Klopsteg)
  const m_limb_each = 0.050;
  const m_siyah_each = 0.010;
  const m_string = params.stringMass || 0.005;
  // 활채 유효질량 계수: tapered beam 1차 모드 기반 0.17
  // 균일 보 0.236 → 국궁 테이퍼(근부 두꺼움) → 질량 근부 집중 → 유효질량↓
  // 시위 체인은 앵커+nock에 핀되어 있으므로 자유도가 제한적 → Klopsteg 유효질량에 포함 유지
  const m_eff_limb = 2 * (0.17 * m_limb_each + m_siyah_each) + m_string / 3;
  const zeta_limb = params.dampingRatio || 0.02;

  // 3) 만작 상태 초기화
  const fullDraw = samples[samples.length - 1];
  const nockPos = fullDraw.nockingPoint;
  const restPos = fullDraw.restPoint;

  // z-축: 화살 위치 (국궁 우궁: 궁사 오른쪽 = -z)
  const z_arrow = -((params.limbWidth || 0.028) / 2 + 0.003);

  // 시위 상현/하현 길이 (체인 초기화용)
  const _dxT = fullDraw.anchorTop.x - nockPos.x, _dyT = fullDraw.anchorTop.y - nockPos.y;
  const _dxB = fullDraw.anchorBot.x - nockPos.x, _dyB = fullDraw.anchorBot.y - nockPos.y;
  const L_upper = Math.sqrt(_dxT * _dxT + _dyT * _dyT);
  const L_lower = Math.sqrt(_dxB * _dxB + _dyB * _dyB);

  // 화살 초기화 (3D)
  const arrowState = initLumpedMassArrow(arrowProps, nockPos, restPos, z_arrow);

  // 시위 체인 초기화 (24노드 3D)
  const stringState = initStringChain(params, fullDraw.anchorTop, fullDraw.anchorBot, nockPos, L_upper, L_lower);

  // 활채 상태
  let q = fullDraw.q;
  let q_dot = 0;

  const vibParams = computeVibrationParams(params);
  const zRotParams = computeZRotationParams(params);
  const modes = computeFreeFreeModeshapes(arrowProps, arrowState.N);
  const nockClipF = params.nockClipForce || 3.0;

  // z축 활 회전 상태 (줌손 빨래 짜기)
  let theta_z = zRotParams.theta_ss; // 만작 정상상태 각도
  let theta_z_dot = 0;
  const c_z = 2 * zRotParams.zeta_z * Math.sqrt(zRotParams.k_z * zRotParams.I_z);

  // 4) 시뮬레이션 루프
  const phase1Frames = [];
  let separated = false;
  let phase2Data = null;
  // y축 발사각 보정: Fy/Fx impulse ratio 적산
  let Jy_string = 0;  // ∫Fy dt (시위력 y성분 충격량)
  let Jx_string = 0;  // ∫(-Fx) dt (시위력 x성분 충격량, 과녁 방향 양수)
  const totalSteps = Math.ceil(T_MAX / dt);

  for (let step = 0; step <= totalSteps; step++) {
    const t = step * dt;

    // ── A. 활채 상태에서 앵커 위치 보간 ──
    const limbState = interpolateBowByQ(samples, q);
    const anchorTop = limbState.anchorTop;
    const anchorBot = limbState.anchorBot;

    // 3D 앵커 (시위 앵커 = 활 중심면 z=0)
    const anchorTop3d = { x: anchorTop.x, y: anchorTop.y, z: 0 };
    const anchorBot3d = { x: anchorBot.x, y: anchorBot.y, z: 0 };

    if (arrowState.onString) {
      // ── B. 시위 체인 적분 ──
      // 화살 nock 위치로 시위 nockNode 핀
      const arrowNock3d = { x: arrowState.x[0], y: arrowState.y[0], z: arrowState.z[0] };
      stepStringChain(stringState, anchorTop3d, anchorBot3d, arrowNock3d, dt);

      // ── C. nock 위치: 정적 솔버의 nockingPoint 보간값 직접 사용 ──
      // nockingPoint = (nockX, nockY + nockingOffset) — 화살 오니 위치
      const nockTarget = limbState.nockingPoint;
      const dxT = anchorTop.x - nockTarget.x, dyT = anchorTop.y - nockTarget.y;
      const dxB = anchorBot.x - nockTarget.x, dyB = anchorBot.y - nockTarget.y;
      const distT = Math.sqrt(dxT*dxT + dyT*dyT) || 1e-6;
      const distB = Math.sqrt(dxB*dxB + dyB*dyB) || 1e-6;
      const e_sum_x = dxT/distT + dxB/distB;
      const e_sum_y = dyT/distT + dyB/distB;
      const e_sum_len = Math.sqrt(e_sum_x*e_sum_x + e_sum_y*e_sum_y) || 1e-6;

      // z: 체인 nockNode 양옆 노드에서 추출 (3D 기하 반영)
      const ni = stringState.nockNode;
      const dzT_chain = stringState.sz[ni - 1] - stringState.sz[ni];
      const dzB_chain = stringState.sz[ni + 1] - stringState.sz[ni];
      const dsT_chain = Math.sqrt(
        (stringState.sx[ni-1]-stringState.sx[ni])**2 +
        (stringState.sy[ni-1]-stringState.sy[ni])**2 +
        dzT_chain*dzT_chain) || 1e-6;
      const dsB_chain = Math.sqrt(
        (stringState.sx[ni+1]-stringState.sx[ni])**2 +
        (stringState.sy[ni+1]-stringState.sy[ni])**2 +
        dzB_chain*dzB_chain) || 1e-6;
      const e_sum_z = dzT_chain/dsT_chain + dzB_chain/dsB_chain;

      // ── D. 동적 T 계산 (Klopsteg) ──
      const F_restore_sep = limbState.F_draw;
      const m_coupled_sep = m_eff_limb + arrowProps.m_total;
      const T_dynamic = Math.abs(F_restore_sep) * arrowProps.m_total / m_coupled_sep;
      // x,y: 기존과 동일한 2D 정규화
      const Fx = T_dynamic * e_sum_x / e_sum_len;
      const Fy = T_dynamic * e_sum_y / e_sum_len;
      // z: 체인 기하에서 추출한 횡력 (에너지 분배와 독립)
      const Fz = T_dynamic * e_sum_z / e_sum_len;

      // ── E. 활채 ODE ──
      const F_restore = limbState.F_draw;
      const m_coupled = m_eff_limb + arrowProps.m_total;
      const k_local = Math.abs(F_restore) / Math.max(Math.abs(q), 0.01);
      const q_accel = -F_restore / m_coupled - 2 * zeta_limb * Math.sqrt(k_local / m_coupled) * q_dot;
      q += q_dot * dt + 0.5 * q_accel * dt * dt;
      q_dot += q_accel * dt;
      if (q < -0.15) q = -0.15;

      // ── E2. 활 z축 회전 ODE (줌손 빨래 짜기) ──
      // 시위 z축 복원 토크는 k_z(=T×halfLen²/L)에 이미 포함 (양양고자 기하 효과)
      // M_string_z는 제거 — nock Fz의 반작용은 시위→양양고자로 전달되므로 k_z에 포함
      {
        const k_z_current = limbState.T_current * zRotParams.k_z_per_T; // 동적 k_z
        const M_total_z = zRotParams.M_wrist
                        - k_z_current * theta_z - c_z * theta_z_dot;
        const theta_z_accel = M_total_z / zRotParams.I_z;
        theta_z += theta_z_dot * dt + 0.5 * theta_z_accel * dt * dt;
        theta_z_dot += theta_z_accel * dt;
        theta_z = Math.max(-1.0, Math.min(1.0, theta_z)); // 잔신용 확장 클램프
      }

      // ── F. 화살 적분: 강체 병진 + 굽힘 섭동 (3D) ──
      const { N, x, y, z, vx, vy, vz, m } = arrowState;
      const x_old = Float64Array.from(x);
      const y_old = Float64Array.from(y);
      const z_old = Float64Array.from(z);

      // nockTarget은 위 C단계에서 이미 계산됨

      // 1) x,y 강체 병진
      const dx_rigid = nockTarget.x - x[0];
      const dy_rigid = nockTarget.y - y[0];
      for (let i = 0; i < N; i++) {
        x[i] += dx_rigid;
        y[i] += dy_rigid;
      }

      // 2) x,y 굽힘 섭동
      const bend = computeBendingForces(arrowState);
      const restF = computeRestContactForce(arrowState, restPos);

      // Fy impulse 적산 (y축 발사각 보정용)
      // 1-DOF 모델에서 nock 구속이 Fy의 CoM 가속을 흡수하므로,
      // impulse ratio (Jy/Jx)로 분리 시점 vy를 사후 보정
      // 중력 impulse도 포함 (on-string 동안 시위 구속이 중력을 지탱하므로 사후 보정 필요)
      Jy_string += (Fy + (restF.Fy || 0) - arrowProps.m_total * 9.81) * dt;
      Jx_string += Fx * dt;  // Fx 그대로 적산 (음수, 과녁 방향)
      for (let i = 1; i < N; i++) {
        const ax_i = bend.fx[i] / m[i];
        const ay_i = (bend.fy[i] - m[i] * 9.81) / m[i] + (i === restF.nodeIndex && restF.Fy ? restF.Fy / m[i] : 0);
        x[i] += 0.5 * ax_i * dt * dt;
        y[i] += 0.5 * ay_i * dt * dt;
      }

      // 3) z-축 적분: 시위 z-힘 + 엄지 이탈 횡력 + z-굽힘 + rest z접촉
      const bendZ = computeBendingForcesZ(arrowState);
      // 엄지 이탈 횡력: +z 방향 (활 쪽으로), 지수감쇠 τ=1ms
      const Fz_thumb = (params.thumbReleaseForce || 0) * Math.exp(-t / 0.001);
      // rest z축 접촉: 활 표면(z ≈ -limbWidth/2)에서 +z 방향 관통 방지
      // 화살이 활 줌통 근처를 지날 때 활채 표면에 걸림 → paradox 굽힘의 원인
      const z_bow_surface = -((params.limbWidth || 0.028) / 2); // 활 표면 z (-14mm)
      const Fz_rest_arr = new Float64Array(N); // 각 노드별 z접촉력
      for (let i = 1; i < N; i++) {
        // 줌통 근처 x 범위 (±6cm)에 있는 노드만 접촉 판정
        if (Math.abs(x[i]) < 0.06 && z[i] > z_bow_surface) {
          const gap_z = z[i] - z_bow_surface;
          Fz_rest_arr[i] = -5e3 * gap_z - 50 * vz[i]; // 페널티 + 감쇠
          if (Fz_rest_arr[i] > 0) Fz_rest_arr[i] = 0; // 일방향 (밀어내기만)
        }
      }
      // nock (node 0): 시위 z-힘 + 엄지 횡력 + z-굽힘력
      const az_nock = (Fz + Fz_thumb + bendZ.fz[0]) / m[0];
      z[0] += vz[0] * dt + 0.5 * az_nock * dt * dt;
      // 나머지 노드: z-굽힘력 + 활채 z접촉
      for (let i = 1; i < N; i++) {
        const az_i = (bendZ.fz[i] + Fz_rest_arr[i]) / m[i];
        z[i] += vz[i] * dt + 0.5 * az_i * dt * dt;
      }

      // 4) SHAKE (3D)
      enforceDistanceConstraints(arrowState, 30, 0);
      // nock x,y 재투영 (시위 구속)
      arrowState.x[0] = nockTarget.x;
      arrowState.y[0] = nockTarget.y;
      // nock z는 자유 (시위 z-힘으로 결정됨, 구속 아님)

      // 5) 속도
      for (let i = 0; i < N; i++) {
        vx[i] = (x[i] - x_old[i]) / dt;
        vy[i] = (y[i] - y_old[i]) / dt;
        vz[i] = (z[i] - z_old[i]) / dt;
      }
      // 고주파 감쇠
      const alpha = 0.05;
      for (let i = 1; i < N - 1; i++) {
        vx[i] += alpha * ((vx[i-1]+vx[i+1])/2 - vx[i]);
        vy[i] += alpha * ((vy[i-1]+vy[i+1])/2 - vy[i]);
        vz[i] += alpha * ((vz[i-1]+vz[i+1])/2 - vz[i]);
      }

      // CoM 캐시 (프레임 저장용)
      {
        let cx=0,cy=0,cz=0,cvx=0,cvy=0,cvz=0,mt=0;
        for (let i=0; i<N; i++) {
          const mi=m[i]; cx+=mi*x[i]; cy+=mi*y[i]; cz+=mi*z[i];
          cvx+=mi*vx[i]; cvy+=mi*vy[i]; cvz+=mi*vz[i]; mt+=mi;
        }
        arrowState._comX=cx/mt; arrowState._comY=cy/mt; arrowState._comZ=cz/mt;
        arrowState._comVx=cvx/mt; arrowState._comVy=cvy/mt; arrowState._comVz=cvz/mt;
      }

      // ── G. 분리 판정 (3D) ──
      const string_dir_x = e_sum_x, string_dir_y = e_sum_y;
      const sdLen = Math.sqrt(string_dir_x*string_dir_x + string_dir_y*string_dir_y) || 1e-6;
      const sd_nx = -string_dir_y / sdLen, sd_ny = string_dir_x / sdLen;
      const F_perp_xy = Math.abs(Fx * sd_nx + Fy * sd_ny);
      // 분리 판정 1: x-y면 횡력이 클립 보유력 초과
      if (F_perp_xy > nockClipF && t > 0.003) {
        arrowState.onString = false;
        stringState.nockPinned = false;
      }
      // 분리 판정 2: 시위가 화살을 궁사 쪽으로 밀기 시작 (Fx > 0)
      // → 오니가 시위에서 자연 이탈 (인장→압축 전환)
      if (Fx > 0 && t > 0.003) {
        arrowState.onString = false;
        stringState.nockPinned = false;
      }

    } else {
      // ── 분리 후: 화살 자유 비행 + 활채 자유 진동 + 시위 자유 진동 ──
      const limbState2 = interpolateBowByQ(samples, q);
      const F_restore = limbState2.F_draw;
      const k_local = Math.abs(F_restore) / Math.max(Math.abs(q), 0.01);
      const q_accel = -F_restore / m_eff_limb - 2 * zeta_limb * Math.sqrt(k_local / m_eff_limb) * q_dot;
      q += q_dot * dt + 0.5 * q_accel * dt * dt;
      q_dot += q_accel * dt;
      if (q < -0.15) q = -0.15;

      // 화살 자유 적분 (3D)
      stepLumpedMass(arrowState, limbState, restPos, dt, 0);

      // CoM 캐시 (분리 후)
      {
        const {N:_N,x:_x,y:_y,z:_z,vx:_vx,vy:_vy,vz:_vz,m:_m}=arrowState;
        let cx=0,cy=0,cz=0,cvx=0,cvy=0,cvz=0,mt=0;
        for(let i=0;i<_N;i++){const mi=_m[i];cx+=mi*_x[i];cy+=mi*_y[i];cz+=mi*_z[i];cvx+=mi*_vx[i];cvy+=mi*_vy[i];cvz+=mi*_vz[i];mt+=mi;}
        arrowState._comX=cx/mt;arrowState._comY=cy/mt;arrowState._comZ=cz/mt;
        arrowState._comVx=cvx/mt;arrowState._comVy=cvy/mt;arrowState._comVz=cvz/mt;
      }

      // 시위 자유 진동 (nockNode 핀 해제됨)
      stepStringChain(stringState, anchorTop3d, anchorBot3d, null, dt);

      // z축 회전 (분리 후): k_z=0 (시위 직선, V자 복원력 소멸), M_wrist 감쇠만
      {
        const t_since_sep = phase2Data ? (t - phase2Data.t_separation / 1000) : 0;
        const M_wrist_decay = zRotParams.M_wrist * Math.exp(-t_since_sep / 0.05);
        const M_total_z = M_wrist_decay - c_z * theta_z_dot; // k_z=0
        const theta_z_accel = M_total_z / zRotParams.I_z;
        theta_z += theta_z_dot * dt + 0.5 * theta_z_accel * dt * dt;
        theta_z_dot += theta_z_accel * dt;
        theta_z = Math.max(-1.0, Math.min(1.0, theta_z)); // 잔신용 확장
      }
    }

    // 분리 감지 → 모달 전환
    if (!arrowState.onString && !separated) {
      separated = true;

      // ── y축 발사각 보정 (impulse ratio) ──
      // 1-DOF 활채 모델에서 nock은 nockTarget.y에 기하학적으로 구속되어
      // 시위력 Fy의 CoM 가속 효과가 구속반력에 흡수됨.
      // impulse-momentum theorem으로 올바른 vy를 복원:
      //   vy/vx = Jy/Jx (시위력 충격량 비율)
      if (Math.abs(Jx_string) > 0.01) {
        // 현재 CoM vx (정확) 기준으로 vy 보정
        const { N: _N, vy: _vy } = arrowState;
        let _vyCom = 0, _mTotal = 0;
        for (let i = 0; i < _N; i++) { _vyCom += arrowState.m[i] * _vy[i]; _mTotal += arrowState.m[i]; }
        _vyCom /= _mTotal;
        let _vxCom = 0;
        for (let i = 0; i < _N; i++) _vxCom += arrowState.m[i] * arrowState.vx[i];
        _vxCom /= _mTotal;
        const vy_correct = _vxCom * (Jy_string / Jx_string);
        const dvy = vy_correct - _vyCom;
        // 모든 노드에 균일 보정 (CoM 속도만 변경, 상대 속도 보존)
        for (let i = 0; i < _N; i++) _vy[i] += dvy;
      }

      phase2Data = computeModalAmplitudes(arrowState, arrowProps, modes);
      phase2Data.t_separation = t * 1000;
      phase2Data.bowVibParams = vibParams;
      phase2Data.modes = modes;
      phase2Data.limb_q0 = q;
      phase2Data.limb_qdot0 = q_dot;
      phase2Data.m_eff_limb = m_eff_limb;
      // z축 회전 초기조건 (Phase 2 해석해용)
      phase2Data.zRotParams = zRotParams;
      phase2Data.theta_z0 = theta_z;
      phase2Data.theta_z_dot0 = theta_z_dot;
      // 에너지 감사 (3D)
      const _cm = phase2Data.CoM;
      const _KE_arrow = 0.5 * arrowProps.m_total * (_cm.vx*_cm.vx + _cm.vy*_cm.vy + (_cm.vz||0)*(_cm.vz||0));
      const _KE_limb = 0.5 * m_eff_limb * q_dot * q_dot;
      // vy 보정으로 인한 에너지 추가분 (impulse ratio 사후 보정)
      const _KE_vy_corr = 0.5 * arrowProps.m_total * _cm.vy * _cm.vy;
      phase2Data.energyAudit = {
        E_stored: vibParams.E_stored,
        KE_arrow: _KE_arrow,
        KE_limb: _KE_limb,
        KE_vy_correction: _KE_vy_corr,  // vy 보정에 의한 에너지 (0.1% 수준)
        eta: vibParams.E_stored > 0 ? _KE_arrow / vibParams.E_stored : 0,
      };
    }

    if (separated && (t * 1000 - phase2Data.t_separation) > 0.5) break;

    // 재접촉 에러
    if (arrowState.recontactError && separated) {
      phase1Frames.push({
        t_ms: t * 1000, drawAmount: limbState.drawAmount,
        nodes: Array.from({ length: arrowState.N }, (_, i) => ({ x: arrowState.x[i], y: arrowState.y[i], z: arrowState.z[i] })),
        stringNodes: (() => {
          // 렌더링용: on-string 시 x,y를 직선 보간 (물리 상태는 보존)
          const sN = stringState.N, ni = stringState.nockNode;
          return Array.from({ length: sN }, (_, i) => {
            let rx = stringState.sx[i], ry = stringState.sy[i];
            if (stringState.nockPinned) {
              if (i > 0 && i < ni) {
                const f = i / ni;
                rx = stringState.sx[0] + (stringState.sx[ni] - stringState.sx[0]) * f;
                ry = stringState.sy[0] + (stringState.sy[ni] - stringState.sy[0]) * f;
              } else if (i > ni && i < sN - 1) {
                const f = (i - ni) / (sN - 1 - ni);
                rx = stringState.sx[ni] + (stringState.sx[sN-1] - stringState.sx[ni]) * f;
                ry = stringState.sy[ni] + (stringState.sy[sN-1] - stringState.sy[ni]) * f;
              }
            }
            return { x: rx, y: ry, z: stringState.sz[i] };
          });
        })(),
        contactState: arrowState.wasInContact ? 'contact' : 'free',
        onString: arrowState.onString, recontactError: true, q, bowRotZ: theta_z,
      });
      break;
    }

    // 프레임 저장
    if (step % storeInterval === 0) {
      phase1Frames.push({
        t_ms: t * 1000,
        drawAmount: limbState.drawAmount,
        nodes: Array.from({ length: arrowState.N }, (_, i) => ({ x: arrowState.x[i], y: arrowState.y[i], z: arrowState.z[i] })),
        stringNodes: (() => {
          // 렌더링용: on-string 시 x,y를 직선 보간 (물리 상태는 보존)
          const sN = stringState.N, ni = stringState.nockNode;
          return Array.from({ length: sN }, (_, i) => {
            let rx = stringState.sx[i], ry = stringState.sy[i];
            if (stringState.nockPinned) {
              if (i > 0 && i < ni) {
                const f = i / ni;
                rx = stringState.sx[0] + (stringState.sx[ni] - stringState.sx[0]) * f;
                ry = stringState.sy[0] + (stringState.sy[ni] - stringState.sy[0]) * f;
              } else if (i > ni && i < sN - 1) {
                const f = (i - ni) / (sN - 1 - ni);
                rx = stringState.sx[ni] + (stringState.sx[sN-1] - stringState.sx[ni]) * f;
                ry = stringState.sy[ni] + (stringState.sy[sN-1] - stringState.sy[ni]) * f;
              }
            }
            return { x: rx, y: ry, z: stringState.sz[i] };
          });
        })(),
        nockPos: { x: arrowState.x[0], y: arrowState.y[0], z: arrowState.z[0] },
        anchorTop: { x: anchorTop.x, y: anchorTop.y, z: 0 },
        anchorBot: { x: anchorBot.x, y: anchorBot.y, z: 0 },
        contactState: arrowState.wasInContact ? 'contact' : 'free',
        onString: arrowState.onString,
        recontactError: arrowState.recontactError,
        q, q_dot, bowRotZ: theta_z,
        // CoM 위치+속도 (질량가중, 인라인)
        CoM: { x: arrowState._comX, y: arrowState._comY, z: arrowState._comZ,
               vx: arrowState._comVx, vy: arrowState._comVy, vz: arrowState._comVz },
      });
    }
  }

  // 분리 안 됐으면 최종 상태에서 모달 투영
  if (!phase2Data) {
    arrowState.onString = false;
    phase2Data = computeModalAmplitudes(arrowState, arrowProps, modes);
    phase2Data.t_separation = T_MAX * 1000;
    phase2Data.bowVibParams = vibParams;
    phase2Data.modes = modes;
    phase2Data.limb_q0 = q;
    phase2Data.limb_qdot0 = q_dot;
    phase2Data.m_eff_limb = m_eff_limb;
    phase2Data.zRotParams = zRotParams;
    phase2Data.theta_z0 = theta_z;
    phase2Data.theta_z_dot0 = theta_z_dot;
  }

  // ── z축 회전 연장 적분 (분리 후 500ms, 잔신 재현) ──
  if (phase2Data) {
    const zRotFrames = [];
    const dt_zrot = 0.0005; // 0.5ms
    const T_zrot_max = 0.500; // 500ms
    let th_z = theta_z, th_z_dot = theta_z_dot;
    let t_zrot = 0;
    let storeCounter = 0;
    while (t_zrot < T_zrot_max) {
      // 1ms마다 저장
      if (storeCounter % 2 === 0) {
        zRotFrames.push({ t_ms: t_zrot * 1000, theta_z: th_z });
      }
      const M_w = zRotParams.M_wrist * Math.exp(-t_zrot / 0.05);
      const accel = (M_w - c_z * th_z_dot) / zRotParams.I_z; // k_z=0
      th_z += th_z_dot * dt_zrot + 0.5 * accel * dt_zrot * dt_zrot;
      th_z_dot += accel * dt_zrot;
      th_z = Math.max(-1.0, Math.min(1.0, th_z));
      t_zrot += dt_zrot;
      storeCounter++;
    }
    phase2Data.zRotFrames = zRotFrames;
  }

  return { phase1Frames, phase2Data, arrowProps, samples };
}
window.__simulateRelease = simulateRelease;

// 모달 중첩으로 임의 시각의 화살 형상 계산 (Phase 2)
function computeModalArrowShape(phase2Data, arrowProps, t_post_sec) {
  const { CoM, axisAngle, modalAmps } = phase2Data;
  const modalAmpsZ = phase2Data.modalAmpsZ || [];
  const modes = phase2Data.modes;
  const N = 12;
  const g = 9.81;

  // CoM 탄도 (3D)
  const cx = CoM.x + CoM.vx * t_post_sec;
  const cy = CoM.y + CoM.vy * t_post_sec - 0.5 * g * t_post_sec * t_post_sec;
  const cz = (CoM.z || 0) + (CoM.vz || 0) * t_post_sec; // z: 중력 없음

  // 비행 각도 블렌딩 (x-y면)
  const vy_t = CoM.vy - g * t_post_sec;
  const velocityAngle = Math.atan2(vy_t, CoM.vx);
  const alignTime = 0.05;
  const blend = Math.min(1, t_post_sec / alignTime);
  let angleDiff = velocityAngle - axisAngle;
  while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
  while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;
  const flightAngle = axisAngle + angleDiff * blend;

  const ex = Math.cos(flightAngle), ey = Math.sin(flightAngle);
  const nx = -ey, ny = ex;

  const ds = arrowProps.L / (N - 1);
  const nodes = [];
  for (let i = 0; i < N; i++) {
    const s = i * ds - arrowProps.L / 2;

    // y-축 모달 횡변위
    let w = 0;
    for (let k = 0; k < modalAmps.length && k < modes.length; k++) {
      const { A, phase, omega, damping } = modalAmps[k];
      const decay = Math.exp(-damping * omega * t_post_sec);
      w += A * decay * Math.sin(omega * t_post_sec + phase) * modes[k].phi[i];
    }

    // z-축 모달 횡변위
    let wz = 0;
    for (let k = 0; k < modalAmpsZ.length && k < modes.length; k++) {
      const { A, phase, omega, damping } = modalAmpsZ[k];
      const decay = Math.exp(-damping * omega * t_post_sec);
      wz += A * decay * Math.sin(omega * t_post_sec + phase) * modes[k].phi[i];
    }

    nodes.push({
      x: cx + s * ex + w * nx,
      y: cy + s * ey + w * ny,
      z: cz + wz,
    });
  }

  return { nodes, cx, cy, cz, flightAngle };
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

  // 조그셔틀 (발시 전체 과정 시간 탐색)
  // t=0: 만작, t=RELEASE_MS: 시위 완전 복원, t>RELEASE_MS: 진동+화살비행
  const RELEASE_MS = 100; // 시위 풀림 시간 (ms)
  const [jogMode, setJogMode] = useState(false);
  const [jogTime, setJogTime] = useState(0); // ms 단위
  const [jogStep, setJogStep] = useState(0.1); // 드래그 단위 (ms)
  const jogDragRef = useRef({ dragging: false, startX: 0, startTime: 0 });
  const jogDataRef = useRef(null);
  const jogAutoPlayRef = useRef({ phase: 'idle', speed: 1 }); // 자동재생: forward → rewind → stop
  const restShapeRef = useRef(null);

  // 에너지/힘 계산
  // 솔버 결과를 메모이즈 (활 기하학 + brace height 등 계산)
  const bowGeomData = useMemo(() => generateBowGeometry(params, drawAmount), [params, drawAmount]);
  const computedBraceHeight = bowGeomData.braceHeight;
  const computedLoadFactor = bowGeomData.loadFactor;

  // 에너지/화살속도: params 변경 시 재계산 (무거우므로 params에만 의존)
  const energyData = useMemo(() => {
    const vp = computeVibrationParams(params);
    const eta = 0.82;
    const m_arrow = params.arrowMass || 0.025;
    const v_arrow = Math.sqrt(Math.max(0, 2 * eta * vp.E_stored / m_arrow));
    const KE_arrow = 0.5 * m_arrow * v_arrow * v_arrow;
    return { E_stored: vp.E_stored, v_arrow, KE_arrow, eta };
  }, [params]);

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
    // 조그셔틀 활성 시 React 시위를 건너뛰고 jogStringRef로 대체
    if (showString && !jogMode) {
      const { stringPoints, nockPoint } = generateStringPath(bowGeom, draw, params.limbWidth);
      const stringGroup = new THREE.Group();

      const stringMat = new THREE.MeshPhysicalMaterial({
        color: 0xe8d8b8,
        roughness: 0.6,
        metalness: 0.0,
      });
      const strR = params.stringDiameter * 0.5;

      // 시위를 구간별 직선 튜브로 렌더링 (CatmullRom의 꺾임점 보간 방지)
      for (let si = 0; si < stringPoints.length - 1; si++) {
        const segCurve = new THREE.LineCurve3(stringPoints[si], stringPoints[si + 1]);
        const segGeom = new THREE.TubeGeometry(segCurve, 1, strR, 6, false);
        stringGroup.add(new THREE.Mesh(segGeom, stringMat));
      }

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
      // Spine 기반 탄성체 모델: 처짐 형상을 따르는 TubeGeometry
      if (showArrow && draw > 0.01 && !isArrowFlyingRef.current && bowGeom.arrowShape) {
        const arrowGroup = new THREE.Group();
        const aShape = bowGeom.arrowShape;
        const aProps = bowGeom.arrowProps;
        const arrowLen = aProps.L;
        const shaftRadius = aProps.D_outer / 2;

        // 화살 Z 오프셋 (국궁 우궁: 궁사 오른쪽 = -z)
        const arrowZ = -((params.limbWidth || 0.028) / 2 + 0.003);

        // 처짐 형상을 따르는 화살대 (TubeGeometry + CatmullRomCurve3)
        const curvePts = aShape.nodes.map(n => new THREE.Vector3(n.x, n.y, arrowZ));
        if (curvePts.length >= 2) {
          const curve = new THREE.CatmullRomCurve3(curvePts);
          const shaftGeom = new THREE.TubeGeometry(curve, 20, shaftRadius, 6, false);
          const shaftMat = new THREE.MeshPhysicalMaterial({ color: 0x1a1a1a, roughness: 0.4, metalness: 0.6 });
          const shaft = new THREE.Mesh(shaftGeom, shaftMat);
          arrowGroup.add(shaft);
        }

        // 촉 (tip 위치, 끝 접선 방향)
        const tipNode = aShape.nodes[aShape.nodes.length - 1];
        const preTipNode = aShape.nodes[aShape.nodes.length - 2];
        const tipDx = tipNode.x - preTipNode.x;
        const tipDy = tipNode.y - preTipNode.y;
        const tipAngle = Math.atan2(tipDy, tipDx);
        const tipGeom = new THREE.ConeGeometry(0.006, 0.04, 6);
        const tipMat = new THREE.MeshPhysicalMaterial({ color: 0x888888, metalness: 0.8, roughness: 0.2 });
        const tip = new THREE.Mesh(tipGeom, tipMat);
        tip.position.set(tipNode.x + Math.cos(tipAngle) * 0.02, tipNode.y + Math.sin(tipAngle) * 0.02, arrowZ);
        tip.rotation.z = tipAngle - Math.PI / 2;
        arrowGroup.add(tip);

        // 깃 (nock 끝, 반대 방향)
        // 빨간 깃(cock feather, fi=0)은 활 반대쪽(+y, 위쪽)을 향함
        const nockNode = aShape.nodes[0];
        const postNockNode = aShape.nodes[1];
        const nockDx = postNockNode.x - nockNode.x;
        const nockDy = postNockNode.y - nockNode.y;
        const nockAngle = Math.atan2(nockDy, nockDx);
        // 깃 위치: nock에서 5cm 앞이 깃의 nock측 끝, 깃 길이 4cm → 중심 = 7cm
        const fletchLen = 0.04, fletchCenter = 0.07;
        for (let fi = 0; fi < 3; fi++) {
          const angle = (fi / 3) * Math.PI * 2 + Math.PI / 2;
          const fletchGeom = new THREE.PlaneGeometry(fletchLen, 0.012);
          const fletchMat = new THREE.MeshPhysicalMaterial({
            color: fi === 0 ? 0xcc2222 : 0xeeeeee,
            side: THREE.DoubleSide, roughness: 0.8
          });
          const fletch = new THREE.Mesh(fletchGeom, fletchMat);
          const fletchX = nockNode.x + Math.cos(nockAngle) * fletchCenter;
          const fletchY = nockNode.y + Math.sin(nockAngle) * fletchCenter;
          fletch.position.set(fletchX, fletchY + Math.sin(angle) * 0.008, arrowZ + Math.cos(angle) * 0.008);
          fletch.rotation.x = angle;
          arrowGroup.add(fletch);
        }

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
    // nockingPoint / pullPoint 마커 — 비활성화 (시각적 혼란 방지)

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
          if (d >= 1) { anim.phase = "computing"; anim.t = 0; setAnimPhase("computing"); }
        } else if (anim.phase === "computing") {
          // 만작 도달 → 시뮬레이션 사전 계산 (1회) → 즉시 조그셔틀
          if (!anim.releaseData) {
            window.__DEBUG_SIM_START = Date.now();
            try {
              anim.releaseData = simulateRelease(params);
              window.__DEBUG_RELEASE = anim.releaseData;
              window.__DEBUG_SIM_END = Date.now();
            } catch(e) {
              window.__DEBUG_RELEASE_ERROR = e.message + ' | ' + e.stack;
              window.__DEBUG_SIM_END = Date.now();
            }
          }
          // 계산 완료 → 즉시 조그셔틀 모드 전환
          anim.phase = "idle";
          setIsAnimating(false);
          setAnimPhase("idle");
          setDrawAmount(0);
          isArrowFlyingRef.current = false;
          if (bowGroupRef.current) { bowGroupRef.current.position.x = 0; bowGroupRef.current.rotation.y = 0; }
          if (stringMeshRef.current) { stringMeshRef.current.position.x = 0; stringMeshRef.current.rotation.y = 0; }
          // 조그셔틀 데이터: 시뮬레이션 결과로 구성
          jogDataRef.current = {
            releaseData: anim.releaseData,
            shaftRadius: (params.arrowOuterDiam || 0.0052) / 2,
          };
          jogAutoPlayRef.current = { phase: 'forward', speed: 1 }; // 자동재생 시작
          setJogMode(true);
          setJogTime(0);
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
  }, [drawAmount, params, showString, showArrow, showGrid, jogMode, updateBowMesh]);

  // ── 조그셔틀: lumped-mass 시뮬레이션 결과 기반 프레임 렌더 ──
  const lumpedArrowRef = useRef(null); // lumped-mass 화살 전용 메시 그룹
  const jogStringRef = useRef(null); // 조그셔틀 시위 오버라이드 라인

  // lumped-mass 화살을 polyline TubeGeometry로 렌더하는 헬퍼
  const renderLumpedArrow = useCallback((nodes, shaftRadius) => {
    if (!sceneRef.current) return;
    // 기존 메시 정리
    if (lumpedArrowRef.current) {
      lumpedArrowRef.current.traverse(c => {
        if (c.geometry) c.geometry.dispose();
        if (c.material) c.material.dispose();
      });
      sceneRef.current.remove(lumpedArrowRef.current);
    }

    const ag = new THREE.Group();
    const pts = nodes.map(n => new THREE.Vector3(n.x, n.y, n.z || 0));
    if (pts.length >= 2) {
      const curve = new THREE.CatmullRomCurve3(pts);
      const geom = new THREE.TubeGeometry(curve, pts.length * 2, shaftRadius, 6, false);
      const mat = new THREE.MeshPhysicalMaterial({ color: 0x1a1a1a, roughness: 0.4, metalness: 0.6 });
      ag.add(new THREE.Mesh(geom, mat));
    }

    // 촉
    const tipNode = nodes[nodes.length - 1];
    const preTip = nodes[nodes.length - 2];
    const tipAngle = Math.atan2(tipNode.y - preTip.y, tipNode.x - preTip.x);
    const tipGeom = new THREE.ConeGeometry(0.006, 0.04, 6);
    const tipMat = new THREE.MeshPhysicalMaterial({ color: 0x888888, metalness: 0.8, roughness: 0.2 });
    const tip = new THREE.Mesh(tipGeom, tipMat);
    tip.position.set(tipNode.x + Math.cos(tipAngle) * 0.02, tipNode.y + Math.sin(tipAngle) * 0.02, tipNode.z || 0);
    tip.rotation.z = tipAngle - Math.PI / 2;
    ag.add(tip);

    // 깃: nock에서 5cm 앞이 nock측 끝, 길이 4cm, 중심 = 7cm
    const nockNode = nodes[0], postNock = nodes[1];
    const nockAng = Math.atan2(postNock.y - nockNode.y, postNock.x - nockNode.x);
    const fletchLen2 = 0.04, fletchCenter2 = 0.07;
    for (let fi = 0; fi < 3; fi++) {
      const a = (fi / 3) * Math.PI * 2 + Math.PI / 2;
      const fg = new THREE.PlaneGeometry(fletchLen2, 0.012);
      const fm = new THREE.MeshPhysicalMaterial({
        color: fi === 0 ? 0xcc2222 : 0xeeeeee, side: THREE.DoubleSide, roughness: 0.8
      });
      const f = new THREE.Mesh(fg, fm);
      f.position.set(
        nockNode.x + Math.cos(nockAng) * fletchCenter2,
        nockNode.y + Math.sin(nockAng) * fletchCenter2 + Math.sin(a) * 0.008,
        Math.cos(a) * 0.008
      );
      f.rotation.x = a;
      ag.add(f);
    }

    sceneRef.current.add(ag);
    lumpedArrowRef.current = ag;
  }, []);

  // CoM 마커 (밝은 구)
  const comMarkerRef = useRef(null);

  useEffect(() => {
    if (!jogMode || !jogDataRef.current || !jogDataRef.current.releaseData) return;
    const rd = jogDataRef.current.releaseData;
    const shaftR = jogDataRef.current.shaftRadius;
    const frames = rd.phase1Frames;
    const p2 = rd.phase2Data;
    const t_sep = p2.t_separation;
    const lastFrameT = frames.length > 0 ? frames[frames.length - 1].t_ms : 0;

    if (jogTime <= lastFrameT) {
      // ── Phase 1: lumped-mass 프레임 재생 ──
      // 가장 가까운 프레임 찾기
      let fi = 0;
      for (let i = 1; i < frames.length; i++) {
        if (frames[i].t_ms > jogTime) break;
        fi = i;
      }
      const frame = frames[fi];

      // 활 형상: drawAmount로 React 렌더
      setDrawAmount(frame.drawAmount);
      isArrowFlyingRef.current = true; // 정적 화살 숨기기 (lumped 화살이 대체)

      // 활 진동 없음 (시위 연결 중), z축 회전만 적용
      if (bowGroupRef.current) {
        bowGroupRef.current.position.x = 0;
        bowGroupRef.current.rotation.y = frame.bowRotZ || 0;
      }

      // React 시위 숨기고 프레임 기반 시위로 대체
      if (stringMeshRef.current) stringMeshRef.current.visible = false;

      // 이전 조그 시위 제거
      if (jogStringRef.current && sceneRef.current) {
        jogStringRef.current.traverse(c => { if (c.geometry) c.geometry.dispose(); if (c.material) c.material.dispose(); });
        sceneRef.current.remove(jogStringRef.current);
        jogStringRef.current = null;
      }

      // 시위 체인 렌더 (24노드 3D polyline) 또는 폴백 (3점 직선)
      if (sceneRef.current) {
        let pts;
        if (frame.stringNodes && frame.stringNodes.length > 2) {
          // 시위 체인 전체 노드 사용
          pts = frame.stringNodes.map(n => new THREE.Vector3(n.x, n.y, n.z || 0));
        } else if (frame.anchorTop && frame.anchorBot && frame.nockPos) {
          // 폴백: 기존 3점
          const nk = frame.nockPos, aT = frame.anchorTop, aB = frame.anchorBot;
          pts = [
            new THREE.Vector3(aB.x, aB.y, aB.z || 0),
            new THREE.Vector3(nk.x, nk.y, nk.z || 0),
            new THREE.Vector3(aT.x, aT.y, aT.z || 0),
          ];
        }
        if (pts && pts.length >= 2) {
          const curve = new THREE.CatmullRomCurve3(pts);
          const strR = (params.stringDiameter || 0.002) * 0.5;
          const geo = new THREE.TubeGeometry(curve, pts.length * 2, strR, 4, false);
          const mat = new THREE.MeshBasicMaterial({ color: 0xe8d8b8 });
          const mesh = new THREE.Mesh(geo, mat);
          sceneRef.current.add(mesh);
          jogStringRef.current = mesh;
        }
      }

      // lumped-mass 화살 렌더
      renderLumpedArrow(frame.nodes, shaftR);
      if (flyingArrowRef.current) flyingArrowRef.current.visible = false;

      // CoM 마커 (Phase 1)
      if (frame.CoM && sceneRef.current) {
        if (comMarkerRef.current) sceneRef.current.remove(comMarkerRef.current);
        const sg = new THREE.SphereGeometry(0.006, 12, 12);
        const sm = new THREE.MeshBasicMaterial({ color: 0x00ff88 });
        const sp = new THREE.Mesh(sg, sm);
        sp.position.set(frame.CoM.x, frame.CoM.y, frame.CoM.z);
        sceneRef.current.add(sp);
        comMarkerRef.current = sp;
      }

    } else {
      // ── Phase 2: 모달 중첩 자유 비행 ──
      setDrawAmount(0);
      isArrowFlyingRef.current = true;

      // 조그 시위 제거, React 시위 복원
      if (jogStringRef.current && sceneRef.current) {
        jogStringRef.current.traverse(c => { if (c.geometry) c.geometry.dispose(); if (c.material) c.material.dispose(); });
        sceneRef.current.remove(jogStringRef.current);
        jogStringRef.current = null;
      }
      if (stringMeshRef.current) stringMeshRef.current.visible = true;

      const t_post = (jogTime - t_sep) / 1000; // 초
      const { omega0, omega_d, zeta, A_grip } = p2.bowVibParams;

      // 활 진동 (x축) + z축 회전 (줌손 빨래 짜기)
      const vib = A_grip * Math.exp(-zeta * omega0 * t_post) * Math.sin(omega_d * t_post);
      // z축 회전: zRotFrames 보간 (k_z=0 수치 적분 결과)
      let theta_z_render = 0;
      if (p2.zRotFrames && p2.zRotFrames.length > 0) {
        const t_ms_post = jogTime - t_sep;
        const frames = p2.zRotFrames;
        if (t_ms_post <= 0) {
          theta_z_render = frames[0].theta_z;
        } else if (t_ms_post >= frames[frames.length - 1].t_ms) {
          theta_z_render = frames[frames.length - 1].theta_z;
        } else {
          let fi = 0;
          for (let i = 1; i < frames.length; i++) {
            if (frames[i].t_ms > t_ms_post) break;
            fi = i;
          }
          const f0 = frames[fi], f1 = frames[Math.min(fi + 1, frames.length - 1)];
          const frac = (f1.t_ms > f0.t_ms) ? (t_ms_post - f0.t_ms) / (f1.t_ms - f0.t_ms) : 0;
          theta_z_render = f0.theta_z + (f1.theta_z - f0.theta_z) * frac;
        }
      } else if (p2.zRotParams) {
        // 폴백: 기존 해석해 (하위 호환)
        const zrp = p2.zRotParams;
        const th0 = p2.theta_z0 || 0;
        const thd0 = p2.theta_z_dot0 || 0;
        const exp_d = Math.exp(-zrp.zeta_z * zrp.omega_z * t_post);
        theta_z_render = exp_d * (th0 * Math.cos(zrp.omega_d_z * t_post)
                      + (thd0 / Math.max(zrp.omega_d_z, 0.01)) * Math.sin(zrp.omega_d_z * t_post));
      }
      if (bowGroupRef.current) {
        bowGroupRef.current.position.x = vib;
        bowGroupRef.current.rotation.y = theta_z_render;
      }
      if (stringMeshRef.current) {
        stringMeshRef.current.position.x = vib;
        stringMeshRef.current.rotation.y = theta_z_render;
      }

      // 모달 화살 형상
      const arrowShape = computeModalArrowShape(p2, rd.arrowProps, t_post);
      renderLumpedArrow(arrowShape.nodes, shaftR);
      if (flyingArrowRef.current) flyingArrowRef.current.visible = false;

      // CoM 마커 (Phase 2: 탄도 위치)
      if (sceneRef.current) {
        if (comMarkerRef.current) sceneRef.current.remove(comMarkerRef.current);
        const sg = new THREE.SphereGeometry(0.006, 12, 12);
        const sm = new THREE.MeshBasicMaterial({ color: 0x00ff88 });
        const sp = new THREE.Mesh(sg, sm);
        sp.position.set(arrowShape.cx, arrowShape.cy, arrowShape.cz || 0);
        sceneRef.current.add(sp);
        comMarkerRef.current = sp;
      }
    }
  }, [jogMode, jogTime, renderLumpedArrow]);

  // 조그셔틀 자동재생: forward(발시→분리) → rewind(분리→발시직전) → stop
  useEffect(() => {
    if (!jogMode) return;
    const ap = jogAutoPlayRef.current;
    if (ap.phase === 'idle') return;

    const rd = jogDataRef.current?.releaseData;
    if (!rd) return;
    const t_sep = rd.phase2Data.t_separation;
    const endTime = t_sep + 200; // 분리 후 200ms — 잔신 z축 회전 표시

    const interval = setInterval(() => {
      const ap = jogAutoPlayRef.current;
      if (ap.phase === 'forward') {
        setJogTime(t => {
          const next = +(t + 2).toFixed(2); // 2ms/frame — 잔신 200ms 구간을 ~6초에 재생
          if (next >= endTime) {
            // forward 끝 → 잠시 멈춤 후 rewind
            setTimeout(() => { jogAutoPlayRef.current.phase = 'rewind'; }, 500);
            jogAutoPlayRef.current.phase = 'pause';
            return endTime;
          }
          return next;
        });
      } else if (ap.phase === 'rewind') {
        setJogTime(t => {
          const next = +(t - 5).toFixed(2); // 되감기: 빠르게
          if (next <= 0) {
            jogAutoPlayRef.current.phase = 'idle'; // 자동재생 종료
            return 0;
          }
          return next;
        });
      }
      // 'pause', 'idle'이면 아무것도 안함
    }, 1000 / 60); // 60fps

    return () => clearInterval(interval);
  }, [jogMode, jogTime]);

  // 조그셔틀 종료
  const exitJogMode = useCallback(() => {
    setJogMode(false);
    jogDataRef.current = null;
    isArrowFlyingRef.current = false;
    if (bowGroupRef.current) { bowGroupRef.current.position.x = 0; bowGroupRef.current.rotation.y = 0; }
    if (stringMeshRef.current) { stringMeshRef.current.position.x = 0; stringMeshRef.current.rotation.y = 0; stringMeshRef.current.visible = true; }
    if (jogStringRef.current && sceneRef.current) {
      jogStringRef.current.traverse(c => { if (c.geometry) c.geometry.dispose(); if (c.material) c.material.dispose(); });
      sceneRef.current.remove(jogStringRef.current);
      jogStringRef.current = null;
    }
    if (flyingArrowRef.current && sceneRef.current) {
      flyingArrowRef.current.traverse(c => {
        if (c.geometry) c.geometry.dispose();
        if (c.material) c.material.dispose();
      });
      sceneRef.current.remove(flyingArrowRef.current);
      flyingArrowRef.current = null;
    }
    if (lumpedArrowRef.current && sceneRef.current) {
      lumpedArrowRef.current.traverse(c => {
        if (c.geometry) c.geometry.dispose();
        if (c.material) c.material.dispose();
      });
      sceneRef.current.remove(lumpedArrowRef.current);
      lumpedArrowRef.current = null;
    }
  }, []);

  const startAnimation = () => {
    window.__DEBUG_START_ANIM = Date.now();
    // 조그 모드 종료
    if (jogMode) exitJogMode();
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
    if (bowGroupRef.current) { bowGroupRef.current.position.x = 0; bowGroupRef.current.rotation.y = 0; }
    if (stringMeshRef.current) { stringMeshRef.current.position.x = 0; stringMeshRef.current.rotation.y = 0; }

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
            <div style={{ borderTop: "1px solid #444466", marginTop: 4, paddingTop: 4 }}>
              <div>저장 에너지: <b style={{ color: "#ffdd88" }}>{energyData.E_stored.toFixed(1)} J</b></div>
              <div>화살 속도: <b style={{ color: "#88ffcc" }}>{energyData.v_arrow.toFixed(1)} m/s</b></div>
              <div>화살 에너지: <b style={{ color: "#88ffcc" }}>{energyData.KE_arrow.toFixed(1)} J</b> ({(energyData.eta * 100).toFixed(0)}%)</div>
            </div>

            {/* 결과 물리량 — 조그셔틀 진입 시 표시 */}
            {jogMode && jogDataRef.current && jogDataRef.current.releaseData && (() => {
              const rd = jogDataRef.current.releaseData;
              const p2 = rd.phase2Data;
              const cm = p2.CoM;
              const speed = Math.sqrt(cm.vx*cm.vx + cm.vy*cm.vy + (cm.vz||0)*(cm.vz||0));
              // 발사 방향 = -x. 발사각은 발사축 기준 편각으로 표시
              // angleXY: 양(+)=위, 음(-)=아래
              const angleXY = Math.atan2(-cm.vy, -cm.vx) * 180 / Math.PI;
              // angleZ: 양(+)=궁사 왼쪽(+z), 음(-)=궁사 오른쪽(-z)
              const angleZ = Math.atan2(-(cm.vz || 0), -cm.vx) * 180 / Math.PI;
              // 화살 축 기울기: 발사 방향 기준 (180° 보정)
              const axisAng = ((p2.axisAngle || 0) * 180 / Math.PI) + 180;
              const A1y = p2.modalAmps && p2.modalAmps[0] ? p2.modalAmps[0].A * 1000 : 0;
              const A1z = p2.modalAmpsZ && p2.modalAmpsZ[0] ? p2.modalAmpsZ[0].A * 1000 : 0;
              const eta = p2.energyAudit ? p2.energyAudit.eta : 0;
              const thetaZ0 = (p2.theta_z0 || 0) * 180 / Math.PI;
              const zRotFinal = p2.zRotFrames && p2.zRotFrames.length > 0
                ? p2.zRotFrames[p2.zRotFrames.length - 1].theta_z * 180 / Math.PI : 0;
              const zArrowM = -((params.limbWidth || 0.028) / 2 + 0.003);
              const zArrow_mm = zArrowM * 1000;
              // 만작 z각도: nock(z=z_arrow)에서 rest(z≈0)까지의 기울기
              // nock-rest x거리 = nockX (만작)
              const f0 = rd.phase1Frames[0];
              const nockX_fullDraw = f0 ? f0.nodes[0].x : (params.maxDraw || 0.75);
              const restX = 0; // rest는 x≈0
              const dx_nr = restX - nockX_fullDraw; // 음수 (과녁 방향)
              const dz_nr = 0 - zArrowM; // rest(z≈0) - nock(z=z_arrow), 양수
              const arrowZAngle_deg = Math.atan2(dz_nr, -dx_nr) * 180 / Math.PI; // 발사방향(-x) 기준
              return (
                <div style={{ borderTop: "1px solid #555588", marginTop: 6, paddingTop: 6 }}>
                  <div style={{ fontWeight: 700, marginBottom: 4, color: "#ccaadd" }}>결과 물리량</div>
                  <div style={{ fontSize: 11, lineHeight: 1.5 }}>
                    <div style={{ color: "#999", marginBottom: 2 }}>--- 만작 ---</div>
                    <div>화살 z오프셋: <b style={{ color: "#ddaaff" }}>{zArrow_mm.toFixed(1)} mm</b></div>
                    <div>화살 z각도: <b style={{ color: "#ddaaff" }}>{arrowZAngle_deg.toFixed(2)}°</b></div>
                    <div style={{ color: "#999", marginTop: 4, marginBottom: 2 }}>--- 분리 직후 ---</div>
                    <div>분리 시간: <b style={{ color: "#ffaa66" }}>{p2.t_separation.toFixed(2)} ms</b></div>
                    <div>CoM 속도: <b style={{ color: "#88ffcc" }}>vx={cm.vx.toFixed(1)}</b> vy={cm.vy.toFixed(2)} vz={(cm.vz||0).toFixed(2)} m/s</div>
                    <div>CoM 위치: <b style={{ color: "#88ddaa" }}>x={((cm.x||0)*100).toFixed(1)}</b> y={((cm.y||0)*100).toFixed(1)} z={((cm.z||0)*1000).toFixed(1)}mm</div>
                    <div>화살 속력: <b style={{ color: "#88ffcc" }}>{speed.toFixed(1)} m/s</b></div>
                    <div>발사각(x-y): <b style={{ color: "#ffaaff" }}>{angleXY.toFixed(2)}°</b></div>
                    <div>발사각(z): <b style={{ color: "#ddaaff" }}>{angleZ.toFixed(3)}°</b></div>
                    <div>화살축 기울기: <b style={{ color: "#aaddff" }}>{axisAng.toFixed(2)}°</b></div>
                    <div style={{ color: "#999", marginTop: 4, marginBottom: 2 }}>--- 에너지/진동 ---</div>
                    <div>효율 (Klopsteg): <b style={{ color: "#ffdd88" }}>{(eta * 100).toFixed(1)}%</b></div>
                    <div>paradox A1y: <b style={{ color: "#ff8888" }}>{A1y.toFixed(1)} mm</b></div>
                    <div>paradox A1z: <b style={{ color: "#ff88cc" }}>{A1z.toFixed(1)} mm</b></div>
                    <div style={{ color: "#999", marginTop: 4, marginBottom: 2 }}>--- 잔신 ---</div>
                    <div>활 z회전(분리): <b style={{ color: "#ccddff" }}>{thetaZ0.toFixed(2)}°</b></div>
                    <div>활 z회전(최종): <b style={{ color: "#ccddff" }}>{zRotFinal.toFixed(1)}°</b></div>
                  </div>
                </div>
              );
            })()}
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
              {animPhase === "drawing" ? "당기는 중..." : animPhase === "computing" ? "시뮬레이션 계산 중..." : "처리 중..."}
            </div>
          )}

          {/* 조그셔틀: 0.01ms / 0.1ms / 10ms 3단 탐색 */}
          {jogMode && (() => {
            const rd = jogDataRef.current && jogDataRef.current.releaseData;
            const t_sep = rd ? rd.phase2Data.t_separation : 30;
            const lastT = rd && rd.phase1Frames.length > 0
              ? rd.phase1Frames[rd.phase1Frames.length - 1].t_ms : 30;
            const isPhase1 = jogTime <= lastT;

            // 현재 프레임 정보
            let info = "";
            let infoColor = "#888";
            if (rd && isPhase1) {
              let fi = 0;
              for (let i = 1; i < rd.phase1Frames.length; i++) {
                if (rd.phase1Frames[i].t_ms > jogTime) break;
                fi = i;
              }
              const fr = rd.phase1Frames[fi];
              const status = fr.recontactError ? "재접촉!" :
                fr.onString ? "시위 접촉" : "이탈";
              const contact = fr.contactState === 'contact' ? " rest●" : " rest○";
              info = `${status}${contact}`;
              infoColor = fr.recontactError ? "#ff4444" :
                fr.onString ? "#ff8844" : "#44ff88";
            } else {
              info = "자유 비행";
              infoColor = "#88bbff";
            }

            const btnStyle = (bg) => ({
              background: bg || "#333366", color: "#ccc", border: "1px solid #666",
              borderRadius: 4, padding: "4px 7px", cursor: "pointer",
              fontSize: 11, fontFamily: "monospace"
            });

            return (
              <div style={{
                position: "absolute", bottom: 70, left: "50%", transform: "translateX(-50%)",
                background: "rgba(10,10,40,0.95)", borderRadius: 10, padding: "8px 12px",
                border: "1px solid #555599", display: "flex", flexDirection: "column", alignItems: "center", gap: 6,
                fontFamily: "monospace", fontSize: 12, userSelect: "none", whiteSpace: "nowrap"
              }} onPointerDown={e => e.stopPropagation()} onPointerMove={e => e.stopPropagation()} onPointerUp={e => e.stopPropagation()}>
                {/* 드래그 슬라이드 휠 */}
                <div
                  style={{
                    width: "100%", height: 28, background: "linear-gradient(90deg, #1a1a44 0%, #2a2a66 50%, #1a1a44 100%)",
                    borderRadius: 14, cursor: "ew-resize", position: "relative", overflow: "hidden",
                    border: "1px solid #444488", touchAction: "none"
                  }}
                  onPointerDown={e => {
                    e.stopPropagation();
                    e.currentTarget.setPointerCapture(e.pointerId);
                    jogDragRef.current = { dragging: true, startX: e.clientX, startTime: jogTime, accum: 0 };
                  }}
                  onPointerMove={e => {
                    e.stopPropagation();
                    const d = jogDragRef.current;
                    if (!d.dragging) return;
                    const dx = e.clientX - d.startX;
                    const pixPerStep = 12;
                    const steps = Math.trunc(dx / pixPerStep);
                    const newAccum = steps;
                    if (newAccum !== d.accum) {
                      const delta = (newAccum - d.accum) * jogStep;
                      setJogTime(t => {
                        const next = +(t + delta).toFixed(4);
                        return Math.max(0, Math.min(2000, +next.toFixed(2)));
                      });
                      d.accum = newAccum;
                    }
                  }}
                  onPointerUp={e => { jogDragRef.current.dragging = false; }}
                  onPointerCancel={e => { jogDragRef.current.dragging = false; }}
                >
                  {/* 중앙 표시선 + 눈금 패턴 */}
                  <div style={{ position: "absolute", top: 0, bottom: 0, left: "50%", width: 2, background: "#ffdd66", transform: "translateX(-50%)" }} />
                  {Array.from({ length: 21 }, (_, i) => (
                    <div key={i} style={{
                      position: "absolute", top: i % 5 === 0 ? 4 : 8, bottom: i % 5 === 0 ? 4 : 8,
                      left: `${(i / 20) * 100}%`, width: 1, background: "rgba(136,136,255,0.3)"
                    }} />
                  ))}
                  <div style={{
                    position: "absolute", top: 2, right: 6, fontSize: 9, color: "#8888cc", pointerEvents: "none"
                  }}>◁ {jogStep}ms/칸 ▷</div>
                </div>
                {/* 버튼 행 */}
                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <button onClick={() => { setJogStep(10); setJogTime(t => Math.max(0, t - 10)); }} style={btnStyle(jogStep === 10 ? "#445588" : undefined)}>
                    -10
                  </button>
                  <button onClick={() => { setJogStep(1); setJogTime(t => Math.max(0, +(t - 1).toFixed(2))); }} style={btnStyle(jogStep === 1 ? "#445588" : undefined)}>
                    -1
                  </button>
                  <button onClick={() => { setJogStep(0.1); setJogTime(t => Math.max(0, +(t - 0.1).toFixed(2))); }} style={btnStyle(jogStep === 0.1 ? "#445588" : undefined)}>
                    -0.1
                  </button>
                  <div style={{
                    minWidth: 80, textAlign: "center", color: "#ffdd66", fontWeight: 700, fontSize: 14
                  }}>
                    {jogTime.toFixed(2)}
                  </div>
                  <span style={{ color: "#888", fontSize: 11 }}>ms</span>
                  <button onClick={() => { setJogStep(0.1); setJogTime(t => Math.min(2000, +(t + 0.1).toFixed(2))); }} style={btnStyle(jogStep === 0.1 ? "#445588" : undefined)}>
                    +0.1
                  </button>
                  <button onClick={() => { setJogStep(1); setJogTime(t => Math.min(2000, +(t + 1).toFixed(2))); }} style={btnStyle(jogStep === 1 ? "#445588" : undefined)}>
                    +1
                  </button>
                  <button onClick={() => { setJogStep(10); setJogTime(t => Math.min(2000, t + 10)); }} style={btnStyle(jogStep === 10 ? "#445588" : undefined)}>
                    +10
                  </button>
                  <div style={{ marginLeft: 8, fontSize: 11, color: infoColor, minWidth: 80 }}>
                    {info}
                  </div>
                  {/* 실시간 CoM 상태 */}
                  {rd && isPhase1 && (() => {
                    let fi = 0;
                    for (let i = 1; i < rd.phase1Frames.length; i++) {
                      if (rd.phase1Frames[i].t_ms > jogTime) break;
                      fi = i;
                    }
                    const fr = rd.phase1Frames[fi];
                    if (!fr.CoM) return null;
                    const c = fr.CoM;
                    const spd = Math.sqrt(c.vx*c.vx+c.vy*c.vy+c.vz*c.vz);
                    return (
                      <div style={{ marginLeft: 4, fontSize: 10, color: "#88ddaa" }}>
                        CoM v={spd.toFixed(1)} vy={c.vy.toFixed(2)}
                      </div>
                    );
                  })()}
                  <button onClick={exitJogMode} style={btnStyle("#662222")}>
                    ✕
                  </button>
                </div>
              </div>
            );
          })()}
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
              { key: "maxDraw", label: "만작 거리", unit: "cm", min: 60, max: 85, step: 1, scale: 100 },
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
              { key: "gripAngle", label: "줌통 V각도", unit: "°", min: 3, max: 15, step: 1, scale: 1 },
              { key: "gripStiffnessRatio", label: "줌통 강성비", unit: "×", min: 5, max: 50, step: 1, scale: 1 },
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
              { key: "elasticModulus", label: "탄성계수", unit: "GPa", min: 10, max: 45, step: 1, toVal: v => v / 1e9, fromVal: v => v * 1e9 },
              { key: "limbWidth", label: "활채 폭", unit: "mm", min: 20, max: 40, step: 1, toVal: v => v * 1000, fromVal: v => v / 1000 },
              { key: "limbThickness", label: "활채 두께", unit: "mm", min: 5, max: 12, step: 0.5, toVal: v => v * 1000, fromVal: v => v / 1000 },
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

          {/* 사법 설정 (줌손 z축 토크) */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontWeight: 700, marginBottom: 8, color: "#cc88cc", borderBottom: "1px solid #333", paddingBottom: 4 }}>
              사법 (射法)
            </div>
            {[
              { key: "gripTwistTorque", label: "줌손 비틀기 토크", unit: "N·m", min: 0, max: 1.0, step: 0.05, toVal: v => v, fromVal: v => v },
              { key: "gripTwistDamping", label: "비틀기 감쇠비", unit: "", min: 0.01, max: 0.30, step: 0.01, toVal: v => v, fromVal: v => v },
              { key: "thumbReleaseForce", label: "엄지 이탈 횡력", unit: "N", min: 0, max: 20, step: 0.5, toVal: v => v, fromVal: v => v },
            ].map(({ key, label, unit, min, max, step, toVal, fromVal }) => (
              <div key={key} style={{ marginBottom: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 2 }}>
                  <span>{label}</span>
                  <span style={{ color: "#ff88cc" }}>{toVal(params[key] || 0).toFixed(2)} {unit}</span>
                </div>
                <input type="range" min={min} max={max} step={step}
                  value={toVal(params[key] || 0)}
                  onChange={e => updateParam(key, fromVal(parseFloat(e.target.value)))}
                  style={{ width: "100%", accentColor: "#cc44aa" }} />
              </div>
            ))}
          </div>

          {/* 화살 설정 */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontWeight: 700, marginBottom: 8, color: "#aaaacc", borderBottom: "1px solid #333", paddingBottom: 4 }}>
              화살 설정
            </div>
            {[
              { key: "arrowSpine", label: "Spine", unit: "", min: 300, max: 1200, step: 50, toVal: v => v, fromVal: v => v },
              { key: "arrowMass", label: "총 질량", unit: "g", min: 20, max: 35, step: 0.5, toVal: v => v * 1000, fromVal: v => v / 1000 },
              { key: "arrowTipMass", label: "촉 질량", unit: "g", min: 3, max: 15, step: 0.5, toVal: v => v * 1000, fromVal: v => v / 1000 },
              { key: "arrowLength", label: "화살 길이", unit: "cm", min: 70, max: 90, step: 1, toVal: v => v * 100, fromVal: v => v / 100 },
            ].map(({ key, label, unit, min, max, step, toVal, fromVal }) => (
              <div key={key} style={{ marginBottom: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 2 }}>
                  <span>{label}</span>
                  <span style={{ color: "#ffcc44" }}>{toVal(params[key] || 0).toFixed(key === "arrowSpine" ? 0 : 1)} {unit}</span>
                </div>
                <input type="range" min={min} max={max} step={step}
                  value={toVal(params[key] || 0)}
                  onChange={e => updateParam(key, fromVal(parseFloat(e.target.value)))}
                  style={{ width: "100%", accentColor: "#cc8844" }} />
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
            {bowGeomData && bowGeomData.arrowProps && (() => {
              const ap = bowGeomData.arrowProps;
              const sv = verifyArrowSpine(ap);
              const as_ = bowGeomData.arrowShape;
              const m_arr = ap.m_total;
              const eta = 0.82;
              const E_st = bowGeomData.F_draw ? (bowGeomData.F_draw * bowGeomData.nockX / 2) : 0;
              return (
                <div style={{ borderTop: "1px solid #333", marginTop: 6, paddingTop: 6 }}>
                  <div style={{ color: "#aaaacc", fontWeight: 600, marginBottom: 4 }}>화살 물리</div>
                  <div style={{ lineHeight: 2 }}>
                    <div>Spine: <b>{ap.spine}</b> → EI: <b>{ap.EI.toFixed(2)} N·m²</b></div>
                    <div>검증: <b>{sv.spineComputed}</b> {Math.abs(sv.spineComputed - ap.spine) < 1 ? "✓" : "✗"}</div>
                    <div>선밀도: <b>{(ap.rho_linear * 1000).toFixed(1)} g/m</b></div>
                    {as_ && as_.restContact && <div>화살걸이 반력: <b>{as_.restForce.toFixed(2)} N</b></div>}
                    {as_ && <div>촉 처짐: <b>{((as_.tipPos.y - (bowGeomData.nockingPoint || {y:0}).y) * 1000).toFixed(1)} mm</b></div>}
                  </div>
                </div>
              );
            })()}
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
