# GEMINI.md — 공공 한글 기획·보고서 AI 메이커 (`hangul_magic`)

이 문서는 **공공 한글 기획·보고서 AI 메이커** 프로젝트의 아키텍처, 핵심 동작 원리, 개발 규칙 및 현업 보강 로드맵을 정의하는 프로젝트 가이드(컨텍스트) 파일입니다.

---

## 1. 프로젝트 개요

- **프로젝트명**: 공공 한글 기획·보고서 AI 메이커 (`hangul_magic`)
- **배포 주소**: https://jaechanbit.github.io/hangul_magic/
- **저장소**: https://github.com/jaechanbit/hangul_magic
- **로컬 경로**: `C:\Users\bim1\.gemini\antigravity\scratch\gov-hwp-maker`
- **핵심 가치**:
  1. **100% 클라이언트(브라우저) 로컬 처리**: 양식 분석, 개인정보 마스킹, 문서 조립, 미리보기 렌더링이 모두 브라우저 내부(Pyodide + WASM)에서 실행되며 외부 서버로 한글 파일이나 개인정보가 전송되지 않음.
  2. **API 비용 0원 (복사·붙여넣기 워크플로)**: 별도의 유료 API 키 연동 없이, 사용자가 평소 사용하는 상용 AI(ChatGPT, Claude, Gemini, Copilot 등)나 기관 내부 AI에 안전하게 마스킹된 프롬프트를 복사·붙여넣어 문서를 생성.
  3. **원본 한글 양식 디자인 100% 보존**: 기관 고유의 `.hwpx` / `.hwp` 양식(머리글, 표 테두리, 셀 배경색, 글꼴, 여백, 문단 기호 체계)을 그대로 유지한 채 내용만 조립.

---

## 2. 디렉터리 및 파일 구조

```text
gov-hwp-maker/
├── index.html                  # 4단계 공문서 스타일 반응형 UI 및 사용법 영상 모달
├── app.js                      # 프론트엔드 상태 머신(st), Pyodide·rhwp·마스커 연동 및 편집 로직
├── ai.js                       # 공공기관 6대 문서 유형별 프롬프트 빌더 및 AI 응답 파서
├── engine/
│   ├── engine.js               # Pyodide(0.29.5) + lxml(6.0.2) 로더 및 가상 파일시스템 실행 래퍼
│   ├── hwpdoc.py               # HWPX XML 파싱·양식 분석(inspect)·문서 조립(build)·칸 채우기(fill) 핵심 엔진
│   ├── extra.py                # 고정 표 셀 넘침 보정(fit) 및 붙임 사진 대지 생성(photos) 보조 엔진
│   └── ref/
│       ├── outline.txt         # 한글 개요(Outline) 마크업 문법 명세
│       ├── style.txt           # 행정업무 운영 규정(공문서 날짜·시각·숫자·금액 표기법) 기준
│       └── types.txt           # 공공기관 6대 문서 유형별 표준 목차 및 표 구성 가이드
├── lib/
│   ├── masker/core.js          # 개인정보(성명·전화·이메일·주민번호·계좌·주소 등) 탐지·토큰 치환·복원 및 사진 슬롯 처리(HG)
│   └── rhwp/                   # @rhwp/core WASM (.hwp → .hwpx 변환, SVG 미리보기 렌더링, .hwp 내보내기)
├── samples/
│   ├── plan.hwpx.b64.txt            # 내장 양식 1: 공공기관 표준 사업추진계획서
│   ├── standard_report.hwpx.b64.txt # 내장 양식 2: 공공기관 표준 결과보고서
│   ├── review.hwpx.b64.txt          # 내장 양식 3: 공공기관 표준 현안검토보고서
│   ├── budget.hwpx.b64.txt          # 내장 양식 4: 공공기관 표준 예산요구·산출내역서
│   └── minutes.hwpx.b64.txt         # 내장 양식 5: 공공기관 표준 회의록·간담회보고
├── licenses.html               # 오픈소스 라이선스(Pyodide, lxml, @rhwp/core) 고지 페이지
├── howto.mp4 / howto_poster.png     # 한국어 음성 내레이션 포함 사용법 안내 영상 및 썸네일
├── run.bat                     # 로컬 테스트용 서버 실행 스크립트 (http://127.0.0.1:8080)
└── README.md                   # 프로젝트 소개 및 사용 방법 문서
```

