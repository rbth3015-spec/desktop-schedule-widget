// 항목 상세를 펼친 상태 — 추가 폼과 같은 시작/종료 배치를 보여 준다.
(() => {
  const items = [...document.querySelectorAll('.todo-item')];
  const t = items.find((li) => li.querySelector('.todo-title').textContent.includes('아침 스탠드업'));
  if (!t) return '대상 없음';
  t.querySelector('.todo-item__row').click();
  t.scrollIntoView({ block: 'start' });
  return t.querySelector('.todo-title').textContent;
})()
