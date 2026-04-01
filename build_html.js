// 빌드 스크립트: 국궁_3d_모델.jsx → index.html
// JSX를 Babel in-browser 트랜스파일 방식의 HTML로 변환
const fs = require('fs');
const path = require('path');

const jsxPath = path.join(__dirname, '국궁_3d_모델.jsx');
const outPath = path.join(__dirname, 'index.html');

let jsx = fs.readFileSync(jsxPath, 'utf-8');

// 1. import문 제거
jsx = jsx.replace(/^import\s+.*?;\s*$/gm, '');

// 2. export default 제거
jsx = jsx.replace(/^export\s+default\s+/gm, '');

// 3. React hooks를 전역에서 가져오기 (CDN UMD 방식)
const hookLine = 'const { useState, useRef, useEffect, useCallback, useMemo } = React;';

// 4. ReactDOM.render 추가
const renderLine = `
ReactDOM.render(
  React.createElement(KoreanBow3D),
  document.getElementById('root')
);
`;

// 5. HTML 템플릿
const html = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>국궁 3D 동역학 시뮬레이터</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body, #root { width: 100%; height: 100%; overflow: hidden; }
</style>
</head>
<body>
<div id="root"></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
<script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
<script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
<script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
<script type="text/babel">
${hookLine}

${jsx}

${renderLine}
</script>
</body>
</html>`;

fs.writeFileSync(outPath, html, 'utf-8');
const size = fs.statSync(outPath).size;
console.log(`Built: ${outPath} (${(size / 1024).toFixed(1)} KB)`);
