/* 공공 한글 기획·보고서 AI 메이커 (app.js)
 * - 브라우저 내 Pyodide(hwpdoc.py + extra.py) 및 rhwp WASM 기반 100% 로컬 처리
 * - 쓰시는 AI에 복사·붙여넣기(1회 직행 모드 / 역질문 정밀 모드)
 * - 4단계 실시간 빈칸(○○) 수정 + 개요/칸 원문 직접 편집기 + AI 추가 수정 지원
 */
import { loadEngine, runEngine } from './engine/engine.js';
import { refs, cleanPasted, flatAnswer, firstPrompt, answerPrompt, editPrompt, readAnswer } from './ai.js';

const $ = s => document.querySelector(s);
const ENC = new TextEncoder();
const DEC = new TextDecoder();

function el(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k in e) e[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : String(c));
  return e;
}

function say(box, lines, ok = false) {
  const node = typeof box === 'string' ? $(box) : box;
  if (!node) return;
  node.replaceChildren(...[].concat(lines || []).filter(Boolean).map(t => el('p', { class: ok ? 'ok' : '', text: t })));
}

const doneTimers = new WeakMap();
function doneFor(btn, text, ms = 2400) {
  if (!doneTimers.has(btn)) btn.dataset.label = btn.textContent;
  clearTimeout(doneTimers.get(btn));
  btn.textContent = text;
  btn.classList.add('done');
  doneTimers.set(btn, setTimeout(() => {
    btn.textContent = btn.dataset.label;
    btn.classList.remove('done');
    doneTimers.delete(btn);
  }, ms));
}

const ERR = {
  hwp: n => `「${n}」을(를) 열지 못했습니다. 한글에서 [파일] → [다른 이름으로 저장하기] → 파일 형식 'HWPX 문서(*.hwpx)'로 저장해 올려 주세요.`,
  nothwpx: n => `「${n}」은(는) 한글 파일이 아닙니다. .hwpx 또는 .hwp 파일을 올려 주세요.`,
  locked: n => `「${n}」은(는) 기관 문서보안(DRM)으로 잠긴 파일로 보입니다. 보안을 해제한 일반 한글 파일로 올려 주세요.`,
  broken: n => `「${n}」 파일이 손상되어 열 수 없습니다. 한글에서 다시 저장해 주세요.`,
};
const errText = (e, name) => (e && ERR[e.code] ? ERR[e.code](name) : `「${name}」 처리 중 오류: ${(e && e.message) || e}`.trim());

// 공공기관 실무 5대 예시
const EXAMPLES = [
  {
    dtype: 'plan',
    text: '2026년도 생성형 AI 활용 행정업무 혁신 교육 추진계획(안)을 작성해 주세요.\n- 추진목적: 직원들의 공문서·기획서 작성 시간 단축 및 디지털 행정 역량 강화\n- 기간/장소: 2026. 11. 3.(화) ~ 11. 24.(화) 매주 화요일 14:00~17:00 (총 4회) / 본관 3층 전산교육장\n- 대상/인원: 전 부서 희망 직원 120명 (회차별 30명)\n- 주요내용: 공공분야 AI 보안 가이드라인, 기획서·보고서 구조화 실습, 데이터 분석 실습\n- 소요예산: 총 4,800천 원 (전문강사 수당 300천 원×3시간×4회=3,600천 원, 교재 제작비 10천 원×120부=1,200천 원)',
  },
  {
    dtype: 'report',
    text: '2026년 상반기 청년 취·창업 멘토링 특강 운영 결과보고서를 작성해 주세요.\n- 운영기간: 2026. 9. 15.(화) ~ 10. 6.(화), 총 4회 운영\n- 장소: 시민청년센터 대강당\n- 참여인원: 계획 100명 대비 총 112명 수료 (1회차 직무분석 28명, 2회차 자기소개서 첨삭 30명, 3회차 모의면접 27명, 4회차 현직자 간담회 27명)\n- 만족도 조사: 응답자 105명 기준 평균 4.7점(5점 만점), 실무 면접 피드백이 유익했다는 의견 다수\n- 개선사항 및 향후계획: 실습 시간 확대 건의 반영하여 동계 방학 중 심화 캠프 2기 운영 예정',
  },
  {
    dtype: 'review',
    text: '민원실 대기시간 단축 및 취약계층 방문민원 편의 개선 대책 보고서를 작성해 주세요.\n- 현황 및 문제점: 점심시간 교대 및 월초 민원 집중 시 평균 대기시간이 25분 이상 발생하고, 고령층 민원인의 무인민원발급기(키오스크) 조작 어려움 호소\n- 개선 대책: ① 인공지능 순번대기 알림톡 서비스 도입(대기현황 실시간 안내), ② 어르신·장애인 전담 안내 도우미 2명 배치, ③ 자주 쓰는 민원서식 큰글씨 견본 비치\n- 추진일정: 10월 중 시스템 연동 및 안내인력 배치, 11월 시범운영 후 만족도 점검',
  },
  {
    dtype: 'budget',
    text: '2027년도 노후 행정업무용 전산장비 교체 사업 예산 요구서를 작성해 주세요.\n- 추진근거: 내용연수(5년) 경과 및 보안 패치 종료 장비 적기 교체로 행정업무 연속성 확보\n- 사업기간: 2027. 1. ~ 2027. 3.\n- 총요구액: 금94,500,000원\n- 산출내역: 업무용 데스크톱 PC 50대×1,350,000원=67,500,000원, 27인치 모니터 50대×300,000원=15,000,000원, 문서보안 및 백신 라이선스 50카피×240,000원=12,000,000원',
  },
  {
    dtype: 'minutes',
    text: '2026년 제3차 지역경제 활성화 민·관 합동 간담회 결과 보고서를 작성해 주세요.\n- 일시/장소: 2026. 10. 15.(목) 15:00~16:30 / 본관 2층 중회의실\n- 참석자: 경제진흥과장, 소상공인연합회장, 전통시장 상인회장 등 12명\n- 주요 논의내용: 연말 지역사랑상품권 할인율 상향(7%→10%) 요청, 전통시장 공영주차장 야간 무료개방 시간 연장 건의\n- 결정 및 향후 조치: 11~12월 지역사랑상품권 특별할인 예산 추경 반영 검토(경제정책팀), 공영주차장 무료개방 20시→22시 연장 시행(교통행정과, 11. 1.부터)',
  },
];

// 상태 관리
const st = {
  step: 1,
  form: null,
  docType: 'auto',
  genMode: 'direct', // 'direct' | 'ask'
  mats: [],
  photos: [],
  cands: [],
  manual: [],
  frozen: null,
  promptMode: 'first', // 'first' | 'answer' | 'edit'
  currentPrompt: '',
  qa: null,
  draftBody: null,
  result: null,
  hist: [],
  holes: [],
  busy: false,
};

// 하단 진행 표시줄
let busyTimer = null;
function busyOn(text) {
  $('#busy-text').textContent = text;
  $('#busy').hidden = false;
  const t0 = performance.now();
  clearInterval(busyTimer);
  $('#busy-time').textContent = '0초';
  busyTimer = setInterval(() => {
    $('#busy-time').textContent = Math.round((performance.now() - t0) / 1000) + '초';
  }, 1000);
}
function busyText(text) { $('#busy-text').textContent = text; }
function busyOff() { clearInterval(busyTimer); $('#busy').hidden = true; }

