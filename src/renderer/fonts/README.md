# 번들 폰트

시스템 폰트에 기대면 PC마다 다른 글꼴로 폴백된다. 실제로 이 프로젝트도 지정한 폰트가
사용자 PC에 하나도 없어 전부 `Batang`(1990년대 인쇄용 명조)으로 떨어져 있었다.
배포용 앱이므로 폰트를 직접 포함한다.

| 폰트 | 용도 | 라이선스 |
|---|---|---|
| Pretendard Variable | 본문 산세리프 (기본) | SIL Open Font License 1.1 |
| Nanum Myeongjo (400/700) | 날짜·표제 세리프 (기본) | SIL Open Font License 1.1 |
| Gowun Batang (400/700) | 표제 세리프 (선택) | SIL Open Font License 1.1 |
| Gowun Dodum (400) | 본문 산세리프 (선택) | SIL Open Font License 1.1 |

전부 OFL 1.1 이라 상업적 사용·재배포가 허용된다.
전문은 `OFL-NanumMyeongjo.txt`, `OFL-Gowun.txt` 참조.

- Pretendard — https://github.com/orioncactus/pretendard
- Nanum Myeongjo — Google Fonts (Fontsource 배포본)
- Gowun Batang / Gowun Dodum — https://github.com/yangheeryu/Gowun-Batang (Fontsource 배포본)

설정의 '본문 글꼴 / 표제 글꼴' 에서 고른다. 시스템 폰트(맑은 고딕·바탕·궁서)도
선택지에 있지만, 없는 PC 에서는 폴백 목록이 받아 주므로 화면이 무너지지 않는다.

번들 폰트는 고르기 전까지 실제로 내려받지 않는다(@font-face 는 선언만으로는
파일을 요청하지 않는다). 설치본 크기에는 더해지지만 실행 중 메모리에는 쓰는 것만 올라온다.

## 주의

`index.html` 의 CSP 에 `font-src 'self'` 가 있어야 한다.
`default-src 'none'` 만 있으면 @font-face 가 조용히 차단되어 시스템 폰트로 폴백된다.
