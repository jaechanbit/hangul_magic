/* 공공기관 기획서·보고서 AI 프롬프트 빌더 및 응답 파서 (ai.js)
 * - 외부 API 서버로 문서를 전송하지 않는 '쓰시는 AI에 복사·붙여넣기' 중심 설계
 * - 개인정보는 [이름1], [전화1] 등으로 가려진 텍스트만 프롬프트에 포함
 * - '원클릭 직행 모드(질문 생략, 1회 복붙으로 즉시 문서 완성)'와 '역질문 정밀 모드(AI 질문 후 확정)' 모두 지원
 */

let refP = null;

export function refs() {
  if (!refP) {
    refP = Promise.all(['outline', 'style', 'types'].map(n =>
      fetch(new URL('./engine/ref/' + n + '.txt', import.meta.url)).then(r => (r.ok ? r.text() : ''))))
      .then(([outline, style, types]) => ({ outline, style, types }));
    refP.catch(() => { refP = null; });
  }
  return refP;
}

function today() {
  const d = new Date();
  return d.getFullYear() + '. ' + (d.getMonth() + 1) + '. ' + d.getDate() + '.(' + '일월화수목금토'[d.getDay()] + ')';
}

export const DOC_TYPE_GUIDE = {
  auto: '양식의 원래 문서 성격과 사용자의 요청에 가장 알맞은 공공기관 문서 구성으로 작성한다.',
  plan: '공공기관 「사업 기획서 / 추진계획(안)」 형식(추진 배경 및 목적 → 사업 개요 → 세부 추진 계획(일정·역할 표 포함) → 소요 예산 및 산출근거 표 → 기대 효과 및 향후 일정)으로 체계적이고 설득력 있게 작성한다.',
  report: '공공기관 「추진실적 / 결과 보고서」 형식(추진 개요 → 세부 추진 내용 및 회차별 실적 표 → 주요 성과 및 만족도 분석 → 문제점 및 개선 방안 → 향후 계획)으로 실적과 수치가 한눈에 보이게 작성한다.',
  review: '공공기관 「현안 검토 / 대책 보고서」 형식(검토 배경 → 현황 및 문제점 분석 → 대안 검토 및 핵심 추진 대책 → 부서별 협조 사항 및 추진 일정)으로 논리적 인과관계가 드러나게 작성한다.',
  budget: '공공기관 「예산 요구서 / 과업 요약서」 형식(사업 개요 → 추진 필요성 및 법령·지침 근거 → 주요 과업 내용 → 비목별 세부 산출내역 표(단가×물량×회수) → 기대 효과)으로 작성한다.',
  minutes: '공공기관 「회의록 / 간담회 결과 보고」 형식(회의 개요 → 주요 안건 → 참석자 주요 발언 및 논의 요지 → 결정 사항 및 후속 조치 계획 표)으로 작성한다.',
};

const ROLE = `너는 대한민국 정부·지자체·공공기관·대학의 행정 실무에 능통한 '공문서·기획서·보고서 수석 작성관'이다.
사용자가 올린 한글(HWPX) 양식의 디자인(글꼴·제목 상자·표 테두리·여백·머리말)을 100% 그대로 살려 새 한글 문서를 조립하는 '한글 엔진'용 개요(또는 서식 칸 값)를 작성한다.`;