---

## 3. 핵심 아키텍처 및 데이터 흐름

### Ⅰ단계: 양식 선택 및 분석 (`useForm`)
1. 사용자가 `.hwpx` 또는 `.hwp` 파일을 업로드하거나 기본 내장 양식을 선택.
2. `.hwp`(CFB 포맷)인 경우 `rhwp` WASM의 `HwpDocument.toHwpx()`로 브라우저에서 즉시 `.hwpx`로 변환.
3. `engine/hwpdoc.py`의 `inspect`, `outline`, `slots` 명령을 실행하여:
   - **문서 조립 모드 (`fill = false`)**: 장·절·문단 기호(`Ⅰ.`, `1.`, `□`, `○`, `-`)와 표 구조를 추출해 `@제목:`, `[소제목]`, `[표]` 문법으로 재작성하는 모드.
   - **서식 칸 채우기 모드 (`fill = true`)**: 신청서·점검표·일지 등 고정된 표 셀(`T2.3.1`, `P3`)에 JSON 키-값으로 데이터를 채워 넣는 모드.

### Ⅱ단계: 기획·보고 내용 입력 및 개인정보 마스킹 (`goStep3`)
1. 6대 문서 유형(`auto`, `plan`, `report`, `review`, `budget`, `minutes`) 및 작성 방식(`direct` 원클릭 직행 / `ask` 역질문 정밀) 선택.
2. 참고 자료 및 첨부 사진 업로드.
3. `lib/masker/core.js`(`HG.scanHwpx`, `HG.scanText`, `HG.applyMask`)를 통해 성명, 연락처, 학번/사번, 이메일, 계좌번호 등을 `[이름1]`, `[전화1]` 토큰으로 가림.
   - 원본 매핑 테이블(`st.frozen.map`)은 브라우저 메모리에만 보관되며 외부로 나가지 않음.

### Ⅲ단계: AI 프롬프트 복사 및 결과 붙여넣기 (`openPasteUI`, `applyPasted`)
1. `ai.js`의 `firstPrompt()`가 양식 구조 + 마스킹된 요청/근거자료 + 행정업무 표기 기준을 결합한 프롬프트 생성.
2. 사용자가 외부 AI에서 받은 응답(`<outline>...</outline>` 또는 `<values>...</values>`)을 붙여넣으면 `cleanPasted()` 및 `readAnswer()`로 파싱.

### Ⅳ단계: 로컬 조립·실시간 편집·다운로드 (`buildAndShow`, `finalize`, `renderResult`)
1. `hwpdoc.py`의 `build` 또는 `fill` 명령으로 `.hwpx` 생성.
2. `HG.restoreFile()`로 `[이름1]` 등 마스킹 토큰을 실제 개인정보로 복원.
3. `extra.py`의 `fit`(고정 셀 크기 맞춤 및 넘침 감지) 및 `photos`(사진 슬롯 매핑 및 대지 추가) 실행 후 `HG.insertPhotos()`로 인쇄 해상도 사진 삽입.
4. 3가지 편집 도구 제공:
   - **① 빈칸(`○○`) 채우기 (`#pane-holes`)**: AI가 지어내지 않고 비워 둔 `○○` 항목이나 미입력 칸을 AI 없이 1초 만에 수정·반영.
   - **② 원문 직접 편집 (`#pane-raw`)**: 개요 마크업 또는 서식 칸 값을 직접 고쳐 즉시 재조립.
   - **③ AI 추가 수정 (`#pane-ai`)**: 수정 지시사항(`#wish`)만 담아 수정 전용 프롬프트(`editPrompt`) 생성.

---

## 4. 코드 작성 및 유지보수 원칙

