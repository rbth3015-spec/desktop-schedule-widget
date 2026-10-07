// 디자인 토큰 — design/tokens.json 하나에서 PC 위젯 CSS 와 폰 앱(안드로이드) 파일을 만든다.
//
//   npm run tokens            design/build/ 를 다시 만든다
//   npm run tokens -- --check 만들어 둔 파일이 tokens.json 과 같은지만 본다(다르면 1 로 끝난다)
//
// 협업 규칙: 값은 tokens.json 에서만 고친다. design/build/ 는 손대지 않는다(다음 생성에 덮인다).
// 새 패키지 없이 node 내장 모듈만 쓴다 — package.json 의 dependencies 는 비어 있어야 한다.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TOKENS = path.join(ROOT, 'design', 'tokens.json');
const OUT = path.join(ROOT, 'design', 'build');

const HEADER = '자동 생성 — design/tokens.json 에서 `npm run tokens` 로 만든다. 손으로 고치지 않는다.';
const MODES = ['light', 'dark'];

function readTokens(file = TOKENS) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** '$' 로 시작하는 설명 칸을 뺀 [이름, 값] */
function entries(group) {
  return Object.entries(group || {}).filter(([k]) => !k.startsWith('$'));
}

// ---------------------------------------------------------------- 색

/** 색 하나를 {hex, alpha} 로 — '#rrggbb' · {ref, alpha} · {hex, alpha} */
function resolveColor(tokens, spec, mode) {
  if (typeof spec === 'string') return { hex: spec.toLowerCase(), alpha: 1 };
  if (spec && spec.ref) {
    const base = tokens.color[spec.ref] && tokens.color[spec.ref][mode];
    if (typeof base !== 'string') throw new Error(`색 ${spec.ref} 의 ${mode} 값이 #rrggbb 가 아닙니다`);
    return { hex: base.toLowerCase(), alpha: spec.alpha };
  }
  if (spec && spec.hex) return { hex: spec.hex.toLowerCase(), alpha: spec.alpha ?? 1 };
  throw new Error(`알 수 없는 색 ${JSON.stringify(spec)}`);
}

const pct = (a) => `${Math.round(a * 1000) / 10}%`;
const alphaText = (a) => String(Math.round(a * 1000) / 1000).replace(/^0\./, '.');
const alphaByte = (a) => Math.round(a * 255).toString(16).padStart(2, '0').toUpperCase();
const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

function cssColor({ hex, alpha }) {
  return alpha >= 1 ? hex : `color-mix(in srgb, ${hex} ${pct(alpha)}, transparent)`;
}
/** 안드로이드 #AARRGGBB */
function argb({ hex, alpha }) {
  return `#${alphaByte(alpha)}${hex.slice(1).toUpperCase()}`;
}
/** Compose Color(0xAARRGGBB) */
function composeColor(c) {
  return `Color(0x${argb(c).slice(1)})`;
}

// ---------------------------------------------------------------- 이름

const camel = (s) => s.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
const snake = (s) => s.replace(/-/g, '_').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
const constName = (s) => snake(s).toUpperCase();
const cssFamily = (list) => list.map((f) => (/^(serif|sans-serif|system-ui|monospace)$/.test(f) ? f : `"${f}"`)).join(', ');
const num = (v) => String(Math.round(v * 1000) / 1000);

// ---------------------------------------------------------------- 그림자

function shadowCss(tokens, s) {
  let out = `0 ${s.y}px ${s.blur}px rgba(0,0,0,${alphaText(s.alpha)})`;
  if (s.ring) {
    const ring = resolveColor(tokens, s.ring, 'light');
    out += `, inset 0 0 0 1px rgba(${rgbOf(ring.hex).join(',')},${alphaText(ring.alpha)})`;
  }
  return out;
}

// ---------------------------------------------------------------- PC 위젯 CSS

