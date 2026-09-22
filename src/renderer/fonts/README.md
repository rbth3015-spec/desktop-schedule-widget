# 번들 폰트

시스템 폰트에 기대면 PC마다 다른 글꼴로 폴백된다. 배포용 앱이므로 폰트를 직접 포함한다.
서체는 디자인 핸드오프(`design_handoff_schedule_assistant/tokens.css`)가 정한 세 가지뿐이다.
PORTING.md 가 서체 대체를 금지하므로 설정에서 글꼴을 고르는 기능은 두지 않는다.

| 폰트 | 토큰 | 용도 | 파일 |
|---|---|---|---|
| Noto Serif KR (가변) | `--serif` | 날짜 · 표제 · 화면 머리 | `handoff/notoserifkr-*.woff2` (유니코드 구간별 분할) |
| Noto Sans KR (가변) | `--sans` | 본문 · 버튼 · 칩 | `handoff/NotoSansKR-VF.ttf` |
| Cormorant Garamond (300/400/500) | `--num` | 숫자 전부 (tnum) | `handoff/cormorant-*.woff2` (라틴만) |

전부 SIL Open Font License 1.1 이라 상업적 사용 · 재배포가 허용된다. 전문은 `handoff/OFL.txt`.

## 주의

`index.html` 의 CSP 에 `font-src 'self'` 가 있어야 한다.
`default-src 'none'` 만 있으면 @font-face 가 조용히 차단되어 시스템 폰트로 폴백된다.
