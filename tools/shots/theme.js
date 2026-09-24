// 테마 — 달력 발치의 띠에서 하나를 켠 상태. 그 테마만 지면에 남는다.
(() => {
  const b = [...document.querySelectorAll('.cal-theme')].find((x) => x.dataset.tag === '업무');
  b?.click();
  return b ? b.dataset.tag : '없음';
})()