function buildCss(tokens) {
  const L = [];
  L.push(`/* ${HEADER} */`, '');
  L.push(':root,', ':root[data-theme="light"] {');
  for (const [name, c] of entries(tokens.color)) L.push(`  --${name}: ${cssColor(resolveColor(tokens, c.light, 'light'))};`);
  L.push('');
  for (const [, it] of entries(tokens.item)) L.push(`  ${it.css}: ${it.value};`);
  L.push('');
  for (const key of ['serif', 'sans', 'num']) L.push(`  --${key}: ${cssFamily(tokens.font[key].family)};`);
  L.push(`  --fs: ${num(tokens.size.body.px)}px;`);
  for (const [, r] of entries(tokens.radius)) L.push(`  ${r.css}: ${num(r.px)}px;`);
  L.push('}', '');
  L.push(':root[data-theme="dark"] {');
  for (const [name, c] of entries(tokens.color)) L.push(`  --${name}: ${cssColor(resolveColor(tokens, c.dark, 'dark'))};`);
  L.push('}', '');
  L.push(`.num { font-family: var(--num); font-feature-settings: '${tokens.font.num.features.join("', '")}'; }`);
  L.push('');
  for (const [name, s] of entries(tokens.shadow)) L.push(`.shadow-${name} { box-shadow: ${shadowCss(tokens, s)}; }`);
  L.push('');
  const m = tokens.motion;
  L.push(`@keyframes leafIn { from { opacity: ${m.leafIn.fromOpacity}; transform: translateY(${m.leafIn.translateY}px) } to { opacity: 1; transform: none } }`);
  L.push(`@keyframes pageIn { from { opacity: ${m.pageIn.fromOpacity}; transform: translateX(${m.pageIn.translateX}px) } to { opacity: 1; transform: none } }`);
  L.push(`@keyframes scrimIn { from { opacity: ${m.scrimIn.fromOpacity} } to { opacity: 1 } }`);
  L.push('');
  L.push(`*:focus-visible { outline: ${tokens.focus.width}px solid var(--${tokens.focus.color}); outline-offset: ${tokens.focus.offset}px; }`);
  L.push('::selection { background: var(--gold-ghost); }');
  return `${L.join('\n')}\n`;
}

// ---------------------------------------------------------------- 안드로이드 XML

function xml(lines) {
  return ['<?xml version="1.0" encoding="utf-8"?>', `<!-- ${HEADER} -->`, '<resources>', ...lines, '</resources>', ''].join('\n');
}

function buildColorsXml(tokens, mode) {
  const lines = [];
  for (const [name, c] of entries(tokens.color)) {
    lines.push(`    <color name="sa_${snake(name)}">${argb(resolveColor(tokens, c[mode], mode))}</color>  <!-- ${c.use} -->`);
  }
  if (mode === 'light') {
    lines.push('', '    <!-- 항목 색 6종 — 동기화 데이터의 color 키. 두 테마 같은 값이라 values-night 에는 없다 -->');
    for (const [key, it] of entries(tokens.item)) {
      lines.push(`    <color name="sa_item_${key}">${argb({ hex: it.value.toLowerCase(), alpha: 1 })}</color>  <!-- ${it.label} -->`);
    }
    lines.push('', `    <color name="sa_scrim">${argb(resolveColor(tokens, tokens.scrim, 'light'))}</color>  <!-- ${tokens.scrim.use} -->`);
  }
  return xml(lines);
}

function buildDimensXml(tokens) {
  const lines = [];
  lines.push('    <!-- 모서리 -->');
  for (const [name, r] of entries(tokens.radius)) lines.push(`    <dimen name="sa_radius_${snake(name)}">${num(r.px)}dp</dimen>`);
  lines.push('    <!-- 선 -->');
  for (const [name, b] of entries(tokens.border)) lines.push(`    <dimen name="sa_border_${snake(name)}">${num(b.px)}dp</dimen>`);
  lines.push('    <!-- 글자 -->');
  for (const [name, s] of entries(tokens.size)) lines.push(`    <dimen name="sa_text_${snake(name)}">${num(s.px)}sp</dimen>  <!-- ${s.use} -->`);
  lines.push('    <!-- 그 밖 -->');
  lines.push(`    <dimen name="sa_focus_width">${tokens.focus.width}dp</dimen>`);
  lines.push(`    <dimen name="sa_focus_offset">${tokens.focus.offset}dp</dimen>`);
  lines.push(`    <dimen name="sa_today_mark_width">${tokens.todayMark.width}dp</dimen>`);
  lines.push(`    <dimen name="sa_today_mark_height">${tokens.todayMark.height}dp</dimen>`);
  return xml(lines);
}

// ---------------------------------------------------------------- Compose

