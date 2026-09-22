// 루틴 화면 — 책갈피 탭 '루틴' 으로 연 상태.
(() => {
  document.getElementById('tab-routine').click();
  const t = document.querySelector('.cmp .scr-titlein');
  t.value = '저녁 산책';
  const rt = document.querySelector('.cmp-rtime');
  rt.value = '19:30';
  rt.dispatchEvent(new Event('change', { bubbles: true }));
  document.activeElement?.blur();
  return t.value;
})()
