// 얇은 선(hairline) 아이콘. 이모지는 OS/폰트마다 모양과 색이 제각각이라
// 차분한 다이어리 톤을 유지할 수 없어 전부 인라인 SVG 로 그린다.
//
// 모든 아이콘은 24x24 뷰박스, currentColor 스트로크. 굵기는 --icon-stroke 로 조절한다.

const NS = 'http://www.w3.org/2000/svg';

/** name -> path d 목록 (또는 {d, fill} 형태) */
const PATHS = {
  // 셸
  settings: [
    'M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z',
    'M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 8.9 19.3a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.7 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9.1a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.08a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1.03Z',
  ],
  pin: ['M9 4h6', 'M10 4v6.5L7 14v1.5h10V14l-3-3.5V4', 'M12 15.5V21'],
  minimize: ['M6 12h12'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  chevronLeft: ['M14.5 5.5 8 12l6.5 6.5'],
  chevronRight: ['M9.5 5.5 16 12l-6.5 6.5'],
  plus: ['M12 5.5v13', 'M5.5 12h13'],
  check: ['M5 12.5 9.5 17 19 7.5'],
  link: ['M10 13.5a4 4 0 0 0 5.66 0l3-3a4 4 0 1 0-5.66-5.66l-1.5 1.5',
         'M14 10.5a4 4 0 0 0-5.66 0l-3 3a4 4 0 1 0 5.66 5.66l1.5-1.5'],
  help: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z',
         'M9.6 9.2a2.5 2.5 0 1 1 3.3 2.35c-.6.22-.9.7-.9 1.3v.65', 'M12 16.8v.4'],
  repeat: ['M4.5 11a7 7 0 0 1 11.9-4.95L19 8.5', 'M19 4v4.5h-4.5',
           'M19.5 13a7 7 0 0 1-11.9 4.95L5 15.5', 'M5 20v-4.5h4.5'],
  bell: ['M18 8.5a6 6 0 1 0-12 0c0 6-2.5 7.5-2.5 7.5h17S18 14.5 18 8.5Z',
         'M13.7 20a2 2 0 0 1-3.46 0'],
  calendar: ['M4.5 6.5h15v13h-15z', 'M4.5 10.5h15', 'M8.5 4.5v4', 'M15.5 4.5v4'],
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z', 'M16.2 16.2 21 21'],
  trash: ['M4.5 7h15', 'M9.5 7V5h5v2', 'M6.5 7l1 13h9l1-13'],
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 7v5.2l3.4 2'],
  folder: ['M3.5 6.5h6l2 2.5h9v11h-17z'],
  terminal: ['M5 8l4 4-4 4', 'M13 16h6'],
  globe: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M3.2 12h17.6',
          'M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18Z'],
};

/**
 * 아이콘 SVG 엘리먼트를 만든다.
 * @param {keyof PATHS} name
 * @param {number} [size] px. 생략하면 CSS 로 제어(1em)
 */
export function icon(name, size) {
  const paths = PATHS[name];
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', 'var(--icon-stroke, 1.4)');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  if (size) {
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
  }
  if (!paths) return svg;   // 모르는 이름이면 빈 아이콘 (레이아웃은 유지)

  for (const d of paths) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}

/** 버튼 안의 텍스트를 아이콘으로 교체한다 (기존 마크업을 최소로 건드리기 위한 헬퍼) */
export function setIcon(el, name, size) {
  if (!el) return;
  el.textContent = '';
  el.append(icon(name, size));
}
