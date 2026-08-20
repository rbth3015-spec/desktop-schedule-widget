# 번들 폰트

시스템 폰트에 기대면 PC마다 다른 글꼴로 폴백된다. 실제로 이 프로젝트도 지정한 폰트가
사용자 PC에 하나도 없어 전부 `Batang`(1990년대 인쇄용 명조)으로 떨어져 있었다.
배포용 앱이므로 폰트를 직접 포함한다.

| 폰트 | 용도 | 라이선스 |
|---|---|---|
| Pretendard Variable | 본문 산세리프 | SIL Open Font License 1.1 |
| Nanum Myeongjo (400/700) | 날짜·표제 세리프 | SIL Open Font License 1.1 |

셋 다 OFL 1.1 이라 상업적 사용·재배포가 허용된다. 전문은 `OFL-NanumMyeongjo.txt` 참조.

- Pretendard — https://github.com/orioncactus/pretendard
- Nanum Myeongjo — Google Fonts (Fontsource 배포본)

## 주의

`index.html` 의 CSP 에 `font-src 'self'` 가 있어야 한다.
`default-src 'none'` 만 있으면 @font-face 가 조용히 차단되어 시스템 폰트로 폴백된다.