1. **무서버(Zero-Backend) & 프라이버시 절대 준수**:
   - 외부 API 호출이나 외부 CDN 스크립트 의존성을 추가하지 않는다(폐쇄망·망분리 환경 및 개인정보 보호 고려).
   - 마스킹되지 않은 원문이나 파일 바이너리가 클립보드 프롬프트에 포함되지 않도록 항상 `maskMore()` / `HG.restoreText()` 경계를 검증한다.
2. **행정업무 운영 규정 준수**:
   - 날짜 표기: `YYYY. M. D.(요일)` (예: `2026. 11. 9.(월)`)
   - 시간 표기: `HH:MM` 24시간제 (예: `14:00~16:00`)
   - 금액 표기: 아라비아 숫자 천 단위 쉼표 및 필요 시 한글 병기 (예: `금94,500,000원(금구천사백오십만원)`)
   - 문체: 기획·보고서는 행정 개조식(`~함`, `~임`, `~추진`, 명사형 종결), 시행문(공문)은 서술식(`~합니다`, `~바랍니다`).
3. **바닐라 ES 모듈 구조 유지**:
   - 별도 번들러(Webpack/Vite) 빌드 과정 없이 정적 웹 서버(`python -m http.server` 또는 GitHub Pages)에서 즉시 동작하도록 순수 ES Module 구조를 유지한다.

---

## 5. 현업 실무 보강 과제 (구현 완료 체크리스트)

- [x] **1. 서식 칸 채우기(`fill`) 모드 UX 고도화 (`app.js`, `index.html`)**:
  - `holes()` 및 `slotLabelMap()`에서 `f.slots`의 항목명(`← 라벨` 및 좌측·상단 헤더 셀)을 파싱해 `칸 T2.3.1` 대신 `항목명 (T2.3.1)` 표시 및 미입력 빈칸 셀 포함.
  - `#holes-all` 체크박스로 서식의 전체 입력 칸을 항목명별로 한눈에 펼쳐 편집하는 기능 및 `#raw-editor`에 `"T2.3.1 (항목명)"` 병기 지원.
- [x] **2. 고정 크기 표 셀 넘침(`res.over`) 경고 및 자동 축약 연동 (`app.js`, `index.html`)**:
  - `extra.py fit`에서 감지된 페이지/셀 넘침 경고를 `#over-box` 배너로 표시하고 `#over-fix` 원클릭 AI 축약 지시(`#wish`) 연결.
- [x] **3. 공문서 표기법(행정업무 운영 규정) 원클릭 자동 교정기 (`normalizeGovString`, `#norm-btn`)**:
  - 4단계에서 AI 없이 날짜(`2026-11-09` → `2026. 11. 9.(월)`), 시각(`오후 2시 30분` → `14:30`), 4자리 이상 금액·수치 천 단위 쉼표(`4,800,000원`), 마크다운 기호(`**`)를 1초 만에 교정.
- [x] **4. 내 기관·부서·기안자 기본 프로필 및 작업 자동 임시저장 (`localStorage`)**:
  - `gov_hwp_profile`: 기관명·부서명·담당자·연락처 저장 후 표지/머리말 자동 매핑(개인정보 마스커 연동).
  - `gov_hwp_draft`: 새로고침·재방문 시 `#draft-banner`를 통해 작성 요청 및 완성 문서 즉시 복구.
- [x] **5. 망분리(업무망 ↔ 인터넷망) 환경 지원 (`#paste-dl`, `#paste-file`)**:
  - 클립보드 공유가 제한된 망분리 환경에서 마스킹된 프롬프트 `.txt` 내보내기 및 AI 응답 `.txt` 불러오기 지원.
- [x] **6. 참고·근거 자료 포맷 확장 (`.xlsx`, `.docx`, `.pdf`) 및 공공기관 5대 표준 양식 확충 (`engine/extra.py`, `samples/`)**:
  - `extra.py extract`를 통해 브라우저 로컬에서 엑셀 시트 표, 워드 문서, PDF 텍스트를 직접 추출하여 근거자료로 투입.
  - 5대 표준 양식(`plan`, `standard_report`, `review`, `budget`, `minutes`) 및 `licenses.html` 탑재 완료.