// Pyodide 엔진 초기화
const T0 = performance.now();
const engineP = loadEngine(s => { $('#eng-status').textContent = '⚙️ 한글 조립 엔진 준비 중: ' + s; });
engineP.then(() => {
  $('#eng-status').textContent = `✅ 한글 조립 엔진(Pyodide+lxml) 준비 완료 (${((performance.now() - T0) / 1000).toFixed(1)}초)`;
}, e => {
  $('#eng-status').textContent = '❌ 한글 엔진 로드 실패: ' + (e && e.message);
});
let engQ = Promise.resolve();
function eng(argv, files, outs, mod) {
  const p = engQ.then(() => engineP).then(() => runEngine(argv, files, outs, mod));
  engQ = p.catch(() => {});
  return p;
}

// rhwp WASM 미리보기·변환 엔진 초기화
let rhP = null;
function rhwp() {
  if (!rhP) {
    rhP = (async () => {
      let ctx = null, last = '';
      globalThis.measureTextWidth = (font, text) => {
        if (!ctx) ctx = document.createElement('canvas').getContext('2d');
        if (font !== last) { ctx.font = font; last = font; }
        return ctx.measureText(text).width;
      };
      const rh = await import('./lib/rhwp/rhwp.js');
      await rh.default({ module_or_path: new URL('lib/rhwp/rhwp_bg.wasm', location.href) });
      $('#rhwp-status').textContent = '✅ 미리보기·HWP 변환 엔진(rhwp WASM) 준비 완료';
      return rh;
    })();
    rhP.catch(e => {
      $('#rhwp-status').textContent = '❌ 미리보기 엔진 로드 실패: ' + (e && e.message);
      rhP = null;
    });
  }
  return rhP;
}
const freeDoc = d => { try { if (d && d.free) d.free(); } catch (e) { /* ignore */ } };
const isCfb = u8 => u8[0] === 0xD0 && u8[1] === 0xCF && u8[2] === 0x11 && u8[3] === 0xE0;

async function pagesOf(bytes, max = 40) {
  const rh = await rhwp();
  const d = new rh.HwpDocument(bytes);
  try {
    const n = d.pageCount();
    const urls = [];
    for (let i = 0; i < Math.min(n, max); i++) {
      urls.push(URL.createObjectURL(new Blob([d.renderPageSvg(i)], { type: 'image/svg+xml' })));
    }
    return { n, urls };
  } finally {
    freeDoc(d);
  }
}

