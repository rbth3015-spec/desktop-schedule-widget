// 일정 추가 화면 — 한 줄 문법이 칩으로 옮겨 간 상태. capture.js --exec 로 쓴다.
(() => {
  document.querySelector('.todo-head__btn--gold').click();
  const t = document.querySelector('.cmp .scr-titlein');
  t.value = '분기 리뷰 미팅 @내일 #업무 ';
  t.dispatchEvent(new Event('input', { bubbles: true }));
  const times = document.querySelectorAll('.cmp .scr-time');
  const fire = (el, v) => { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); };
  fire(times[0], '15:00');
  fire(times[1], '16:30');
  document.activeElement?.blur();
  return document.querySelector('.cmp-len__summary').textContent;
})()