const RULES = `꼭 지킬 행정 문서 작성 원칙
- 개인정보 보호: [이름1] [학번2] [전화3] [메일1] [주소1] [계좌1] [주민번호1] 같은 대괄호 표시는 개인정보 마스킹 토큰이다. 필요한 자리에 토씨 하나 바꾸지 말고 그대로 옮겨 쓰며, 임의로 풀거나 번호를 바꾸지 않는다.
- 사실 기반(Hallucination 금지): 날짜·장소·인원·예산액·실적 수치·만족도·담당부서는 사용자 요청과 참고 자료에 있는 것만 정확히 쓴다. 모르는 값이나 미정인 수치는 지어내지 말고 반드시 '○○'로 비워 둔다(예: 2026. ○○. ○○.(○), ○○명, 금○○○,○○○원, ○○과).
- 참고 자료의 수치·고유명사·세부 사례는 요약하며 누락하지 말고 본문과 표에 빠짐없이 반영한다.
- 줄 머리 기호는 [양식 분석]의 '문단 종류(견본)'에 나온 기호만 사용한다. 들여쓰기 공백은 쓰지 않는다(엔진이 기호에 맞춰 자동 들여쓰기함).
- 문체: 기획서·계획서·보고서·검토서는 간결하고 명확한 행정 개조식(~함, ~임, ~계획, ~필요, ~추진 또는 명사형 종결)으로 쓰고, 공문(시행문)만 서술식(~합니다, ~바랍니다)으로 쓴다.
- 표기법: 행정업무 운영 규정에 따라 날짜는 '2026. 10. 16.(금)', 시각은 '14:00~16:00', 숫자는 아라비아 숫자(세 자리 쉼표)를 기본으로 하되, 양식 고유의 표기법이 있으면 양식을 우선한다.
- 틀 안 글자(표지·문서 상단의 날짜·부서명·기관명 등)는 '@바꾸기: 원본글자 => 새글자' 문법으로만 바뀐다. 바꿀 원본 글자는 [양식 분석]의 '틀 안 글자'를 띄어쓰기까지 그대로 복사한다.
- 분량: 개요 맨 위에 '@쪽수: N'을 적는다(표지가 있으면 표지 제외 본문 쪽 수).
- 사진: 사용자가 올린 사진이 있으면 그 장수만큼 [사진] 칸을 만든다. 양식에 사진 표가 있으면 그 [표 N]을 반복하고, 없으면 [표] 안에 "[사진] | [사진]" 줄과 사진 설명 줄을 번갈아 구성한다.
- 제목이 22자를 넘으면 의미가 자연스럽게 끊기는 곳에 \\n을 넣는다.`;

const QUESTION_RULES = `고르는 질문 정하기
- 문서를 확정하기 전에 사용자에게 물어볼 핵심 질문을 0~4개 정한다. 요청글·참고자료에 이미 있는 내용은 절대 다시 묻지 않는다.
- 우선순위: ① 문서의 핵심인데 빠진 사실(일정·대상·예산 규모 등, "직접 적기" 보기 포함) > ② 목표 분량(원래 양식과 비슷하게(약 N쪽)·핵심만 요약(1쪽)·상세 기획/보고(약 N+2쪽)) > ③ 중점 방향(고르게(추천)·추진배경 및 타당성 강화·세부 실행계획 및 예산표 상세화·성과 및 개선방안 중심).
- 질문마다 보기 2~4개, 가장 적절한 보기 하나에만 "recommended": true를 붙인다. 마지막 보기는 "알아서(미정인 곳은 ○○로 비움)"로 둔다.
- 직접 입력이 필요한 보기는 {"text": "직접 적기", "input": true, "hint": "예: 11. 1.~11. 30., 예산 500만 원"} 형식으로 만든다.`;

const FILL_RULES = `칸 채우기(서식형 양식) 원칙
- 이 양식은 표 칸에 내용을 채우는 서식(신청서·일지·요구서·점검표 등)이다. 문서를 새로 짜지 않고 [칸 목록]의 칸에 값을 넣는다.
- 출력 값은 {"칸 이름": "넣을 글자"} 형식의 JSON 객체 하나다. 칸 이름은 [칸 목록] 맨 앞의 식별자(T2.3.1, P3 등)만 쓴다.
- "(빈칸)"은 비어 있는 입력 칸이고, '←' 뒤는 왼쪽/위쪽 항목명 칸 글자(힌트)다.
- 이미 글자가 있는 칸도 새 문서 시점·내용에 맞게 바꿔야 하면 값을 넣고, 그대로 둘 제목/항목명 칸은 JSON에 포함하지 않는다.
- 칸 안 줄바꿈은 \\n을 쓰고, 사진이 들어갈 칸은 값을 "[사진]"으로 쓴다.
- [제출 문구·서명란 N줄] 표시가 있는 칸은 줄 수를 정확히 N줄로 맞출 때만 수정하고, 아니면 생략한다.
- 칸 끝에 [약 N줄·줄당 M자]가 적힌 고정 크기 칸은 한글에서 페이지 아래가 잘리지 않도록 N줄 이내로 간결하게 작성한다.
- 모르는 값은 지어내지 말고 '○○'를 넣어 사용자가 바로 채울 수 있게 하거나 비워 둔다.`;