// 단계 이동
function go(n) {
  st.step = n;
  for (const s of document.querySelectorAll('section[data-step]')) {
    s.hidden = Number(s.dataset.step) !== n;
  }
  for (const li of document.querySelectorAll('#steps li')) {
    const k = Number(li.dataset.n);
    li.className = k === n ? 'now' : (k < n ? 'done' : '');
    li.querySelector('button').disabled = !(k < n);
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

for (const li of document.querySelectorAll('#steps li')) {
  li.querySelector('button').addEventListener('click', () => {
    const k = Number(li.dataset.n);
    if (k < st.step && !st.busy) go(k);
  });
}

// ==================== 1단계: 양식 로드 및 분석 ====================
function b64bytes(t) {
  const bin = atob(t.replace(/\s+/g, ''));
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

const sampleCache = {};
async function loadSample(file) {
  if (!sampleCache[file]) {
    sampleCache[file] = fetch('samples/' + file).then(r => r.text()).then(b64bytes);
  }
  return sampleCache[file];
}

$('#f-input').addEventListener('change', async () => {
  const f = $('#f-input').files[0];
  $('#f-input').value = '';
  if (f) await useForm(f.name, new Uint8Array(await f.arrayBuffer()), false);
});

$('#f-preset-plan').addEventListener('click', async () => {
  st.docType = 'plan';
  syncDocTypeChips();
  await useForm('공공기관_표준_사업추진계획서.hwpx', await loadSample('plan.hwpx.b64.txt'), true);
});

$('#f-preset-report').addEventListener('click', async () => {
  st.docType = 'report';
  syncDocTypeChips();
  await useForm('공공기관_표준_결과보고서.hwpx', await loadSample('standard_report.hwpx.b64.txt'), true);
});

// 드래그 앤 드롭 지원
addEventListener('dragover', e => {
  if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) {
    e.preventDefault();
    document.body.classList.add('dragging');
  }
});
addEventListener('dragleave', e => {
  if (e.relatedTarget === null) document.body.classList.remove('dragging');
});
addEventListener('drop', async e => {
  if (!e.dataTransfer || !e.dataTransfer.files.length) return;
  e.preventDefault();
  document.body.classList.remove('dragging');
  if (st.busy) return;
  const fs = [...e.dataTransfer.files];
  if (st.step === 1) {
    const f = fs[0];
    await useForm(f.name, new Uint8Array(await f.arrayBuffer()), false);
  } else if (st.step === 2) {
    const imgs = fs.filter(isImage);
    const mats = fs.filter(f => !isImage(f) && /\.(hwpx|hwp|txt|md|csv)$/i.test(f.name));
    if (mats.length) await handleMats(mats);
    if (imgs.length) await handlePhotos(imgs);
  }
});

async function showSheet(bytes, cap) {
  const sheet = $('#f-sheet');
  sheet.replaceChildren(el('span', { class: 'wait', text: '양식 첫 쪽 미리보기를 렌더링하는 중...' }));
  try {
    const { n, urls } = await pagesOf(bytes, 1);
    sheet.replaceChildren(el('img', { src: urls[0], alt: '양식 첫 쪽 미리보기' }));
    $('#f-cap').textContent = cap + (n > 1 ? ` (총 ${n}쪽)` : ' (1쪽)');
    return n;
  } catch (e) {
    sheet.replaceChildren(el('span', { class: 'wait', text: '미리보기를 렌더링하지 못했습니다.' }));
    return 0;
  }
}

function cleanLog(log) {
  const m = (log || '').match(/\[안내\]\s*(.+)/);
  return m ? m[1] : '';
}

async function analyze(maskedBytes, wantSlots) {
  const r = await eng(['analyze', '/w/f.hwpx', '-o', '/w/o.txt'], { 'f.hwpx': maskedBytes }, ['o.txt']);
  if (r.code !== 0 || !r.files['o.txt']) throw new Error(cleanLog(r.log) || '양식을 분석하지 못했습니다.');
  const analysis = r.log.split(/\n- 개요 파일:/)[0].trim();
  const fill = /서식형 문서입니다/.test(analysis);
  let slots = '';
  const cover = {}, room = {};
  if (wantSlots === undefined ? fill : wantSlots) {
    slots = (await eng(['slots', '/w/f.hwpx'], { 'f.hwpx': maskedBytes }, [])).log;
    const cv = await eng(['cover', '/w/f.hwpx'], { 'f.hwpx': maskedBytes }, [], 'extra');
    if (cv.code === 0) {
      for (const line of cv.log.split('\n')) {
        const [k, n, text] = line.split('\t');
        if (!text || !/^T\d+\.\d+\.\d+$/.test(k)) continue;
        cover[k] = +n;
        slots = slots.replace(new RegExp('^' + k.replace(/\./g, '\\.') + ' .*$', 'm'), (k + ' ').padEnd(11) + `[제출 문구·서명란 ${n}줄] ` + text);
      }
    }
    const rm = await eng(['room', '/w/f.hwpx'], { 'f.hwpx': maskedBytes }, [], 'extra');
    if (rm.code === 0) {
      for (const line of rm.log.split('\n')) {
        const [k, n, w] = line.split('\t');
        if (/^T\d+\.\d+\.\d+$/.test(k) && +n > 0 && +w > 0) room[k] = [+n, +w];
      }
    }
  }
  return { analysis, outline0: DEC.decode(r.files['o.txt']), fill, slots, cover, room };
}

async function useForm(name, bytes, isDefault) {
  if (st.busy) return;
  st.busy = true;
  say('#f-msg', []);
  $('#f-facts').hidden = true;
  $('#to2-row').hidden = true;
  busyOn('한글 양식을 읽고 구조를 분석하는 중...');
  try {
    let hwpx = bytes, fromHwp = false;
    if (isCfb(bytes)) {
      busyText('구형 한글 파일(.hwp)을 HWPX 구조로 변환하는 중...');
      const rh = await rhwp();
      let d;
      try { d = new rh.HwpDocument(bytes); } catch (e) { throw { code: 'hwp' }; }
      try { hwpx = d.exportHwpx(); } catch (e) { throw { code: 'hwp' }; } finally { freeDoc(d); }
      fromHwp = true;
    }
    const docName = name.replace(/\.hwp$/i, '.hwpx');
    const doc = await HG.openHwpx(docName, hwpx);
    const slots = await HG.photoSlots(doc);
    st.form = {
      name: docName,
      bytes: hwpx,
      doc,
      fromHwp,
      isDefault,
      photoSlots: slots.length,
      slotHints: slots.map(x => (x.hint || '').replace(/\s+/g, ' ').trim().slice(0, 30)),
      slotRatios: slots.map(x => (x.w > 0 && x.h > 0 ? Math.min(2, Math.max(0.5, x.w / x.h)) : 4 / 3)),
    };
    redetect();
    const pages = await showSheet(hwpx, isDefault ? '선택한 표준 양식 · ' + name : '업로드한 양식 · ' + name);
    busyText('양식의 문단·표·제목상자 스타일을 추출하는 중...');
    const { on } = HG.assignTokens(st.cands);
    const masked = on.length ? (await HG.maskFile(doc, on)).bytes : hwpx;
    const an = await analyze(masked);
    st.form.info = an;
    st.form.mode = an.fill ? 'fill' : 'build';
    st.form.pages = pages;
    renderFacts();
    $('#to2-row').hidden = false;
  } catch (e) {
    st.form = null;
    say('#f-msg', errText(e, name));
  } finally {
    st.busy = false;
    busyOff();
  }
}

function renderFacts() {
  if (!st.form) return;
  const f = st.form, a = f.info.analysis;
  const pick = re => { const m = a.match(re); return m ? m[1] : ''; };
  const title = pick(/- 제목: "([^"]*)"/);
  const amount = pick(/- 분량: ([^\n]+)/).replace(/\(어림\)/, '').trim();
  const tables = pick(/표 (\d+)개/);
  const rows = [];
  rows.push(['양식 파일', f.name + (f.fromHwp ? ' (.hwp → .hwpx 자동 변환됨)' : '')]);
  if (title) rows.push(['감지된 제목', HG.restoreText(title, HG.assignTokens(st.cands).map).text]);
  rows.push(['구조 요약', [amount, tables && tables !== '0' ? `표 ${tables}개` : '', f.photoSlots ? `사진 칸 ${f.photoSlots}곳` : ''].filter(Boolean).join(' · ')]);
  const fillMode = f.mode === 'fill';
  rows.push(['작성 방식', [
    fillMode ? '서식 칸 채우기 모드 (표 양식 유지)' : '본문 재구성 모드 (기획서·보고서·계획서)',
    ' ',
    el('button', {
      type: 'button',
      class: 'link',
      text: fillMode ? '[본문 재구성 모드로 전환]' : '[서식 칸 채우기 모드로 전환]',
      onclick: () => { f.mode = fillMode ? 'build' : 'fill'; renderFacts(); },
    }),
  ]]);
  const n = piCount();
  rows.push(['개인정보 보호', n.kinds ? `양식 내 ${n.total}곳 감지됨 → AI 전송 전 [이름1] 등으로 자동 마스킹` : '감지된 개인정보 없음 (2단계에서 추가 가능)']);
  $('#f-facts').replaceChildren(...rows.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', null, v)]));
  $('#f-facts').hidden = false;
}

$('#to2').addEventListener('click', () => {
  if (!st.form) return;
  go(2);
  renderPhotos();
  renderSend();
});
$('#back1').addEventListener('click', () => go(1));
$('#back2').addEventListener('click', () => go(2));

// ==================== 2단계: 문서 유형 · 요청 · 자료 · 사진 · 개인정보 ====================
function syncDocTypeChips() {
  for (const b of document.querySelectorAll('#doc-type-chips .chip')) {
    b.classList.toggle('active', b.dataset.dtype === st.docType);
  }
}
for (const b of document.querySelectorAll('#doc-type-chips .chip')) {
  b.addEventListener('click', () => {
    st.docType = b.dataset.dtype;
    syncDocTypeChips();
  });
}

document.querySelectorAll('input[name="genmode"]').forEach(r => {
  r.addEventListener('change', () => {
    if (r.checked) st.genMode = r.value;
  });
});

for (const b of document.querySelectorAll('[data-ex]')) {
  b.addEventListener('click', () => {
    const ex = EXAMPLES[Number(b.dataset.ex)];
    if (!ex) return;
    $('#req').value = ex.text;
    st.docType = ex.dtype;
    syncDocTypeChips();
    redetect();
    renderSend();
    say('#s2-msg', []);
  });
}

let reqTimer = null;
function redetectSoon() {
  clearTimeout(reqTimer);
  reqTimer = setTimeout(() => { redetect(); renderSend(); }, 350);
}
$('#req').addEventListener('input', redetectSoon);

// 참고 자료 처리
const MAT_MAX = 30000, MAT_TOTAL = 60000;
function decodeText(u8) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(u8).replace(/^\uFEFF/, ''); } catch (e) { /* fallback */ }
  try { return new TextDecoder('euc-kr').decode(u8); } catch (e) { return DEC.decode(u8); }
}

$('#m-input').addEventListener('change', async () => {
  const fs = [...$('#m-input').files];
  $('#m-input').value = '';
  if (fs.length) await handleMats(fs);
});

async function handleMats(fs) {
  const errs = [];
  busyOn('참고 자료에서 텍스트를 추출하는 중...');
  try {
    for (const f of fs) {
      if (st.mats.some(m => m.name === f.name)) continue;
      const u8 = new Uint8Array(await f.arrayBuffer());
      let text = '';
      if (/\.(hwpx|hwp)$/i.test(f.name)) {
        const ext = /\.hwp$/i.test(f.name) ? '.hwp' : '.hwpx';
        const r = await eng(['text', '/w/m' + ext], { ['m' + ext]: u8 }, []);
        if (r.code !== 0) { errs.push(`「${f.name}」 텍스트 추출 실패: ${cleanLog(r.log)}`); continue; }
        text = r.log;
      } else {
        text = decodeText(u8);
      }
      text = text.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      if (!text) { errs.push(`「${f.name}」에 읽을 수 있는 텍스트가 없습니다.`); continue; }
      const used = st.mats.reduce((a, m) => a + m.text.length, 0);
      const room = Math.max(0, Math.min(MAT_MAX, MAT_TOTAL - used));
      if (!room) { errs.push(`참고 자료 용량 한도 초과로 「${f.name}」은(는) 제외되었습니다.`); continue; }
      st.mats.push({ name: f.name, text: text.slice(0, room), cut: text.length > room });
    }
  } finally {
    busyOff();
  }
  say('#m-msg', errs);
  renderMats();
  redetect();
  renderSend();
}

