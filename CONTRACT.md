# 모듈 계약 (수정 금지 — 이 문서가 기준입니다)

Electron 데스크톱 위젯. **빌드 스텝 없음.** 렌더러는 순수 ES 모듈(`<script type="module">`),
메인 프로세스는 CommonJS. 외부 npm 런타임 의존성 추가 금지 (electron 만 사용).

## 파일 소유권

각 작업자는 **자기 소유 파일만** 생성/수정합니다. 남의 파일은 읽기만 하세요.

| 소유       | 파일 |
|-----------|------|
| 오케스트레이터 | `package.json`, `src/renderer/index.html`, `src/renderer/app.js`, `src/renderer/store.js`, `src/renderer/lib/date.js`, `src/renderer/styles/base.css` |
| 메인 프로세스  | `src/main/main.js`, `src/main/preload.js`, `src/main/storage.js`, `src/main/windowState.js` |
| 캘린더      | `src/renderer/calendar/calendar.js`, `src/renderer/calendar/calendar.css` |
| 투두        | `src/renderer/todo/todo.js`, `src/renderer/todo/todo.css` |
| 대시보드     | `src/renderer/dashboard/dashboard.js`, `src/renderer/dashboard/dashboard.css` |
| 런처        | `src/renderer/launcher/launcher.js`, `src/renderer/launcher/launcher.css` |

## 데이터 모델

`src/renderer/store.js` 상단 JSDoc 의 `Task` 가 정본입니다. 요약:

```js
{
  id: string, title: string, notes: string,
  start: 'YYYY-MM-DD' | null,   // null = 날짜 미지정('언젠가')
  end:   'YYYY-MM-DD' | null,   // 단일 일정이면 start 와 동일. end > start 이면 장기 계획
  done: boolean, priority: 0|1|2, color: 'blue'|'green'|'amber'|'rose'|'violet'|'slate',
  tags: string[], order: number, createdAt: number, doneAt: number|null
}
```

디스크 저장 형태: `{ "version": 1, "tasks": Task[], "settings": {...} }`

`settings` 기본값은 `store.js` 의 `DEFAULT_SETTINGS` 참조:
`theme, opacity, splitRatio, alwaysOnTop, clickThroughLocked, showCompleted, weekStart, fontScale`

## IPC 계약 — `window.api` (preload 가 contextBridge 로 노출)

```ts
window.api = {
  loadData(): Promise<{version:number, tasks:Task[], settings:object}>,
  saveData(data: {tasks:Task[], settings:object}): Promise<{ok:boolean, error?:string}>,

  window: {
    minimize(): void,
    hide(): void,                              // 트레이로 숨김
    setAlwaysOnTop(on: boolean): void,
    setOpacity(value: number): void,           // 0.3 ~ 1
    setIgnoreMouseEvents(on: boolean): void,   // 클릭 통과(잠금 모드)
    getBounds(): Promise<{x,y,width,height}>,
    setSize(w: number, h: number): void,
    snapPreset(preset: 'compact'|'normal'|'wide'|'tall'): void,
  },

  onMenuAction(cb: (action: string) => void): void,  // 트레이 메뉴 -> 렌더러
}
```

## 렌더러 모듈 계약

두 뷰 모듈은 **정확히 이 시그니처의 팩토리 하나**를 default 가 아닌 **named export** 로 냅니다.

```js
// calendar/calendar.js
export function createCalendar({ root, store }) { return { destroy() {} }; }

// todo/todo.js
export function createTodoPanel({ root, store }) { return { destroy() {} }; }
```

- `root` : 이미 존재하는 빈 DOM 엘리먼트. 그 안에만 그립니다.
- `store`: `src/renderer/store.js` 모듈 네임스페이스 객체 전체.
  - 읽기: `store.getState()`, `store.tasksOnDate(key)`, `store.inboxTasks()`,
    `store.spanningTasks()`, `store.allTags()`, `store.COLORS`, `store.PRIORITY_LABELS`
  - 쓰기: `store.addTask()`, `store.updateTask()`, `store.toggleDone()`, `store.removeTask()`,
    `store.reorder()`, `store.moveTask()`, `store.selectDate()`, `store.setAnchorMonth()`,
    `store.setFilter()`, `store.setEditing()`, `store.setSetting()`
  - 구독: `store.subscribe(fn)` → unsubscribe 함수 반환. **팩토리 안에서 반드시 구독하고
    `destroy()` 에서 해제**하세요. 상태가 바뀌면 다시 렌더하면 됩니다.