const PASTE_TAIL = '\n\n[중요] 채팅 화면에서 복사할 때 줄바꿈이나 기호가 깨지지 않도록, 답변 전체를 반드시 ```text 로 여는 코드 블록 하나에 넣어서 출력하라. 코드 블록 바깥에는 인사말이나 설명을 한 글자도 쓰지 마라.';

function withRoom(slots, room) {
  const lines = (slots || '').trim().split('\n');
  if (!room || !Object.keys(room).length) return lines.join('\n');
  return lines.map(line => {
    const m = line.match(/^(T\d+\.\d+\.\d+)\s+(.*)$/);
    if (!m || !room[m[1]] || /^(\[제출 문구|※)/.test(m[2]) || !/^\(빈칸\)|○|(^|\/\s*)-/.test(m[2])) return line;
    const [n, w] = room[m[1]];
    return `${line}  [약 ${n}줄·줄당 ${w}자]`;
  }).join('\n');
}

function buildContext(c, refsText) {
  const L = [ROLE, '', '오늘 날짜: ' + today()];
  if (c.docType && DOC_TYPE_GUIDE[c.docType]) {
    L.push('문서 작성 방향: ' + DOC_TYPE_GUIDE[c.docType]);
  }
  L.push('', '[양식 분석]', c.analysis.trim());
  if (c.fill) {
    L.push('', '[칸 목록]', withRoom(c.slots, c.room));
  } else {
    L.push('', '[양식 개요] 현재 양식의 구조와 내용을 개요 문법으로 추출한 것', c.outline0.trim());
  }
  if (c.isDefault) {
    L.push('', '(사용자가 별도 양식 파일 대신 공공기관 표준 기본 양식을 선택했다. 문서 성격에 맞게 장·절과 표 구성을 [문서 종류별 표준 구성]에 맞춰 체계적으로 구성한다.)');
  }
  L.push('', '[사용자 작성 요청]', c.request.trim() || '(적지 않음)');
  for (const m of c.mats) {
    L.push('', '[참고·근거 자료: ' + m.name + ']', m.text.trim());
  }
  if (c.photos.length && c.fill && !/사진/.test(c.slots)) {
    L.push('', `[사진] 사용자가 사진 ${c.photos.length}장을 올렸다. 이 서식에는 사진 칸이 없어 앱이 문서 끝에 「붙임 사진」 페이지를 자동 생성해 넣는다. 칸 값에 [사진]을 넣지 마라. 사진 설명 목록:`);
    c.photos.forEach((p, i) => L.push((i + 1) + '. ' + (p || '(설명 없음)')));
  } else if (c.photos.length) {
    L.push('', `[사진] 사용자가 사진 ${c.photos.length}장을 올렸다. 본문 표에 [사진] 칸을 ${c.photos.length}개 만든다. 사진 설명 목록:`);
    c.photos.forEach((p, i) => L.push((i + 1) + '. ' + (p || '(설명 없음)')));
  } else {
    L.push('', '[사진] 올린 사진 없음');
  }
  if (!c.fill) L.push('', '[개요 문법 (반드시 이 문법만 사용)]', refsText.outline.trim());
  L.push('', '[공문서 표기 기준]', refsText.style.trim());
  if (!c.fill) L.push('', '[공공기관 문서 종류별 표준 구성]', refsText.types.trim());
  L.push('', c.fill ? FILL_RULES : RULES);
  return L.join('\n');
}

const FORMAT_ASK_BUILD = `답 형식(이 순서로, 다른 설명 없이)
<questions>
{"doc_kind": "사업 추진계획(안)", "summary": "2026년도 AI 행정혁신 교육 추진계획서를 약 3쪽으로 작성합니다", "questions": [{"id": "q1", "label": "목표 분량", "options": [{"text": "양식과 비슷하게(약 2~3쪽)", "recommended": true}, {"text": "핵심만 1쪽 요약"}, {"text": "상세 기획서(4쪽 이상)"}]}]}
</questions>
<outline>
모든 질문에서 recommended 보기를 골랐다고 가정하고 작성한 완성본 개요 전체(개요 문법 그대로, 설명 없이)
</outline>`;

const FORMAT_ASK_FILL = `답 형식(이 순서로, 다른 설명 없이)
<questions>
{"doc_kind": "서식 칸 채우기", "summary": "요청하신 내용으로 서식 칸을 채웁니다", "questions": []}
</questions>
<values>
모든 질문에서 recommended 보기를 골랐다고 가정하고 작성한 칸 값 JSON 하나
</values>`;

function resultOnlyFormat(c) {
  return c.fill
    ? '답 형식(다른 설명 없이 아래 태그만 출력)\n<values>\n{"칸이름": "채울 값"}\n</values>'
    : '답 형식(다른 설명 없이 아래 태그만 출력)\n<outline>\n@제목: ...\n개요 전체(개요 문법 그대로)\n</outline>';
}

// 1단계 프롬프트 생성 (directMode=true 이면 질문 없이 바로 <outline> 또는 <values> 생성)
export async function firstPrompt(c, directMode = true) {
  const r = await refs();
  if (directMode) {
    return [
      buildContext(c, r),
      '',
      '할 일: 추가 질문 없이 사용자의 요청과 참고 자료를 최대한 반영하여 ' + (c.fill ? '완성된 칸 값 JSON을' : '완성된 기획서·보고서 개요 전체를') + ' 즉시 작성한다. 요청에 없는 수치·일정·담당자는 지어내지 말고 ○○로 비워 둔다.',
      '',
      resultOnlyFormat(c),
    ].join('\n') + PASTE_TAIL;
  }
  return [
    buildContext(c, r),
    '',
    QUESTION_RULES,
    '',
    '할 일: 꼭 필요한 질문(0~4개)을 정하고, 동시에 추천 보기를 기준으로 ' + (c.fill ? '칸 값을' : '개요 전체를') + ' 미리 다 작성한다.',
    '',
    c.fill ? FORMAT_ASK_FILL : FORMAT_ASK_BUILD,
  ].join('\n') + PASTE_TAIL;
}

export async function answerPrompt(c, answers) {
  const r = await refs();
  const lines = answers.map(a => '- ' + a.label + ': ' + a.choice);
  return [
    buildContext(c, r),
    '',
    '[사용자가 선택한 답변] ("알아서"는 합리적으로 구성하되 모르는 사실·수치는 ○○로 비운다는 뜻이다)',
    ...lines,
    '',
    '할 일: 위 답변을 반영해 ' + (c.fill ? '칸 값 JSON 전체를' : '개요 전체를') + ' 작성한다. 추가 질문은 하지 않는다.',
    '',
    resultOnlyFormat(c),
  ].join('\n') + PASTE_TAIL;
}

export async function editPrompt(c, current, wish) {
  const r = await refs();
  return [
    buildContext(c, r),
    '',
    c.fill ? '[현재 칸 값]' : '[현재 개요]',
    current.trim(),
    '',
    '[사용자 수정 지시]',
    wish.trim(),
    '',
    '할 일: 수정 지시 사항만 정확히 반영하여 ' + (c.fill ? '칸 값 JSON 전체를' : '개요 전체를') + ' 다시 출력한다. 수정 지시가 없는 부분은 기존 내용을 그대로 유지한다.',
    '',
    resultOnlyFormat(c),
  ].join('\n') + PASTE_TAIL;
}

// 줄바꿈 소실 감지
export function flatAnswer(t, fill) {
  if (fill) return false;
  const b = grab(t, 'outline');
  const s = (b ? b.body : t).trim();
  const heads = (s.match(/@제목:|@쪽수:|@바꾸기:|\[소제목\d?\]|\[\/?표[\] ]|[◦※□○]/g) || []).length;
  return heads >= 4 && s.split('\n').length < heads / 2;
}

export function cleanPasted(t) {
  let s = String(t || '').replace(/\r\n?/g, '\n').replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\u00a0/g, ' ');
  s = s.replace(/\\([<>])/g, '$1');
  if (!/<(questions|outline|values)>/.test(s) && /&lt;(questions|outline|values)&gt;/.test(s)) {
    s = s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  }
  return s.replace(/\*\*/g, '');
}