function renderMats() {
  $('#m-list').replaceChildren(...st.mats.map(m => el('li', null,
    el('span', { text: `📄 ${m.name} (${m.text.length.toLocaleString()}자${m.cut ? ', 앞부분 발췌' : ''})` }),
    el('button', {
      type: 'button',
      class: 'link',
      text: '제외',
      onclick: () => {
        st.mats = st.mats.filter(x => x !== m);
        renderMats();
        redetect();
        renderSend();
      },
    }),
  )));
}

// 사진 처리
const IMG_EXT = /\.(jpe?g|png|gif|bmp|webp|avif)$/i;
const isImage = f => /^image\//.test(f.type || '') || IMG_EXT.test(f.name);
const COVER_TOP = 0.25;

async function decodeImage(file) {
  try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch (e) { return await createImageBitmap(file); }
}

async function readPhotos(fs) {
  const list = [], errs = [];
  const sorted = [...fs].filter(isImage).sort((a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true }));
  for (const f of sorted) {
    try {
      const b = await decodeImage(f);
      if (b.close) b.close();
      list.push({ file: f, url: URL.createObjectURL(f), caption: '' });
    } catch (e) {
      errs.push(`「${f.name}」 이미지를 읽을 수 없습니다 (JPG·PNG 권장).`);
    }
  }
  return { list, errs };
}

$('#p-input').addEventListener('change', async () => {
  const fs = [...$('#p-input').files];
  $('#p-input').value = '';
  if (fs.length) await handlePhotos(fs);
});

async function handlePhotos(fs) {
  const { list, errs } = await readPhotos(fs);
  st.photos.push(...list);
  say('#p-msg', errs);
  renderPhotos();
  renderSend();
}

const slotHint = i => (st.form && st.form.slotHints && st.form.slotHints[i]) || '';
const slotRatio = i => {
  const r = st.form && st.form.slotRatios;
  return r && r.length ? r[Math.min(i, r.length - 1)] : 4 / 3;
};

function renderPhotos() {
  $('#p-list').replaceChildren(...st.photos.map((p, i) => {
    const cap = el('input', {
      type: 'text',
      value: p.caption,
      placeholder: slotHint(i) ? '사진 설명 예: ' + slotHint(i) : '사진 설명 (선택)',
    });
    cap.addEventListener('input', () => { p.caption = cap.value; redetectSoon(); });
    return el('li', null,
      el('div', { class: 'ph', style: '--ar:' + slotRatio(i) },
        el('img', { src: p.url, alt: (i + 1) + '번 사진' }),
        el('span', { class: 'num', text: String(i + 1) }),
      ),
      cap,
      el('div', { class: 'ctl' },
        el('button', {
          type: 'button',
          class: 'link',
          text: '삭제',
          onclick: () => {
            URL.revokeObjectURL(p.url);
            st.photos.splice(i, 1);
            renderPhotos();
            renderSend();
          },
        }),
      ),
    );
  }));

  const total = st.form ? st.form.photoSlots || 0 : 0;
  const PIC = '<svg aria-hidden="true"><use href="#ic-photo-add"/></svg>';
  const slots = [];
  for (let i = st.photos.length; i < total; i++) {
    const lb = el('label', { class: 'slot', for: 'p-input', style: '--ar:' + slotRatio(i) });
    lb.innerHTML = PIC;
    lb.prepend(el('span', { class: 'num', text: String(i + 1) }));
    slots.push(el('li', null, lb, el('span', { class: 'slot-cap', text: slotHint(i) || `사진 칸 ${i + 1}` })));
  }
  if (st.photos.length >= total) {
    const lb = el('label', { class: 'slot', for: 'p-input', style: '--ar:' + slotRatio(st.photos.length) });
    lb.innerHTML = PIC;
    slots.push(el('li', null, lb, el('span', { class: 'slot-cap', text: '+ 사진 추가하기' })));
  }
  $('#p-empty').replaceChildren(...slots);
}

// 개인정보 마스킹
function allTexts() {
  return [$('#req').value, ...st.mats.map(m => m.text), ...st.mats.map(m => m.name), ...st.photos.map(p => p.caption)].filter(t => t && t.trim());
}
function redetect() {
  const files = st.form ? [st.form.doc] : [];
  const texts = allTexts();
  const prev = new Map(st.cands.map(c => [c.value, c.on]));
  let list = HG.detect(files, texts);
  for (const m of st.manual) list = HG.addManual(list, files, texts, [m], 'auto');
  for (const c of list) if (prev.has(c.value)) c.on = prev.get(c.value);
  st.cands = list;
  renderPI();
}
function piCount() {
  const on = st.cands.filter(c => c.on && c.count > 0);
  return { kinds: on.length, total: on.reduce((a, c) => a + c.count, 0) };
}
function renderPI() {
  const shown = st.cands.filter(c => c.count > 0).sort((a, b) => a.first - b.first);
  const n = piCount();
  $('#pi-n').textContent = n.kinds ? `${n.kinds}종 · 총 ${n.total}곳 마스킹` : '없음';
  $('#pi-list').replaceChildren(...shown.map(c => {
    const box = el('input', { type: 'checkbox', checked: c.on });
    box.addEventListener('change', () => { c.on = box.checked; renderPI(); renderSend(); });
    return el('li', { class: c.on ? '' : 'off' }, el('label', null,
      box,
      el('span', { text: (HG.KIND[c.kind] || {}).label || '기타' }),
      el('mark', { text: c.value }),
      el('span', { class: 'opt', text: `${c.count}곳` }),
    ));
  }));
}

function addManual(raw) {
  const words = String(raw ?? $('#pi-add').value).split(/[,，、\n\r\t]+/).map(w => w.trim()).filter(w => w.length >= 2);
  if (!words.length) return;
  for (const w of words) if (!st.manual.includes(w)) st.manual.push(w);
  $('#pi-add').value = '';
  redetect();
  renderSend();
}
$('#pi-add-btn').addEventListener('click', () => addManual());
$('#pi-add').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addManual(); } });

function renderSend() {
  if (!st.form) return;
  const { on } = HG.assignTokens(st.cands);
  const mask = t => HG.maskText(t || '', on);
  const L = ['[사용자 작성 요청]', mask($('#req').value).trim() || '(아직 입력하지 않음)'];
  for (const m of st.mats) L.push('', `[참고 자료: ${mask(m.name)}]`, mask(m.text).slice(0, 500) + (m.text.length > 500 ? ' …' : ''));
  if (st.photos.length) L.push('', `[첨부 사진] 총 ${st.photos.length}장 (이미지 파일은 로컬 보관, 설명만 전달)`, ...st.photos.map((p, i) => `${i + 1}. ${mask(p.caption) || '(설명 없음)'}`));
  L.push('', '[양식 내 텍스트 마스킹 미리보기]', ...HG.previewMasked(st.form.doc, on, 10));
  $('#send-pre').textContent = L.join('\n');
  renderFacts();
}

