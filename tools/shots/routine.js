// 루틴 — '＋ 일정 추가' 로 연 화면에서 머리의 '루틴' 을 누른 상태.
(() => {
  document.querySelector('.todo-head__btn--gold').click();
  [...document.querySelectorAll('.cmp-mode')].find((b) => b.textContent === '루틴').click();
  const t = document.querySelector('.cmp .scr-titlein');
  t.value = '저녁 산책';
  const rt = document.querySelector('.cmp-rtime');
  rt.value = '19:30';
  rt.dispatchEvent(new Event('change', { bubbles: true }));
  document.activeElement?.blur();
  return t.value;
})()