function buildKotlin(tokens) {
  const colors = entries(tokens.color);
  const L = [];
  L.push(`// ${HEADER}`);
  L.push(`// ${tokens.meta.unit}. 값의 뜻과 쓰는 법은 design/README.md.`);
  L.push(`package ${tokens.meta.androidPackage}`, '');
  L.push('import androidx.compose.ui.graphics.Color');
  L.push('import androidx.compose.ui.unit.Dp');
  L.push('import androidx.compose.ui.unit.dp');
  L.push('import androidx.compose.ui.unit.em');
  L.push('import androidx.compose.ui.unit.sp', '');
  L.push('/** 테마마다 바뀌는 색 한 벌 — DesignTokens.Light / DesignTokens.Dark */');
  L.push('data class SchedulePalette(');
  for (const [name, c] of colors) L.push(`    val ${camel(name)}: Color,  // ${c.use}`);
  L.push(')', '');
  L.push('/** 그림자 한 종 — 아래로 y, 번짐 blur, 검정 alpha */');
  L.push('data class ShadowSpec(val y: Dp, val blur: Dp, val alpha: Float)', '');
  L.push('object DesignTokens {');
  for (const mode of MODES) {
    L.push(`    val ${mode === 'light' ? 'Light' : 'Dark'} = SchedulePalette(`);
    for (const [name, c] of colors) L.push(`        ${camel(name)} = ${composeColor(resolveColor(tokens, c[mode], mode))},`);
    L.push('    )', '');
  }
  L.push('    /** 항목 색 6종 — 동기화 데이터의 color 키 그대로. 두 테마 같은 값 */');
  L.push('    object Item {');
  const items = entries(tokens.item);
  for (const [key, it] of items) L.push(`        val ${key} = ${composeColor({ hex: it.value.toLowerCase(), alpha: 1 })}  // ${it.label}`);
  L.push('', '        /** color 키 → 색. 모르는 키는 blue(PC 위젯과 같다) */');
  L.push('        fun color(key: String?): Color = when (key) {');
  for (const [key] of items.slice(1)) L.push(`            "${key}" -> ${key}`);
  L.push(`            else -> ${items[0][0]}`, '        }', '');
  L.push('        /** color 키 → 이름 */');
  L.push('        fun label(key: String?): String = when (key) {');
  for (const [key, it] of items.slice(1)) L.push(`            "${key}" -> "${it.label}"`);
  L.push(`            else -> "${items[0][1].label}"`, '        }');
  L.push('    }', '');
  L.push('    object Font {');
  L.push(`        const val SERIF = "${tokens.font.serif.family[0]}"  // ${tokens.font.serif.use}`);
  L.push(`        const val SANS = "${tokens.font.sans.family[0]}"  // ${tokens.font.sans.use}`);
  L.push(`        const val NUM = "${tokens.font.num.family[0]}"  // ${tokens.font.num.use}`);
  L.push(`        const val MAX_WEIGHT = ${tokens.font.maxWeight}`);
  L.push('        /** 숫자 TextStyle 에 — fontFeatureSettings = NUM_FEATURES */');
  L.push(`        const val NUM_FEATURES = "${tokens.font.num.features.join(', ')}"`);
  L.push('    }', '');
  L.push('    object TextSize {');
  for (const [name, s] of entries(tokens.size)) L.push(`        val ${name} = ${num(s.px)}.sp  // ${s.use}`);
  L.push('    }', '');
  L.push('    object Tracking {');
  for (const [name, t] of entries(tokens.tracking)) L.push(`        val ${name} = ${num(t.em)}.em`);
  L.push('    }', '');
  L.push('    object LineHeight {');
  for (const [name, t] of entries(tokens.lineHeight)) L.push(`        const val ${constName(name)} = ${num(t.ratio)}f`);
  L.push('    }', '');
  L.push('    object Radius {');
  for (const [name, r] of entries(tokens.radius)) L.push(`        val ${name} = ${num(r.px)}.dp`);
  L.push('    }', '');
  L.push('    object Border {');
  for (const [name, b] of entries(tokens.border)) L.push(`        val ${name} = ${num(b.px)}.dp  // ${b.use}`);
  L.push('    }', '');
  L.push('    /** 그림자는 이 4종뿐 */');
  L.push('    object Shadow {');
  for (const [name, s] of entries(tokens.shadow)) L.push(`        val ${name} = ShadowSpec(${num(s.y)}.dp, ${num(s.blur)}.dp, ${num(s.alpha)}f)`);
  L.push('    }', '');
  L.push('    object Opacity {');
  for (const [name, o] of entries(tokens.opacity)) L.push(`        const val ${constName(name)} = ${num(o.value)}f  // ${o.use}`);
  L.push('    }', '');
  L.push(`    /** ${tokens.scrim.use} */`);
  L.push(`    val Scrim = ${composeColor(resolveColor(tokens, tokens.scrim, 'light'))}`, '');
  L.push(`    /** ${tokens.motion.$comment} */`);
  L.push('    object Motion {');
  for (const [name, mo] of entries(tokens.motion)) {
    L.push(`        const val ${constName(name)}_MS = ${mo.ms}  // ${mo.use}`);
    if (mo.translateY != null) L.push(`        val ${name}OffsetY = ${mo.translateY}.dp`);
    if (mo.translateX != null) L.push(`        val ${name}OffsetX = ${mo.translateX}.dp`);
  }
  L.push('    }', '');
  L.push('    object Focus {');
  L.push(`        val width = ${tokens.focus.width}.dp`);
  L.push(`        val offset = ${tokens.focus.offset}.dp`);
  L.push('    }', '');
  L.push(`    /** ${tokens.icon.use} */`);
  L.push('    object Icon {');
  L.push(`        const val STROKE = ${num(tokens.icon.stroke)}f`);
  L.push(`        val sizeMin = ${tokens.icon.sizeMin}.dp`);
  L.push(`        val sizeMax = ${tokens.icon.sizeMax}.dp`);
  L.push('    }', '');
  L.push(`    /** ${tokens.todayMark.use} */`);
  L.push('    object TodayMark {');
  L.push(`        val width = ${tokens.todayMark.width}.dp`);
  L.push(`        val height = ${tokens.todayMark.height}.dp`);
  L.push('    }');
  L.push('}');
  return `${L.join('\n')}\n`;
}