// ==================== 3단계: 프롬프트 생성 및 AI 복붙 처리 ====================
async function freeze() {
  const { on, map } = HG.assignTokens(st.cands);
  const formBytes = on.length ? (await HG.maskFile(st.form.doc, on)).bytes : st.form.bytes;
  const fill = st.form.mode === 'fill';
  const an = await analyze(formBytes, fill);
  const analysis = fill ? an.analysis : an.analysis.split('\n').filter(l => !/서식형 문서입니다/.test(l)).join('\n');
  const mask = t => HG.maskText(t || '', on);
  st.frozen = {
    on: on.slice(),
    map: Object.assign({}, map),
    formBytes,
    analysis,
    outline0: an.outline0,
    slots: an.slots,
    cover: an.cover || {},
    room: an.room || {},
    fill,
    docType: st.docType,
    request: mask($('#req').value),
    mats: st.mats.map(m => ({ name: mask(m.name), text: mask(m.text) })),
    photoCaps: st.photos.map(p => mask(p.caption.trim())),
  };
}

function maskMore(texts) {
  const f = st.frozen;
  const known = new Set(Object.values(f.map));
  const fresh = HG.detect([], texts.filter(t => t && t.trim())).filter(c => c.on && c.count > 0 && !known.has(c.value));
  if (fresh.length) {
    const used = {};
    for (const t of Object.keys(f.map)) {
      const m = t.match(/^\[(\D+?)(\d+)\]$/);
      if (m) used[m[1]] = Math.max(used[m[1]] || 0, Number(m[2]));
    }
    for (const c of fresh) {
      const tok = HG.KIND[c.kind].tok;
      used[tok] = (used[tok] || 0) + 1;
      c.token = '[' + tok + used[tok] + ']';
      f.map[c.token] = c.value;
      f.on.push(c);
    }
  }
  return t => HG.maskText(t || '', f.on);
}

function aiCtx() {
  const f = st.frozen;
  return {
    docType: f.docType,
    analysis: f.analysis,
    outline0: f.outline0,
    slots: f.slots,
    room: f.room || {},
    fill: f.fill,
    isDefault: st.form.isDefault,
    request: f.request,
    mats: f.mats,
    photos: f.photoCaps,
  };
}

function setPasteStep(n) {
  [1, 2, 3].forEach(k => {
    const li = $('#ps-' + k);
    li.classList.toggle('done', k < n);
    li.classList.toggle('now', k === n);
  });
}

function openPasteUI(prompt, mode) {
  st.promptMode = mode;
  st.currentPrompt = prompt;
  $('#paste-pre').textContent = prompt;
  $('#paste-count').textContent = `프롬프트 길이: ${prompt.length.toLocaleString()}자 (개인정보 마스킹 완료)`;
  $('#paste-in').value = '';
  $('#paste-box').hidden = false;
  $('#qa-box').hidden = true;
  say('#paste-msg', []);
  say('#s3-msg', []);
  setPasteStep(1);
  go(3);
}

$('#to3').addEventListener('click', async () => {
  if (st.busy) return;
  clearTimeout(reqTimer);
  redetect();
  renderSend();
  if (!$('#req').value.trim()) {
    say('#s2-msg', '무엇을 작성할지 핵심 내용을 적어 주시거나, 아래 실무 예시 버튼을 눌러 보세요.');
    $('#req').focus();
    return;
  }
  say('#s2-msg', []);
  st.busy = true;
  busyOn('개인정보를 마스킹하고 AI 맞춤형 프롬프트를 생성하는 중...');
  try {
    await freeze();
    const direct = st.genMode === 'direct';
    const prompt = await firstPrompt(aiCtx(), direct);
    openPasteUI(prompt, 'first');
  } catch (e) {
    say('#s2-msg', String((e && e.message) || e));
  } finally {
    st.busy = false;
    busyOff();
  }
});

$('#paste-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(st.currentPrompt);
    say('#paste-msg', '✅ 클립보드에 복사되었습니다! 이제 2단계의 AI 새 대화창에 붙여넣고(Ctrl+V) 전송하세요.', true);
    doneFor($('#paste-copy'), '복사 완료 ✓');
    setPasteStep(2);
  } catch (e) {
    $('#paste-show').open = true;
    say('#paste-msg', '프롬프트 원문을 펼쳐 두었습니다. 전체 선택 후 Ctrl+C로 복사해 주세요.', true);
  }
});

// 다른 탭(ChatGPT/Claude/Gemini)에 갔다가 돌아오면 3번 입력창으로 자동 포커스
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && st.step === 3 && !$('#paste-box').hidden && $('#ps-2').classList.contains('now')) {
    setPasteStep(3);
    $('#paste-in').focus();
  }
});

$('#paste-in').addEventListener('input', () => {
  if ($('#paste-in').value.trim()) setPasteStep(3);
});

$('#paste-ok').addEventListener('click', async () => {
  if (st.busy) return;
  const raw = cleanPasted($('#paste-in').value);
  if (!raw.trim()) {
    say('#paste-msg', 'AI가 출력한 답변을 3번 입력창에 붙여넣어 주세요.');
    $('#paste-in').focus();
    return;
  }
  const fill = !!(st.frozen && st.frozen.fill);
  if (flatAnswer(raw, fill)) {
    say('#paste-msg', [
      '⚠️ 줄바꿈이 모두 사라진 채로 복사되었습니다.',
      'AI 답변의 코드 상자 우측 상단에 있는 [복사(Copy)] 아이콘을 눌러 복사해 주세요.',
    ]);
    return;
  }
  const r = readAnswer(raw, fill, true);
  const hasBody = fill ? (r.body && typeof r.body === 'object') : (r.body && String(r.body).trim());
  const hasQuestions = !!(r.questions && r.questions.questions && r.questions.questions.length);

  if (!hasBody && !hasQuestions) {
    say('#paste-msg', [
      '⚠️ AI 답변에서 문서 개요(<outline>) 또는 서식 값(<values>)을 찾지 못했습니다.',
      'AI 답변을 처음부터 끝까지 모두 복사했는지 확인해 주세요.',
    ]);
    return;
  }

  // 역질문 모드에서 질문이 함께 온 경우
  if (st.promptMode === 'first' && st.genMode === 'ask' && hasQuestions) {
    st.qa = r.questions;
    st.draftBody = hasBody ? r.body : null;
    renderQuestions(st.qa, !!st.draftBody);
    $('#paste-box').hidden = true;
    $('#qa-box').hidden = false;
    return;
  }

  if (!hasBody) {
    say('#paste-msg', '문서 본문 데이터가 비어 있습니다. AI 답변 전체를 다시 복사해 넣어 주세요.');
    return;
  }

  const keepHistory = st.promptMode === 'edit';
  await buildAndShow(r.body, keepHistory);
});

function renderQuestions(q, hasDraft) {
  $('#q-summary').textContent = q.summary || 'AI가 문서를 더 정확히 작성하기 위해 몇 가지 항목을 물어보았습니다.';
  $('#q-form').replaceChildren(...q.questions.map((x, i) => {
    const fs = el('fieldset', { class: 'q' }, el('legend', { text: `${i + 1}. ${x.label}` }));
    x.options.forEach((o, j) => {
      const id = `q${i}o${j}`;
      const radio = el('input', { type: 'radio', name: 'q' + i, id, value: String(j), checked: o.recommended });
      fs.append(el('label', { class: 'opt-row', for: id },
        radio,
        el('span', { text: o.text }),
        o.recommended ? el('span', { class: 'rec', text: '(추천)' }) : null,
      ));
      if (o.input) {
        const inp = el('input', { type: 'text', class: 'opt-in', id: id + 'in', placeholder: o.hint || '직접 입력해 주세요' });
        inp.addEventListener('input', () => { if (inp.value.trim()) radio.checked = true; });
        fs.append(inp);
      }
    });
    return fs;
  }));
  $('#make-rec').hidden = !hasDraft;
}

