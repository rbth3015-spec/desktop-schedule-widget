// 돌아보기 — 계획 주간 맨 아래. 그 주의 한 줄들 위에 한 문단.
(() => {
  document.getElementById('tab-plan').click();
  return new Promise((r) => setTimeout(() => {
    const panel = document.querySelector('.todo-panel');
    panel.scrollTop = panel.scrollHeight;
    setTimeout(() => r(document.querySelectorAll('.pln-retro__row').length), 120);
  }, 220));
})()
