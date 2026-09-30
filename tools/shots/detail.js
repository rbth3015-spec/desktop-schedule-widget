// 항목 상세 — 시간표의 줄을 눌러 뜬 자세한 창에서 '자세히' 로 들어간 상태.
// 화면이 다음 틀에서 그려지므로 한 박자 기다렸다 돌려준다(안 기다리면 제목 · 날짜가 빈 채로 찍혔다).
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const line = [...document.querySelectorAll('.tt-strip__item')]
    .find((x) => x.textContent.includes('아침 스탠드업'));
  if (!line) return '대상 없음';
  line.click();
  await sleep(200);
  document.querySelector('.tt-peek__act--more').click();
  await sleep(400);
  document.activeElement?.blur();
  await sleep(200);
  return line.textContent;
})()
