---
name: sim-build-test
description: "빌드-테스트-디버그 자동화 스킬. JSX 코드 수정 후 HTML 빌드, 브라우저 테스트, 시각적 검증까지의 전체 사이클을 자동화한다. '빌드해줘', '테스트해봐', '브라우저에서 확인', '화면 캡처', '디버그', '값 확인' 등의 요청 시 사용. 코드를 수정한 후 결과를 확인해야 하는 모든 상황에서 이 스킬을 사용할 것."
---

# 시뮬레이터 빌드-테스트-디버그 스킬

## 왜 이 스킬이 필요한가

이 프로젝트의 빌드-테스트 사이클은 매번 동일한 패턴을 따르지만, 실수하기 쉬운 함정이 여럿 있다:
- 브라우저 캐시로 인해 구버전이 표시됨
- React 스코프 내 console.log가 Chrome 도구로 캡처되지 않음
- form_input으로 슬라이더 변경 시 React state가 연동되지 않는 경우가 있음

이 스킬은 검증된 패턴만 사용하도록 안내한다.

## 빌드 프로세스

### 1단계: 빌드
```bash
node /sessions/festive-trusting-goodall/build_html.js
```
결과: `mnt/국궁 동역학/index.html` 생성 (~80KB)

### 2단계: 브라우저 로드 (캐시 우회 필수)
```
http://localhost:8080/index.html?v={timestamp}
```
**절대 규칙**: 빌드할 때마다 URL의 `?v=` 파라미터를 변경할 것. 동일 URL 재방문은 캐시된 구버전을 표시할 수 있다.

### 3단계: 슬라이더 조작
브라우저에서 당김 비율 등을 변경할 때:
```
1. find tool로 슬라이더 찾기
2. form_input으로 값 설정
3. 1초 대기 (React re-render 시간)
4. screenshot으로 확인
```

주의: `form_input`이 React state를 업데이트하지 못하는 경우가 있다. 이때는 JavaScript로 네이티브 setter를 사용:
```javascript
const slider = document.querySelector('input[type="range"]');
const nativeSetter = Object.getOwnPropertyDescriptor(
  window.HTMLInputElement.prototype, 'value').set;
nativeSetter.call(slider, 0.5);
slider.dispatchEvent(new Event('input', { bubbles: true }));
```

### 4단계: 디버그 값 확인

**console.log는 사용하지 말 것.** Babel 트랜스파일 + React 스코프 문제로 Chrome 콘솔 도구에 캡처되지 않는다.

대신 `window.__DEBUG_*` 전역변수 패턴 사용:
```javascript
// JSX 코드 안에서:
window.__DEBUG_ARROW = { rp: [rp.x, rp.y], np: [np.x, np.y], ux, uy };

// 브라우저에서 JavaScript tool로 읽기:
JSON.stringify(window.__DEBUG_ARROW)
```

또는 DOM 오버레이 패턴 (화면에 직접 표시):
```javascript
let dbg = document.getElementById('my-debug');
if (!dbg) {
  dbg = document.createElement('div');
  dbg.id = 'my-debug';
  dbg.style.cssText = 'position:fixed;top:5px;left:200px;color:lime;' +
    'font:11px monospace;z-index:99999;background:rgba(0,0,0,0.9);padding:4px';
  document.body.appendChild(dbg);
}
dbg.textContent = `값: ${myValue.toFixed(3)}`;
```

**디버그 코드는 확인 후 반드시 제거할 것.**

## 전형적인 빌드-테스트 시퀀스

```
Edit JSX → build_html.js → navigate(?v=N) → wait(2s) → find slider → form_input → wait(1s) → screenshot → [필요시 zoom/javascript_tool]
```

## 발시 시뮬레이션 테스트

1. 페이지 로드 후 "발시 시뮬레이션" 버튼 클릭
2. 4초 대기 (drawing → holding → releasing → vibration 전체 사이클)
3. 스크린샷으로 최종 상태 확인
4. 애니메이션 중간 캡처가 필요하면 wait(1.5s) 후 스크린샷