function collectAnswers() {
  return (st.qa ? st.qa.questions : []).map((x, i) => {
    const sel = document.querySelector(`input[name="q${i}"]:checked`);
    const j = sel ? Number(sel.value) : Math.max(0, x.options.findIndex(o => o.recommended));
    const o = x.options[j];
    let choice = o.text, typed = '';
    if (o.input) {
      typed = ((document.getElementById(`q${i}o${j}in`) || {}).value || '').trim();
      choice = typed || '알아서';
    }
    return { label: x.label, choice, isRec: o.recommended && !typed };
  });
}

$('#make-rec').addEventListener('click', async () => {
  if (!st.draftBody || st.busy) return;
  await buildAndShow(st.draftBody, false);
});

$('#make-custom').addEventListener('click', async () => {
  if (st.busy) return;
  const answers = collectAnswers();
  const mask = maskMore(answers.map(a => a.choice));
  const prompt = await answerPrompt(aiCtx(), answers.map(a => ({ label: a.label, choice: mask(a.choice) })));
  openPasteUI(prompt, 'answer');
});

// ==================== 4단계: 문서 조립 · 후처리 · 미리보기 ====================
const PHOTO_VAL = /^\s*\[\s*사진\s*\d*\s*\]\s*$/;
const PHOTO_TOKEN = /\[\s*사진\s*\d*\s*\]\s*/g;
const dropPhotoTokens = v => String(v).split('\n')
  .filter(l => !(/\[\s*사진\s*\d*\s*\]/.test(l) && /^[\s\-–·•○◦▪*]*$/.test(l.replace(PHOTO_TOKEN, ''))))
  .map(l => l.replace(PHOTO_TOKEN, '')).join('\n');

function safeBody(body) {
  const f = st.frozen;
  if (!f.fill || !body || typeof body !== 'object') return body;
  const ok = new Set();
  for (const line of f.slots.split('\n')) {
    const m = line.match(/^(T\d+\.\d+\.\d+|P\d+)\s+(.*)$/);
    if (m && /사진/.test(m[2])) ok.add(m[1]);
  }
  const cover = f.cover || {};
  const lines = v => String(v ?? '').split('\n').filter(x => x.trim()).length;
  const out = {};
  for (let [k, v] of Object.entries(body)) {
    if (!ok.has(k) && PHOTO_VAL.test(String(v ?? ''))) continue;
    if (cover[k] && lines(v) !== cover[k]) continue;
    if (!ok.has(k) && typeof v === 'string' && /\[\s*사진\s*\d*\s*\]/.test(v)) v = dropPhotoTokens(v);
    out[k] = v;
  }
  return out;
}

async function buildOnce(body) {
  const f = st.frozen;
  body = safeBody(body);
  const r = f.fill
    ? await eng(['fill', '/w/f.hwpx', '/w/v.json', '-o', '/w/r.hwpx'], { 'f.hwpx': f.formBytes, 'v.json': ENC.encode(JSON.stringify(body)) }, ['r.hwpx'])
    : await eng(['build', '/w/f.hwpx', '/w/o.txt', '-o', '/w/r.hwpx'], { 'f.hwpx': f.formBytes, 'o.txt': ENC.encode(String(body)) }, ['r.hwpx']);
  return { code: r.code, log: r.log, bytes: r.code === 0 ? r.files['r.hwpx'] : null, body };
}

function keepPrev() {
  if (!st.result) return;
  st.hist.push({ body: st.result.body, built: st.result.built, log: st.result.log });
  if (st.hist.length > 5) st.hist.shift();
  $('#undo-row').hidden = false;
}

async function buildAndShow(body, keep = false) {
  st.busy = true;
  busyOn('양식 디자인에 맞춰 한글(.hwpx) 문서를 조립하는 중...');
  try {
    const r = await buildOnce(body);
    if (!r.bytes) throw new Error('문서 조립 실패: ' + (cleanLog(r.log) || '개요 형식을 확인해 주세요.'));
    if (keep) keepPrev();
    st.result = { body: r.body, built: r.bytes, log: r.log };
    await finalize();
    go(4);
  } catch (e) {
    say(st.step === 3 ? '#s3-msg' : '#get-msg', String((e && e.message) || e));
  } finally {
    st.busy = false;
    busyOff();
  }
}

async function photoBytes(p, s) {
  const bmp = await decodeImage(p.file);
  try {
    let sx = 0, sy = 0, sw = bmp.width, sh = bmp.height;
    const a = s.w / s.h;
    if (sw / sh > a) { const w = Math.round(sh * a); sx = Math.round((sw - w) / 2); sw = w; }
    else { const h = Math.round(sw / a); sy = Math.round((sh - h) * COVER_TOP); sh = h; }
    const k = Math.min(1, s.w / 24 / sw, s.h / 24 / sh);
    const ow = Math.max(1, Math.round(sw * k)), oh = Math.max(1, Math.round(sh * k));
    const cv = document.createElement('canvas');
    cv.width = ow;
    cv.height = oh;
    const cx = cv.getContext('2d');
    cx.fillStyle = '#ffffff';
    cx.fillRect(0, 0, ow, oh);
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(bmp, sx, sy, sw, sh, 0, 0, ow, oh);
    const blob = await new Promise((ok, no) => cv.toBlob(b => (b ? ok(b) : no(new Error('이미지 변환 실패'))), 'image/jpeg', 0.86));
    return { bytes: new Uint8Array(await blob.arrayBuffer()), pxW: ow, pxH: oh, type: 'image/jpeg', mode: 'cover' };
  } finally {
    if (bmp.close) bmp.close();
  }
}

