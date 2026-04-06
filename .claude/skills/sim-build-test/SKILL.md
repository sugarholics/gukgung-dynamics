---
name: sim-build-test
description: "빌드-테스트-디버그 자동화 스킬. JSX 코드 수정 후 HTML 빌드, 브라우저 테스트, 시각적 검증까지의 전체 사이클을 자동화한다. '빌드해줘', '테스트해봐', '브라우저에서 확인', '화면 캡처', '디버그', '값 확인' 등의 요청 시 사용. 코드를 수정한 후 결과를 확인해야 하는 모든 상황에서 이 스킬을 사용할 것."
---

# 시뮬레이터 빌드-테스트-디버그 스킬

## 빌드
```bash
node build_html.js   # → index.html (~185KB)
```

## 브라우저 로드 (캐시 우회 필수)
```
http://localhost:8083/index.html?v={timestamp}
```

## 발시 테스트 (권장 방법)

### 즉시 조그셔틀 진입:
```javascript
window.__enterJogMode(DEFAULT_PARAMS)  // ~500ms 계산 + 렌더
```

### 시간 이동:
```javascript
window.__setJogTime(10)  // 10ms로 이동
```

### 파라미터 스윕 (48조합):
```javascript
window.__paramSweep()  // nockOffset × restOffset 결과 테이블
```

## 디버그 — console.log 금지, 전역변수 사용

```javascript
window.__DEBUG_RELEASE                    // simulateRelease 전체 결과
window.__DEBUG_RELEASE.phase2Data.CoM     // CoM 속도/위치
window.__DEBUG_RELEASE.phase2Data.energyAudit  // 에너지 감사
window.__DEBUG_RELEASE.phase1Frames[0].CoM     // Phase 1 CoM
window.__DEBUG_RELEASE.phase1Frames[0].stringForce  // 시위력
```

## 슬라이더 조작 (React state 연동)
```javascript
const slider = document.querySelectorAll('input[type="range"]')[15]; // 오니 오프셋
const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
nativeSetter.call(slider, 0);
slider.dispatchEvent(new Event('input', { bubbles: true }));
```

## 검증 기준 (2026-04-07)

| 항목 | 정상 값 |
|------|--------|
| vx | -42.70 m/s |
| vy (nock50mm) | -2.80 m/s |
| η | 40.2% |
| t_sep | 19.07 ms |
| nock=0 → vy | -0.18 m/s (중력) |

## 전형적 테스트 시퀀스
```
Edit JSX → node build_html.js → navigate(?v=N) → wait(10s) →
__enterJogMode(DEFAULT_PARAMS) → wait(2s) → __setJogTime(10) → screenshot
```
