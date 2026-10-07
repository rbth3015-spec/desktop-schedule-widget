// 메일 쓰기 창 주소.
//
// mailto: 는 윈도우가 '기본 메일 앱'에 넘긴다. 크롬이 mailto 를 받는데 Gmail 이 처리기로
// 등록돼 있지 않으면 빈 크롬 창만 뜬다(#28). 그래서 Gmail 쓰기 화면을 https 로 바로 연다 —
// 기본 브라우저가 무엇이든 열리고, 로그인 전이면 로그인한 뒤 쓰기 화면으로 간다.

/** Gmail 쓰기 화면 — 받는 사람 · 제목 · 본문을 채워 둔다 */
export function gmailComposeUrl({ to, subject = '', body = '' }) {
  return 'https://mail.google.com/mail/?view=cm&fs=1'
    + `&to=${encodeURIComponent(to)}`
    + `&su=${encodeURIComponent(subject)}`
    + `&body=${encodeURIComponent(body)}`;
}
