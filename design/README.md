# 디자인 토큰 — PC 위젯과 폰 앱이 같은 모양을 쓰는 법

일정관리 비서의 색 · 글꼴 · 크기 · 선 · 모서리 · 그림자 · 움직임 값은 **`design/tokens.json` 한 파일**이 원본이다.
PC 위젯 CSS 와 폰 앱(안드로이드) 파일은 모두 여기서 나온다. 협업하는 사람은 값을 이 파일에서만 고친다.

```
design/tokens.json ──npm run tokens──▶ design/build/tokens.css                  PC 위젯(CSS 변수, 라이트 · 다크)
                                      design/build/android/values/colors.xml    폰 앱 색(라이트 · 항목 색 6종)
                                      design/build/android/values-night/colors.xml  폰 앱 색(다크)
                                      design/build/android/values/dimens.xml    폰 앱 모서리 · 선 · 글자 크기
                                      design/build/android/DesignTokens.kt      폰 앱 Compose 상수
```

## 값을 바꿀 때

1. `design/tokens.json` 을 고친다.
2. `npm run tokens` — `design/build/` 를 다시 만든다(손으로 고치지 않는다 — 다음 생성에 덮인다).
3. PC 위젯 CSS(`src/renderer/styles/tokens.css` · `base.css`)도 같은 값으로 고친다.
4. `npm test` — `tests/design-tokens.test.mjs` 가 tokens.json · PC 위젯 CSS · `design/build/` 셋이 같은지 잰다.
   하나라도 다르면 멈춘다. 그래서 한쪽만 바뀐 채로 머지되지 않는다.

## 폰 앱에서 쓰기

- `design/build/android/values/*.xml`, `values-night/colors.xml` 을 앱의 `res/` 같은 자리에 복사한다.
  이름은 모두 `sa_` 로 시작한다(`@color/sa_paper`, `@dimen/sa_radius_control`).
- `design/build/android/DesignTokens.kt` 를 앱 소스에 그대로 복사한다. 패키지 이름은 `tokens.json` 의 `meta.androidPackage` —
  폰 앱(`com.bogeun.schedule`)에 맞춘 `com.bogeun.schedule.design` 이다. 앱 패키지가 바뀌면 이 값을 고치고 다시 만든다.
- 단위: **1 CSS px = 1 dp(크기) · 1 sp(글자)**.
- 머티리얼 동적 색(배경화면 색)은 끄고, 기본 글꼴 · 모서리 · 물결(ripple)에 맡기지 않는다.

```kotlin
val LocalPalette = staticCompositionLocalOf { DesignTokens.Light }

@Composable
fun ScheduleTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    val p = if (dark) DesignTokens.Dark else DesignTokens.Light
    val base = if (dark) darkColorScheme() else lightColorScheme()
    CompositionLocalProvider(LocalPalette provides p) {
        MaterialTheme(
            colorScheme = base.copy(
                background = p.paper, surface = p.paper, onBackground = p.ink, onSurface = p.ink,
                primary = p.gold, onPrimary = p.paper, error = p.seal, outline = p.rule,
            ),
            content = content,
        )
    }
}

// 항목 색 — 동기화 데이터의 color 키 그대로
val bar = DesignTokens.Item.color(task.color)   // "rose" → 다홍 #9c4a33, 모르는 키 → 청람
```

**글꼴** — Noto Serif KR · Noto Sans KR · Cormorant Garamond 세 가지만, 앱에 묶어 넣는다(모두 SIL OFL 1.1).
저장소의 `src/renderer/fonts/handoff/` 는 대부분 woff2 라 안드로이드에서 그대로 못 쓴다 —
Google Fonts 에서 TTF 를 받아 `res/font/` 에 넣거나 안드로이드 '다운로드 가능한 글꼴'을 쓴다.
숫자에는 `fontFeatureSettings = DesignTokens.Font.NUM_FEATURES`(`tnum`).

## 지키는 규칙 — 값이 아니라 쓰는 법

| 규칙 | 토큰 |
|---|---|
| 굵기는 최대 500 — Bold 없음 | `font.maxWeight` |
| 면은 색으로 채우지 않고 1px 괘선으로 나눈다. 버튼은 1px 윤곽선(채운 버튼 없음) | `color.rule` · `border.hairline` |
| 모서리 1 · 2 · 3 · 5 뿐(칩 · 버튼 · 면 · 표지) | `radius.*` |
| 그림자는 4종뿐 | `shadow.*` |
| 오늘은 날짜 아래 17×1 인주색 밑줄(채운 원 아님) | `todayMark` |
| 숫자는 Cormorant Garamond + 자릿수 맞춤 | `font.num` |
| 시간 블록 = 항목색 20% 바탕 + 왼쪽 3px 선, 블록 안에 글자 없음 | `opacity.blockTint` · `border.item` |
| 들어올 때만 움직인다(가만히 도는 애니메이션 없음) | `motion.*` |
| 포커스는 2px 금박 윤곽 + 2px 띄움 | `focus` |

화면 배치 · 문구까지 담긴 시안 원본은 Claude Design 핸드오프(`design_handoff_schedule_assistant` — PORTING.md · README.md ·
시안 HTML)다. 이 저장소에는 없으니 저장소 주인에게 받는다. 화면 사진은 `docs/screenshots/`.
