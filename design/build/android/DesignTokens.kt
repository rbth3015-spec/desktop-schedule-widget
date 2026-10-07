// 자동 생성 — design/tokens.json 에서 `npm run tokens` 로 만든다. 손으로 고치지 않는다.
// 1 CSS px = 1 dp(크기) · 1 sp(글자). 값의 뜻과 쓰는 법은 design/README.md.
package com.bogeun.schedule.design

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp

/** 테마마다 바뀌는 색 한 벌 — DesignTokens.Light / DesignTokens.Dark */
data class SchedulePalette(
    val paper: Color,  // 바탕 — 종이
    val paper2: Color,  // 칸 · 비활성 탭
    val paper3: Color,  // 누름 · hover · 설정 탭
    val ink: Color,  // 본문 글자
    val inkSoft: Color,  // 보조 글자 · 토요일
    val inkFaint: Color,  // 흐린 글자 · 지난 것
    val rule: Color,  // 괘선 — 면은 색이 아니라 1px 선으로 나눈다
    val ruleSoft: Color,  // 옅은 괘선 · 줄 사이
    val edge: Color,  // 입력칸 테두리
    val borderStrong: Color,  // 강한 테두리
    val gold: Color,  // 강조 · 포커스 · 진행 막대
    val goldDeep: Color,  // 금박 글자(다가올 시각) — 다크에서는 gold 보다 밝다
    val goldGhost: Color,  // 선택 영역
    val seal: Color,  // 인주 — 오늘 · 일요일 · 삭제
    val accentSoft: Color,  // 인주 옅게
    val accentWash: Color,  // 인주 아주 옅게
    val success: Color,  // 루틴 ↻ · 성공
    val onColor: Color,  // 항목 색 위 글자
    val cover: Color,  // 표지 — 폰에서는 위 머리 막대
    val coverInk: Color,  // 표지 위 글자 · 아이콘
    val coverInkHi: Color,  // 표지 위 글자 hover
    val ribbonLo: Color,  // 리본 책갈피 아래
    val ribbonHi: Color,  // 리본 책갈피 위
    val dock: Color,  // 아래 리본(D-Day)
    val desk: Color,  // 바깥 바탕(PC 위젯은 투명)
)

/** 그림자 한 종 — 아래로 y, 번짐 blur, 검정 alpha */
data class ShadowSpec(val y: Dp, val blur: Dp, val alpha: Float)

object DesignTokens {
    val Light = SchedulePalette(
        paper = Color(0xFFF5F2EC),
        paper2 = Color(0xFFEFEBE3),
        paper3 = Color(0xFFE6E1D6),
        ink = Color(0xFF22201D),
        inkSoft = Color(0xFF5D5951),
        inkFaint = Color(0xFF98928A),
        rule = Color(0x2622201D),
        ruleSoft = Color(0x1422201D),
        edge = Color(0x3822201D),
        borderStrong = Color(0x4D22201D),
        gold = Color(0xFFB68235),
        goldDeep = Color(0xFF7D5411),
        goldGhost = Color(0x24B68235),
        seal = Color(0xFF8D3A2C),
        accentSoft = Color(0x1A8D3A2C),
        accentWash = Color(0x0A8D3A2C),
        success = Color(0xFF5C6B4A),
        onColor = Color(0xFFF4EDE1),
        cover = Color(0xFF3A332B),
        coverInk = Color(0xFFD6C4A0),
        coverInkHi = Color(0xFFE8DCC2),
        ribbonLo = Color(0xFF752F24),
        ribbonHi = Color(0xFF8D3A2C),
        dock = Color(0xFFF0ECE4),
        desk = Color(0xFF4A443C),
    )

    val Dark = SchedulePalette(
        paper = Color(0xFF22201D),
        paper2 = Color(0xFF2A2723),
        paper3 = Color(0xFF33302A),
        ink = Color(0xFFECE5D7),
        inkSoft = Color(0xFFA9A294),
        inkFaint = Color(0xFF6F6A60),
        rule = Color(0x26ECE5D7),
        ruleSoft = Color(0x14ECE5D7),
        edge = Color(0x38ECE5D7),
        borderStrong = Color(0x4DECE5D7),
        gold = Color(0xFFC9A05A),
        goldDeep = Color(0xFFDCBC80),
        goldGhost = Color(0x29C9A05A),
        seal = Color(0xFFC0705C),
        accentSoft = Color(0x29C0705C),
        accentWash = Color(0x14C0705C),
        success = Color(0xFF8EA173),
        onColor = Color(0xFFF4EDE1),
        cover = Color(0xFF17150F),
        coverInk = Color(0xFFD6C4A0),
        coverInkHi = Color(0xFFE8DCC2),
        ribbonLo = Color(0xFF752F24),
        ribbonHi = Color(0xFF8D3A2C),
        dock = Color(0xFF2A2723),
        desk = Color(0xFF4A443C),
    )