async function finalize() {
  const f = st.frozen, res = st.result;
  busyText('마스킹된 개인정보를 원래 값으로 복원하는 중...');
  const rs = await HG.restoreFile(await HG.openHwpx('r.hwpx', res.built), f.map);
  let bytes = rs.bytes;
  res.missing = rs.missing;
  res.fitLog = '';
  res.over = [];

  const keys = f.fill && res.body && typeof res.body === 'object' ? Object.keys(res.body).filter(k => /^T\d+\.\d+\.\d+$/.test(k)) : [];
  if (keys.length) {
    busyText('고정 표 셀 줄 간격 및 칸 크기를 맞춤 조정하는 중...');
    const r = await eng(['fit', '/w/a.hwpx', '/w/k.json', '-o', '/w/b.hwpx'], { 'a.hwpx': bytes, 'k.json': ENC.encode(JSON.stringify(keys)) }, ['b.hwpx'], 'extra');
    if (r.code === 0 && r.files['b.hwpx']) {
      bytes = r.files['b.hwpx'];
      res.fitLog = r.log;
      for (const line of r.log.split('\n')) {
        const [tag, page, what] = line.split('\t');
        if (tag === '넘침' && what) res.over.push({ page: +page, what });
      }
    }
  }

  let doc = await HG.openHwpx('r.hwpx', bytes);
  let slots = await HG.photoSlots(doc);
  res.slotCount = slots.length;
  res.photoCount = 0;
  res.photoNote = '';
  let pageAdded = false;

  if (st.photos.length && !slots.length) {
    busyText('문서 끝에 「붙임 사진」 대지 페이지를 생성하는 중...');
    const caps = ENC.encode(JSON.stringify(st.photos.map(p => p.caption.trim())));
    const r = await eng(['photos', '/w/a.hwpx', '/w/c.json', '-o', '/w/b.hwpx'], { 'a.hwpx': bytes, 'c.json': caps }, ['b.hwpx'], 'extra');
    if (r.code === 0 && r.files['b.hwpx']) {
      bytes = r.files['b.hwpx'];
      doc = await HG.openHwpx('r.hwpx', bytes);
      slots = await HG.photoSlots(doc);
      pageAdded = slots.length > 0;
    }
  }

  if (st.photos.length && slots.length) {
    if (slots.length !== st.photos.length) {
      const fit = await HG.fitPhotoSlots(doc, st.photos.length);
      if (fit.bytes) { doc = await HG.openHwpx('r.hwpx', fit.bytes); slots = await HG.photoSlots(doc); }
    }
    const list = [];
    for (let k = 0; k < slots.length; k++) {
      busyText(`인쇄용 해상도로 사진 삽입 중 (${Math.min(k + 1, st.photos.length)}/${st.photos.length})...`);
      list.push(st.photos[k] ? await photoBytes(st.photos[k], slots[k]) : null);
    }
    const ins = await HG.insertPhotos(doc, list);
    if (ins.bytes) bytes = ins.bytes;
    res.photoCount = ins.count;
    res.slotCount = slots.length;
    if (pageAdded) res.photoNote = '양식에 사진 칸이 없어 마지막 쪽에 「붙임 사진」 대지를 만들어 넣었습니다.';
  }

  res.final = bytes;
  busyText('페이지별 미리보기(SVG)를 렌더링하는 중...');
  (st.pvUrls || []).forEach(u => URL.revokeObjectURL(u));
  st.pvUrls = [];
  try {
    const pv = await pagesOf(bytes, 40);
    res.pages = pv.n;
    res.urls = pv.urls;
    st.pvUrls = pv.urls;
  } catch (e) {
    res.pages = 0;
    res.urls = [];
  }
  renderResult();
}