function grab(text, tag) {
  const m = text.match(new RegExp('<' + tag + '>([\\s\\S]*?)(</' + tag + '>|$)'));
  return m ? { body: m[1], closed: !!m[2] } : null;
}

function stripFence(s) {
  return s.replace(/^\s*```[a-zA-Z]*[ \t]*\n?/, '').replace(/\n?```\s*$/, '').trim();
}

function parseJson(s) {
  const t = stripFence(s);
  try { return JSON.parse(t); } catch (e) { /* retry */ }
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { /* fail */ }
  }
  return null;
}

function cleanQuestions(q) {
  if (!q || typeof q !== 'object') return null;
  const qs = Array.isArray(q.questions) ? q.questions : [];
  const out = [];
  for (const [i, x] of qs.entries()) {
    if (!x || !Array.isArray(x.options) || !x.options.length) continue;
    const options = x.options.slice(0, 4).map(o => (typeof o === 'string' ? { text: o } : o))
      .filter(o => o && typeof o.text === 'string' && o.text.trim())
      .map(o => ({ text: o.text.trim(), recommended: !!o.recommended, input: !!o.input, hint: typeof o.hint === 'string' ? o.hint : '' }));
    if (!options.length) continue;
    if (!options.some(o => o.recommended)) options[0].recommended = true;
    let seen = false;
    for (const o of options) {
      if (o.recommended && seen) o.recommended = false;
      if (o.recommended) seen = true;
    }
    out.push({ id: String(x.id || 'q' + (i + 1)), label: String(x.label || '질문 ' + (i + 1)).trim(), options });
    if (out.length === 4) break;
  }
  return { kind: typeof q.doc_kind === 'string' ? q.doc_kind : '', summary: typeof q.summary === 'string' ? q.summary : '', questions: out };
}

export function readAnswer(text, fill, final = false) {
  const cleaned = stripFence(text);
  const q = grab(cleaned, 'questions');
  const body = grab(cleaned, fill ? 'values' : 'outline');
  const res = { questions: null, questionsDone: !!(q && q.closed), body: null, bodyDone: !!(body && body.closed) };
  if (q && q.closed) res.questions = cleanQuestions(parseJson(q.body));
  if (body) {
    if (fill) res.body = body.closed || final ? parseJson(body.body) : null;
    else res.body = stripFence(body.body);
  }
  // 태그 없이 바로 개요(@제목:, [소제목], □ 등)나 JSON을 보낸 경우도 유연하게 파싱
  if (!q && !body) {
    if (fill && final) {
      const parsed = parseJson(cleaned);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        res.body = parsed;
        res.bodyDone = true;
      }
    } else if (!fill && (/@제목:|\[소제목\d?\]|^□\s|^○\s|^◦\s/m.test(cleaned))) {
      res.body = cleaned;
      res.bodyDone = true;
    }
  }
  return res;
}