    /** 항목 색 6종 — 동기화 데이터의 color 키 그대로. 두 테마 같은 값 */
    object Item {
        val blue = Color(0xFF4A5F7A)  // 청람
        val green = Color(0xFF5C6B4A)  // 쑥
        val amber = Color(0xFF9A7A2E)  // 치자
        val rose = Color(0xFF9C4A33)  // 다홍
        val violet = Color(0xFF6D4A5E)  // 자주
        val slate = Color(0xFF4F4B45)  // 회묵

        /** color 키 → 색. 모르는 키는 blue(PC 위젯과 같다) */
        fun color(key: String?): Color = when (key) {
            "green" -> green
            "amber" -> amber
            "rose" -> rose
            "violet" -> violet
            "slate" -> slate
            else -> blue
        }

        /** color 키 → 이름 */
        fun label(key: String?): String = when (key) {
            "green" -> "쑥"
            "amber" -> "치자"
            "rose" -> "다홍"
            "violet" -> "자주"
            "slate" -> "회묵"
            else -> "청람"
        }
    }

    object Font {
        const val SERIF = "Noto Serif KR"  // 날짜 · 화면 제목 · 표제 · 탭 이름
        const val SANS = "Noto Sans KR"  // 본문 · 버튼 · 칩
        const val NUM = "Cormorant Garamond"  // 모든 숫자 — 자릿수 맞춤
        const val MAX_WEIGHT = 500
        /** 숫자 TextStyle 에 — fontFeatureSettings = NUM_FEATURES */
        const val NUM_FEATURES = "tnum"
    }

    object TextSize {
        val title = 20.sp  // 화면 제목 · 날짜 머리(9월 30일)
        val body = 13.sp  // 본문 기본
        val coverTitle = 13.sp  // 표지 제목 '일정관리 비서'
        val aide = 12.5.sp  // 비서의 한 줄
        val label = 12.sp  // 요일 · 보조 머리
        val tab = 11.sp  // 책갈피 탭 · 달력 요일 머리
        val chip = 10.5.sp  // 시각 칩(14:00)
        val badge = 9.5.sp  // '오늘' 같은 작은 표
    }

    object Tracking {
        val coverTitle = 0.34.em
        val tab = 0.22.em
        val weekday = 0.22.em
        val label = 0.16.em
        val badge = 0.1.em
    }

    object LineHeight {
        const val AIDE = 1.75f
    }

    object Radius {
        val chip = 1.dp
        val control = 2.dp
        val pane = 3.dp
        val cover = 5.dp
    }

    object Border {
        val hairline = 1.dp  // 괘선 · 버튼 윤곽 — 버튼은 채우지 않고 이 선만
        val accent = 2.dp  // 비서의 한 줄 왼쪽 금박 선 · 진행 막대 · 포커스
        val item = 3.dp  // 시간 블록 · 상세 머리의 왼쪽 항목색 선
    }

    /** 그림자는 이 4종뿐 */
    object Shadow {
        val cover = ShadowSpec(30.dp, 70.dp, 0.5f)
        val modal = ShadowSpec(20.dp, 48.dp, 0.34f)
        val peek = ShadowSpec(18.dp, 42.dp, 0.32f)
        val tab = ShadowSpec(2.dp, 5.dp, 0.28f)
    }

    object Opacity {
        const val OUTSIDE_MONTH = 0.45f  // 이번 달 밖 날짜 · 끝난 기간 막대
        const val PAST_BLOCK = 0.55f  // 지난 시간 블록
        const val BLOCK_TINT = 0.2f  // 시간 블록 바탕 = 항목색을 paper 에 이만큼
    }

    /** peek · 모달 뒤를 덮는 막 */
    val Scrim = Color(0x5722201D)

    /** 들어올 때만 움직인다. 가만히 있을 때 도는 애니메이션은 없다. */
    object Motion {
        const val LEAF_IN_MS = 500  // 펼침면이 열릴 때
        val leafInOffsetY = 7.dp
        const val PAGE_IN_MS = 280  // 탭으로 화면을 바꿀 때
        val pageInOffsetX = 10.dp
        const val SCRIM_IN_MS = 220  // 막이 깔릴 때
    }

    object Focus {
        val width = 2.dp
        val offset = 2.dp
    }

    /** 선 아이콘(Lucide 계열). 폰은 48dp 터치 영역 안에 16–18dp */
    object Icon {
        const val STROKE = 1.5f
        val sizeMin = 11.dp
        val sizeMax = 14.dp
    }

    /** 오늘 = 날짜 숫자 아래 밑줄(채운 원이 아니다) */
    object TodayMark {
        val width = 17.dp
        val height = 1.dp
    }
}
