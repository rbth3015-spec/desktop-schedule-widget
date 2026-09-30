// 할 일 — 책갈피 '할 일'. 사흘째 이어진 것 · 시간을 잡아 묶인 것 · 오늘 지운 것 · 어제 한 일.
(() => {
  document.getElementById('tab-todos').click();
  // 비어 있지 않으면 적는 줄에 커서를 두지 않는다 — 그대로 둔 모습을 찍는다
  document.activeElement?.blur?.();
  return new Promise((r) => requestAnimationFrame(() => r(document.querySelectorAll('.tds-item').length)));
})()