/** 만들 파일 전부 — {design/build 아래 경로: 내용} */
function buildAll(tokens = readTokens()) {
  return {
    'tokens.css': buildCss(tokens),
    'android/values/colors.xml': buildColorsXml(tokens, 'light'),
    'android/values-night/colors.xml': buildColorsXml(tokens, 'dark'),
    'android/values/dimens.xml': buildDimensXml(tokens),
    'android/DesignTokens.kt': buildKotlin(tokens),
  };
}

// ---------------------------------------------------------------- CSS 읽기(시험이 PC 위젯 값과 맞춰 볼 때 쓴다)

/** 주석을 걷은 CSS 에서 선택자가 정확히 같은 블록들의 본문 */
function cssBlocks(text, selector) {
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const norm = (s) => s.replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').trim();
  const want = norm(selector);
  const out = [];
  for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) if (norm(m[1]) === want) out.push(m[2]);
  return out;
}

/** 선택자 블록(없으면 파일 전체)에서 속성 값 하나 */
function cssProp(text, selector, prop) {
  const bodies = selector ? cssBlocks(text, selector) : [text.replace(/\/\*[\s\S]*?\*\//g, '')];
  const re = new RegExp(`(?:^|[;{\\s])${prop.replace(/[-]/g, '\\-')}\\s*:\\s*([^;}]+)`);
  for (const body of bodies) {
    const m = body.match(re);
    if (m) return m[1].trim();
  }
  return null;
}

/** '#rrggbb' · 'color-mix(in srgb, #rrggbb N%, transparent)' → {hex, alpha} */
function parseCssColor(value) {
  if (!value) return null;
  const v = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return { hex: v.toLowerCase(), alpha: 1 };
  const m = v.match(/^color-mix\(\s*in srgb\s*,\s*(#[0-9a-f]{6})\s+([\d.]+)%\s*,\s*transparent\s*\)$/i);
  return m ? { hex: m[1].toLowerCase(), alpha: Number(m[2]) / 100 } : null;
}

/** '"Noto Serif KR","Cormorant Garamond",serif' → ['Noto Serif KR', 'Cormorant Garamond', 'serif'] */
function parseFamily(value) {
  return (value || '').split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

module.exports = {
  ROOT, OUT, readTokens, entries, resolveColor, buildAll, shadowCss,
  cssBlocks, cssProp, parseCssColor, parseFamily,
};

// ---------------------------------------------------------------- 명령줄

if (require.main === module) {
  const check = process.argv.includes('--check');
  const files = buildAll();
  let stale = 0;
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(OUT, rel);
    const now = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : null;
    if (now === content) continue;
    if (check) {
      stale++;
      console.error(`✗ design/build/${rel} 가 tokens.json 과 다릅니다`);
    } else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      console.log(`✓ design/build/${rel}`);
    }
  }
  if (check && stale) {
    console.error('\n`npm run tokens` 로 다시 만드세요.');
    process.exit(1);
  }
  if (!check) console.log('디자인 토큰을 design/build/ 에 만들었습니다.');
}
