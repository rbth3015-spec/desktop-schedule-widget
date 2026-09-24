// 계획 — 월간. 이 달의 목표와 주마다 잡힌 목표.
(() => {
  document.getElementById('tab-plan').click();
  [...document.querySelectorAll('.pln-view')].find((b) => b.textContent === '월간').click();
  return new Promise((r) => requestAnimationFrame(() => r(document.querySelectorAll('.pln-week').length)));
})()
