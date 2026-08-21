// 우클릭 컨텍스트 메뉴.
//
// Electron 의 네이티브 Menu 를 쓰면 OS 기본 테마로 떠서 위젯 톤과 완전히 따로 논다.
// 지면과 같은 종이/잉크로 그리기 위해 DOM 으로 직접 만든다.

let openMenu = null;

/**
 * @typedef {Object} MenuItem
 * @property {string}  [label]     생략하고 separator:true 면 구분선
 * @property {boolean} [separator]
 * @property {boolean} [danger]    삭제처럼 되돌리기 어려운 항목
 * @property {boolean} [checked]
 * @property {boolean} [disabled]
 * @property {() => void} [onSelect]
 */

/**
 * 화면 좌표에 메뉴를 띄운다. 이미 열려 있으면 닫고 새로 연다.
 * @param {number} x
 * @param {number} y
 * @param {MenuItem[]} items
 */
export function showContextMenu(x, y, items) {
  closeContextMenu();

  const el = document.createElement('div');
  el.className = 'ctx';

  for (const item of items) {
    if (item.separator) {
      el.append(document.createElement('hr'));
      continue;
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ctx__item';
    if (item.danger) b.classList.add('ctx__item--danger');
    if (item.checked) b.classList.add('is-on');
    b.disabled = !!item.disabled;
    b.textContent = item.label ?? '';
    b.addEventListener('click', () => {
      closeContextMenu();
      item.onSelect?.();
    });
    el.append(b);
  }

  document.body.append(el);

  // 화면 밖으로 나가지 않게 보정한다 (위젯이 작을 때 오른쪽 아래에서 자주 발생)
  const pad = 8;
  const r = el.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - r.width - pad);
  const top = Math.min(y, window.innerHeight - r.height - pad);
  el.style.left = `${Math.max(pad, left)}px`;
  el.style.top = `${Math.max(pad, top)}px`;

  openMenu = el;

  // 다음 틱부터 바깥 클릭을 받는다 (지금 클릭이 바로 닫아 버리지 않도록)
  setTimeout(() => {
    document.addEventListener('mousedown', onDocDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', closeContextMenu);
  }, 0);
}

function onDocDown(e) {
  if (openMenu && !openMenu.contains(e.target)) closeContextMenu();
}

function onKey(e) {
  if (e.key === 'Escape') {
    e.stopPropagation();
    closeContextMenu();
  }
}

export function closeContextMenu() {
  if (!openMenu) return;
  openMenu.remove();
  openMenu = null;
  document.removeEventListener('mousedown', onDocDown, true);
  document.removeEventListener('keydown', onKey, true);
  window.removeEventListener('blur', closeContextMenu);
}
