// 디자인 토큰 — design/tokens.json 이 PC 위젯 CSS 와 같은 값인지, design/build/ 가 tokens.json 에서 만든 그대로인지.
// 한쪽만 고치면 여기서 멈춘다(폰 앱과 PC 위젯의 모양이 갈라지지 않게).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const T = require('../tools/build-tokens.js');

const tokens = T.readTokens();
const read = (rel) => fs.readFileSync(path.join(T.ROOT, rel), 'utf8');
const tokensCss = read('src/renderer/styles/tokens.css');
const baseCss = read('src/renderer/styles/base.css');
const round = (c) => c && { hex: c.hex, alpha: Math.round(c.alpha * 1000) / 1000 };

/** PC 위젯이 실제로 쓰는 색 — 라이트는 tokens.css(없으면 base.css 라이트), 다크는 base.css(없으면 라이트를 물려받는다) */
function widgetColor(name, mode) {
  const light = T.cssProp(tokensCss, ':root', `--${name}`)
    ?? T.cssProp(baseCss, ':root, :root[data-theme="light"]', `--${name}`);
  if (mode === 'light') return T.parseCssColor(light);
  return T.parseCssColor(T.cssProp(baseCss, ':root[data-theme="dark"]', `--${name}`) ?? light);
}

test('색 — 라이트 · 다크 모두 PC 위젯 CSS 와 같다', () => {
  for (const [name, c] of T.entries(tokens.color)) {
    for (const mode of ['light', 'dark']) {
      const want = round(T.resolveColor(tokens, c[mode], mode));
      assert.deepEqual(round(widgetColor(name, mode)), want, `${name} (${mode})`);
    }
  }
});

test('항목 색 6종 — tokens.css 의 값 · store.js 의 COLORS · COLOR_LABELS 와 같다', () => {
  const store = read('src/renderer/store.js');
  const colors = store.match(/export const COLORS = \{([\s\S]*?)\};/)[1];
  const labels = store.match(/export const COLOR_LABELS = \{([\s\S]*?)\};/)[1];
  for (const [key, it] of T.entries(tokens.item)) {
    assert.equal(T.cssProp(tokensCss, ':root', it.css), it.value, `${key} ${it.css}`);
    assert.equal(colors.match(new RegExp(`${key}:\\s*'(#[0-9a-f]{6})'`))?.[1], it.value, `COLORS.${key}`);
    assert.equal(labels.match(new RegExp(`${key}:\\s*'([^']+)'`))?.[1], it.label, `COLOR_LABELS.${key}`);
  }
  assert.equal(T.entries(tokens.item).length, 6);
});

test('서체 — 세 가지 이름과 순서가 같다', () => {
  for (const key of ['serif', 'sans', 'num']) {
    assert.deepEqual(T.parseFamily(T.cssProp(tokensCss, ':root', `--${key}`)), tokens.font[key].family, key);
  }
});

test('글자 크기 · 자간 · 줄 간격 — from 이 가리키는 CSS 자리의 값과 같다', () => {
  const groups = [['size', 'px'], ['tracking', 'em'], ['lineHeight', 'ratio']];
  for (const [group, unit] of groups) {
    for (const [name, t] of T.entries(tokens[group])) {
      const [file, selector, prop] = t.from;
      const raw = T.cssProp(read(file), selector, prop);
      assert.ok(raw, `${group}.${name} — ${file} ${selector || ''} ${prop} 를 찾지 못했습니다`);
      assert.equal(parseFloat(raw), t[unit], `${group}.${name} (${raw})`);
    }
  }
});

test('모서리 — base.css 의 radius 변수와 같다', () => {
  for (const [name, r] of T.entries(tokens.radius)) {
    assert.equal(parseFloat(T.cssProp(baseCss, null, r.css)), r.px, `radius.${name} ${r.css}`);
  }
});

test('그림자 4종 · 들어오는 움직임 — tokens.css 와 같다', () => {
  const squash = (s) => s.replace(/\s+/g, '');
  for (const [name, s] of T.entries(tokens.shadow)) {
    assert.equal(squash(T.cssProp(tokensCss, `.shadow-${name}`, 'box-shadow')), squash(T.shadowCss(tokens, s)), `shadow.${name}`);
  }
  assert.match(tokensCss, new RegExp(`@keyframes leafIn\\{[^@]*translateY\\(${tokens.motion.leafIn.translateY}px\\)`));
  assert.match(tokensCss, new RegExp(`@keyframes pageIn\\{[^@]*translateX\\(${tokens.motion.pageIn.translateX}px\\)`));
});

test('design/build/ 는 tokens.json 에서 만든 그대로다(손으로 고치지 않았다)', () => {
  for (const [rel, content] of Object.entries(T.buildAll(tokens))) {
    const file = path.join(T.OUT, rel);
    assert.ok(fs.existsSync(file), `design/build/${rel} 가 없습니다 — npm run tokens`);
    assert.equal(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'), content, `design/build/${rel} — npm run tokens 로 다시 만드세요`);
  }
});

test('참조 색은 모두 있는 색을 가리키고 투명도는 0~1 이다', () => {
  for (const [name, c] of T.entries(tokens.color)) {
    for (const mode of ['light', 'dark']) {
      const v = T.resolveColor(tokens, c[mode], mode);
      assert.match(v.hex, /^#[0-9a-f]{6}$/, `${name} (${mode})`);
      assert.ok(v.alpha > 0 && v.alpha <= 1, `${name} (${mode}) alpha`);
    }
  }
});