- `state` 를 **직접 mutate 하지 마세요.** 반드시 액션 함수 경유.

날짜 계산은 `src/renderer/lib/date.js` 유틸만 씁니다 (`toKey/fromKey/monthGrid/addMonths/...`).
`new Date(...)` 로 직접 파싱해서 타임존 사고 내지 마세요.

## CSS 규칙

- 색/반경/그림자는 `base.css` 의 CSS 변수만 사용. 하드코딩 금지 (`store.COLORS` 의 태스크 색은 예외).
- 모든 셀렉터는 자기 네임스페이스 접두사로 시작: 캘린더 `.cal-*`, 투두 `.todo-*`.
- 전역 태그 셀렉터(`div {}`, `button {}`) 금지.
- 라이트 테마는 `:root[data-theme="light"]` 아래에서 변수로 자동 처리됩니다. 필요 시에만 추가 규칙.

## 추가 모듈 계약 (Zone C / Zone D)

```js
// dashboard/dashboard.js — Zone C: D-Day 대시보드 (가로 전체, 하단)
export function createDashboard({ root, store }) { return { destroy() {} }; }

// launcher/launcher.js — Zone D: 퀵 런처 도크 (최하단, 알약 형태)
export function createLauncher({ root, store }) { return { destroy() {} }; }
```

추가된 store API:

- `store.pinnedTasks()` — `pinned:true` + `end` 있는 태스크에 `{remaining, progress, overdue}` 를
  얹어 임박한 순으로 반환. D-Day 대시보드의 데이터 소스.
- `store.ddayInfo(task)` — 단건 계산용.
- `store.togglePinned(id)` — 대시보드 고정 토글.
- `store.launcherItems()` — `LauncherItem[]` (order 순). 모델은 `store.js` JSDoc 참조.
- `store.addLauncherItem(patch)` / `updateLauncherItem(id, patch)` / `removeLauncherItem(id)` /
  `reorderLauncher(ids)`

추가된 IPC — `window.api.launcher`:

```ts
run(item): Promise<{ok:boolean, jobId?:string, error?:string}>   // url 은 jobId 없이 즉시 ok
cancel(jobId): Promise<{ok:boolean, error?:string}>
pick(mode: 'file'|'folder'): Promise<string|null>                // 파일 선택 창, 취소 시 null
onStatus(cb): void   // {jobId, state:'running'|'done'|'error', output?, error?, code?}
```

**실행 대상 검증은 메인 프로세스가 담당합니다.** 렌더러에서 경로를 조립하거나 셸 문자열을
만들지 마세요. 지원 확장자는 `.py .pyw .ps1 .bat .cmd .js .exe` 이며 그 외에는 메인이 거부하고
`{ok:false, error}` 를 돌려줍니다. 이 에러 문구를 사용자에게 그대로 보여주면 됩니다.

## 디자인 시스템 (딥리서치 반영)

글래스모피즘 + 벤토 그리드. 새로 추가된 CSS 변수:

| 변수 | 용도 |
|---|---|
| `--edge` | 바깥 유리 모서리(빛 반사) 1px 테두리. 내부 구분선은 `--border` |
| `--pane` | 벤토 박스(베이스 유리 위 자식 패널) 배경 |
| `--blur` / `--sat-boost` | 백드롭 블러 반경 / 채도 보정 |
| `--shadow` / `--shadow-sm` | 플로팅용 넓고 부드러운 그림자 |
| `--on-color` | 태스크 색 위에 얹는 글자색 |

- **블러는 `var(--blur)` 를 쓰고 직접 px 을 박지 마세요.** 사용자가 끌 수 있어야 합니다
  (`:root[data-blur="off"]` 에서 0 이 됩니다). 자체 블러를 새로 추가하지 마세요 — dwm.exe GPU
  부하 때문에 블러 레이어는 셸의 `.widget` 하나로 제한합니다.
- 라이트/다크 모두 변수로 처리됩니다. 하드코딩 색상 금지.

## 언어

UI 텍스트·주석 전부 **한국어**. 코드 식별자는 영어.

## 드래그 앤 드롭 (두 모듈 공통 프로토콜)

HTML5 DnD 사용. 투두 아이템을 캘린더 날짜 칸에 떨어뜨려 일정 배치가 가능해야 합니다.

- dragstart 시: `e.dataTransfer.setData('application/x-task-id', task.id)`
- 캘린더 날짜 칸은 `dragover` 에서 `preventDefault()`, `drop` 에서 위 키를 읽어
  `store.moveTask(id, dateKey)` 호출.
