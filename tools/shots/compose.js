// 일정 추가 폼을 열고 시각까지 채운 상태. capture.js --exec 로 쓴다.
(() => {
  document.querySelector('.todo-add').click();
  const rows = document.querySelectorAll('.cmp-when__row');
  const fire = (el, v) => { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); };
  document.querySelector('.cmp-title').value = '분기 리뷰 미팅';
  fire(rows[0].querySelector('.cmp-time'), '15:00');
  fire(rows[1].querySelector('.cmp-time'), '16:30');
  // 요약 줄('… · 15:00–16:30')이 화면에 들어오도록
  document.querySelector('.cmp-when__summary').scrollIntoView({ block: 'center' });
  return document.querySelector('.cmp-when__summary').textContent;
})()