function docTitle() {
  const f = st.frozen, res = st.result;
  let t = '';
  if (!f.fill) {
    const m = String(res.body).match(/^@제목:\s*(.+)$/m);
    if (m) t = HG.restoreText(m[1], f.map).text.replace(/\\n/g, ' ');
  } else if (!st.form.isDefault) {
    t = st.form.name.replace(/\.hwpx?$/i, '') + '_작성본';
  }
  t = t.replace(/[\\/:*?"<>|\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  return t || '공공_기획보고서';
}

function holes() {
  const f = st.frozen, res = st.result, back = t => HG.restoreText(t, f.map).text;
  if (f.fill) {
    const out = [];
    for (const [k, v] of Object.entries(res.body || {})) {
      const s = back(String(v));
      if (/○○/.test(s)) out.push({ key: k, label: `칸 ${k}`, value: s });
    }
    return out;
  }
  const lines = String(res.body).split('\n');
  const out = [];
  let inTable = false;
  lines.forEach((line, i) => {
    if (/^\[표( \d+)?\]/.test(line)) inTable = true;
    if (/^\[\/표\]/.test(line)) inTable = false;
    if (!/○○/.test(line) || /^\s*\/\//.test(line)) return;
    let m;
    if ((m = line.match(/^@제목:\s*(.*)$/))) out.push({ i, kind: 'title', label: '문서 제목', value: back(m[1]).replace(/\\n/g, ' / ') });
    else if ((m = line.match(/^@바꾸기:\s*(.*?)\s*=>\s*(.*)$/))) out.push({ i, kind: 'swap', from: m[1], label: `틀 글자 (${m[1]})`, value: back(m[2]) });
    else out.push({ i, kind: 'line', label: inTable ? '표 행 (칸 구분: |)' : '본문 문단', value: back(line) });
  });
  return out;
}

function renderResult() {
  const f = st.frozen, res = st.result;
  const back = t => HG.restoreText(t, f.map).text;
  $('#r-title').textContent = docTitle();
  const facts = [
    res.pages ? `총 ${res.pages}쪽` : '',
    res.photoCount ? `사진 ${res.photoCount}장 삽입됨` : '',
    st.form.isDefault ? '공공기관 표준 양식' : `원본 양식(${st.form.name}) 디자인 적용`,
  ];
  $('#r-facts').textContent = facts.filter(Boolean).join(' · ');

  $('#pages').replaceChildren(...(res.urls || []).map((u, i) =>
    el('figure', { class: 'page' },
      el('div', { class: 'sheet' }, el('img', { src: u, alt: `${i + 1}쪽 미리보기` })),
      el('figcaption', { text: `- ${i + 1}쪽 -` }),
    )
  ));
  if (!res.urls || !res.urls.length) {
    $('#pages').replaceChildren(el('p', { class: 'hint', text: '미리보기를 렌더링하지 못했습니다. 한글 파일을 다운로드하여 확인해 주세요.' }));
  }

  // 탭 1: 빈칸(○○) 채우기
  const hs = holes();
  st.holes = hs;
  $('#fill-n').textContent = hs.length ? `(${hs.length}곳)` : '(없음)';
  if (hs.length) {
    $('#holes-hint').textContent = 'AI가 임의로 지어내지 않고 ○○로 비워 둔 항목입니다. 실제 수치·일정을 적고 아래 버튼을 누르면 AI 없이 1초 만에 반영됩니다.';
    $('#fill-list').replaceChildren(...hs.map((h, k) => {
      const inp = el('input', { type: 'text', id: 'hole' + k, value: h.value });
      return el('label', { class: 'fill-row', for: 'hole' + k },
        h.label ? el('span', { text: h.label }) : null,
        inp,
      );
    }));
    $('#refill').hidden = false;
  } else {
    $('#holes-hint').textContent = '비워 둔 빈칸(○○)이 없습니다. 문구 수정은 [② 원문 직접 편집] 탭을 이용해 보세요!';
    $('#fill-list').replaceChildren();
    $('#refill').hidden = true;
  }

  // 탭 2: 개요 / 칸 값 원문 직접 편집기 (실제 복원된 텍스트로 보여 주어 편리하게 편집)
  if (f.fill) {
    const restoredObj = {};
    for (const [k, v] of Object.entries(res.body || {})) {
      restoredObj[k] = back(String(v));
    }
    $('#raw-editor').value = JSON.stringify(restoredObj, null, 2);
  } else {
    $('#raw-editor').value = back(String(res.body || ''));
  }

  // 사진 박스
  $('#photo-box').hidden = !res.slotCount && !st.photos.length;
  $('#photo-n').textContent = res.slotCount ? `(사진 칸 ${res.slotCount}곳 · 삽입 ${res.photoCount}장)` : '';

  // 점검 노트
  const notes = [];
  if (res.photoNote) notes.push(res.photoNote);
  if (res.missing && res.missing.length) notes.push(`${res.missing.join(', ')} 토큰은 원본을 찾지 못해 그대로 남았습니다.`);
  for (const l of ((res.fitLog || '') + '\n' + (res.log || '')).split('\n')) {
    if (/^- (쪽 수|참고|확인|주의)/.test(l) && !/가리개|사진 자리/.test(l)) {
      notes.push(l.replace(/^- /, ''));
    }
  }
  notes.push('구형 .hwp 제출이 필요한 경우, .hwpx를 내려받아 한컴오피스 한글에서 [다른 이름으로 저장 → 한글 문서(*.hwp)]로 저장하시면 표 계산식까지 100% 보존됩니다.');
  $('#notes').replaceChildren(...notes.map(t => el('li', { text: t })));
}

// 4단계 편집 탭 전환
for (const btn of document.querySelectorAll('.edit-tabs button')) {
  btn.addEventListener('click', () => {
    for (const b of document.querySelectorAll('.edit-tabs button')) {
      b.classList.toggle('active', b === btn);
    }
    const tab = btn.dataset.tab;
    $('#pane-holes').hidden = tab !== 'holes';
    $('#pane-raw').hidden = tab !== 'raw';
    $('#pane-ai').hidden = tab !== 'ai';
  });
}

// 탭 1: 빈칸(○○) 즉시 반영
$('#refill').addEventListener('click', async () => {
  if (st.busy || !st.result) return;
  const f = st.frozen, res = st.result;
  const vals = [...document.querySelectorAll('#fill-list input')].map(i => i.value.trim());
  const mask = maskMore(vals);
  let body;
  if (f.fill) {
    body = Object.assign({}, res.body);
    st.holes.forEach((h, k) => { if (vals[k]) body[h.key] = mask(vals[k]); else delete body[h.key]; });
  } else {
    const lines = String(res.body).split('\n');
    st.holes.forEach((h, k) => {
      const v = mask(vals[k] || '');
      if (h.kind === 'title') lines[h.i] = '@제목: ' + v.replace(/\s*\/\s*/g, '\\n');
      else if (h.kind === 'swap') lines[h.i] = '@바꾸기: ' + h.from + ' => ' + v;
      else lines[h.i] = v;
    });
    body = lines.join('\n');
  }
  await buildAndShow(body, true);
  say('#get-msg', '✅ 입력하신 빈칸 내용이 한글 문서에 즉시 반영되었습니다.', true);
});

// 탭 2: 원문 직접 편집 즉시 반영 (AI 없이 1초 재조립)
$('#raw-apply').addEventListener('click', async () => {
  if (st.busy || !st.result) return;
  const f = st.frozen;
  const rawText = $('#raw-editor').value;
  if (!rawText.trim()) return;
  const mask = maskMore([rawText]);
  let body;
  if (f.fill) {
    try {
      const parsed = JSON.parse(rawText);
      body = {};
      for (const [k, v] of Object.entries(parsed)) {
        body[k] = mask(String(v));
      }
    } catch (e) {
      say('#get-msg', 'JSON 형식이 올바르지 않습니다. 따옴표와 쉼표를 확인해 주세요.');
      return;
    }
  } else {
    body = mask(rawText);
  }
  await buildAndShow(body, true);
  say('#get-msg', '✅ 직접 편집하신 원문이 한글 문서와 미리보기에 즉시 반영되었습니다.', true);
});

// 탭 3: AI에게 추가 수정 요청
$('#ask-fix').addEventListener('click', async () => {
  if (st.busy || !st.result) return;
  const wish = $('#wish').value.trim();
  if (!wish) {
    say('#get-msg', 'AI에게 어떻게 고쳐 달라고 할지 입력해 주세요.');
    $('#wish').focus();
    return;
  }
  const mask = maskMore([wish]);
  const currentBodyStr = st.frozen.fill ? JSON.stringify(st.result.body, null, 2) : String(st.result.body);
  const prompt = await editPrompt(aiCtx(), currentBodyStr, mask(wish));
  $('#wish').value = '';
  openPasteUI(prompt, 'edit');
});

// 직전 결과로 되돌리기 (Undo)
$('#undo').addEventListener('click', async () => {
  if (st.busy || !st.hist.length) return;
  st.busy = true;
  busyOn('직전 문서 상태로 되돌리는 중...');
  try {
    st.result = st.hist.pop();
    await finalize();
    say('#get-msg', '↩ 직전 문서 상태로 되돌렸습니다.', true);
  } finally {
    st.busy = false;
    busyOff();
    $('#undo-row').hidden = !st.hist.length;
  }
});

// 4단계에서 사진 교체·추가
$('#p2-input').addEventListener('change', async () => {
  const fs = [...$('#p2-input').files];
  $('#p2-input').value = '';
  if (!fs.length || st.busy || !st.result) return;
  const { list, errs } = await readPhotos(fs);
  if (!list.length) { say('#get-msg', errs); return; }
  st.photos.forEach(p => URL.revokeObjectURL(p.url));
  st.photos = list;
  renderPhotos();
  st.busy = true;
  busyOn('새 사진을 한글 문서에 삽입하는 중...');
  try {
    await finalize();
    say('#get-msg', `✅ 사진 ${st.result.photoCount}장을 문서에 반영했습니다.`, true);
  } finally {
    st.busy = false;
    busyOff();
  }
});

// 한글 파일 다운로드 (.hwpx / .hwp)
async function saveFile(kind) {
  if (!st.result || st.busy) return;
  say('#get-msg', []);
  let bytes = st.result.final;
  let name = docTitle() + '.hwpx';
  if (kind === 'hwp') {
    try {
      const rh = await rhwp();
      const d = new rh.HwpDocument(bytes);
      try { bytes = d.exportHwp(); } finally { freeDoc(d); }
      name = name.replace(/\.hwpx$/, '.hwp');
    } catch (e) {
      say('#get-msg', '.hwp 변환 중 오류가 발생했습니다. .hwpx 파일로 받아 한글에서 저장해 주세요.');
      return;
    }
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: kind === 'hwp' ? 'application/x-hwp' : 'application/hwp+zip' }));
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  say('#get-msg', `✅ 다운로드 완료: ${name}`, true);
  doneFor(kind === 'hwp' ? $('#get-hwp') : $('#get-hwpx'), '다운로드 완료 ✓');
}

$('#get-hwpx').addEventListener('click', () => saveFile('hwpx'));
$('#get-hwp').addEventListener('click', () => saveFile('hwp'));

$('#restart').addEventListener('click', () => {
  if (st.busy) return;
  st.mats = [];
  st.photos.forEach(p => URL.revokeObjectURL(p.url));
  st.photos = [];
  st.manual = [];
  st.result = null;
  st.hist = [];
  $('#req').value = '';
  renderMats();
  renderPhotos();
  redetect();
  go(1);
});

// 사용법 영상 모달
const howtoDlg = $('#howto-dlg');
const howtoVid = $('#howto-video');
if ($('#howto-open') && howtoDlg) {
  $('#howto-open').addEventListener('click', () => {
    howtoDlg.showModal();
    if (howtoVid) {
      howtoVid.currentTime = 0;
      howtoVid.play().catch(() => {});
    }
  });
  $('#howto-close').addEventListener('click', () => howtoDlg.close());
  howtoDlg.addEventListener('click', e => { if (e.target === howtoDlg) howtoDlg.close(); });
  howtoDlg.addEventListener('close', () => { if (howtoVid) howtoVid.pause(); });
}

// 초기 프리로드
refs().catch(() => {});
rhwp().catch(() => {});
go(1);

