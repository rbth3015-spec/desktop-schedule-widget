// 항목 상세 — 시간표의 네모를 눌러 뜬 자세한 창에서 '자세히 · 고치기' 로 들어간 상태.
(() => {
  const line = [...document.querySelectorAll('.tt-strip__item')]
    .find((x) => x.textContent.includes('아침 스탠드업'));
  if (!line) return '대상 없음';
  line.click();
  document.querySelector('.tt-peek__act--more').click();
  document.activeElement?.blur();
  return line.textContent;
})()
