// 계획 — 책갈피 '계획' 의 주간. 달력에는 지금 짜는 주가 금박 테두리로 보인다.
(() => {
  document.getElementById('tab-plan').click();
  return new Promise((r) => requestAnimationFrame(() => r(document.querySelectorAll('.pln-goal').length)));
})()
