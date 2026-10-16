/* 개인정보 가리개 — 핵심 처리 (브라우저·node 공용)
 * 한글 HWPX 파일 안의 이름·연락처 같은 개인정보를 [이름1]처럼 가리고, 나중에 되돌린다.
 * 인터넷으로 아무것도 보내지 않는다. 화면 코드는 index.html에 있다.
 */
const HG = (() => {
  'use strict';

  class HGError extends Error {
    constructor(code, msg) { super(msg || code); this.code = code; }
  }

  // ------------------------------------------------------------ 압축(zip) 읽기·쓰기
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(u8) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  async function pipeBytes(u8, stream) {
    const out = await new Response(new Blob([u8]).stream().pipeThrough(stream)).arrayBuffer();
    return new Uint8Array(out);
  }

  function canStream() {
    try {
      new DecompressionStream('deflate-raw');
      new CompressionStream('deflate-raw');
      return true;
    } catch (e) {
      return false;
    }
  }

  function readZip(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new HGError('broken');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const dec = new TextDecoder('utf-8');
    const entries = [];
    for (let k = 0; k < count; k++) {
      if (p + 46 > u8.length || dv.getUint32(p, true) !== 0x02014b50) throw new HGError('broken');
      const method = dv.getUint16(p + 10, true);
      const time = dv.getUint16(p + 12, true), date = dv.getUint16(p + 14, true);
      const crc = dv.getUint32(p + 16, true), csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true);
      const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
      const lho = dv.getUint32(p + 42, true);
      const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
      p += 46 + nlen + xlen + clen;
      if (dv.getUint32(lho, true) !== 0x04034b50) throw new HGError('broken');
      const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
      entries.push({ name, method, time, date, crc, usize, raw: u8.subarray(start, start + csize) });
    }
    return entries;
  }

  async function entryBytes(e) {
    if (e.data) return e.data;
    if (e.method === 0) e.data = e.raw;
    else if (e.method === 8) e.data = await pipeBytes(e.raw, new DecompressionStream('deflate-raw'));
    else throw new HGError('broken');
    return e.data;
  }

  // 바꾼 항목만 새로 압축하고 나머지는 원본 바이트를 그대로 옮긴다. mimetype은 맨 앞에 압축 없이.
  async function writeZip(entries) {
    const enc = new TextEncoder();
    const ordered = entries.filter(e => e.name === 'mimetype').concat(entries.filter(e => e.name !== 'mimetype'));
    const parts = [], central = [];
    let offset = 0;
    for (const e of ordered) {
      let method = e.method, raw = e.raw, crc = e.crc, usize = e.usize;
      if (e.changed) {
        const d = e.changed;
        usize = d.length;
        crc = crc32(d);
        if (e.name === 'mimetype' || e.method === 0) { method = 0; raw = d; }
        else { method = 8; raw = await pipeBytes(d, new CompressionStream('deflate-raw')); }
      }
      const nb = enc.encode(e.name);
      const flag = /[^\x00-\x7f]/.test(e.name) ? 0x0800 : 0;
      const lh = new Uint8Array(30 + nb.length), lv = new DataView(lh.buffer);
      lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, flag, true);
      lv.setUint16(8, method, true); lv.setUint16(10, e.time, true); lv.setUint16(12, e.date, true);
      lv.setUint32(14, crc, true); lv.setUint32(18, raw.length, true); lv.setUint32(22, usize, true);
      lv.setUint16(26, nb.length, true); lh.set(nb, 30);
      const ch = new Uint8Array(46 + nb.length), cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
      cv.setUint16(8, flag, true); cv.setUint16(10, method, true); cv.setUint16(12, e.time, true);
      cv.setUint16(14, e.date, true); cv.setUint32(16, crc, true); cv.setUint32(20, raw.length, true);
      cv.setUint32(24, usize, true); cv.setUint16(28, nb.length, true); cv.setUint32(42, offset, true);
      ch.set(nb, 46);
      parts.push(lh, raw);
      central.push(ch);
      offset += lh.length + raw.length;
    }
    const cdSize = central.reduce((a, c) => a + c.length, 0);
    const end = new Uint8Array(22), ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, ordered.length, true); ev.setUint16(10, ordered.length, true);
    ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
    const all = parts.concat(central, [end]);
    const out = new Uint8Array(all.reduce((a, c) => a + c.length, 0));
    let q = 0;
    for (const c of all) { out.set(c, q); q += c.length; }
    return out;
  }

  // ------------------------------------------------------------ XML 글자
  const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
  function decodeEnt(s) {
    return s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (m, e) =>
      e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e]);
  }
  function encodeEnt(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // XML을 태그·글자 조각으로 나누고, 문단(hp:p)마다 글자(hp:t) 조각과 표 칸 위치를 모은다.
  // 원본 문자열을 조각 단위로 그대로 두기 때문에 바꾼 글자 말고는 한 글자도 달라지지 않는다.
  const TOKEN_RE = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<[^>]+>|[^<]+/g;
  const TAG_RE = /^<(\/?)(?:[\w.-]+:)?([\w.-]+)([\s\S]*?)(\/?)>$/;

  function attrs(s) {
    const a = {};
    s.replace(/([\w:.-]+)\s*=\s*"([^"]*)"/g, (m, k, v) => { a[k.replace(/^.*:/, '')] = v; return m; });
    return a;
  }

  function scanXml(xml) {
    const toks = xml.match(TOKEN_RE) || [];
    const paras = [], others = [], tables = [];
    const pstack = [], tblStack = [], tcStack = [];
    let order = 0;
    for (let i = 0; i < toks.length; i++) {
      const s = toks[i];
      if (s[0] !== '<') {
        const top = pstack[pstack.length - 1];
        if (top && top.inT) top.pieces.push(i);
        else if (s.trim()) others.push(i);
        continue;
      }
      if (s[1] === '?' || s[1] === '!') continue;
      const m = TAG_RE.exec(s);
      if (!m) continue;
      const close = m[1] === '/', name = m[2], selfc = m[4] === '/';
      const top = pstack[pstack.length - 1];
      if (name === 'p') {
        if (close) {
          const para = pstack.pop();
          if (para) paras.push(para);
        } else if (!selfc) {
          const cell = tcStack[tcStack.length - 1] || null;
          const para = { pieces: [], inT: 0, lseg: null, cell, order: order++ };
          if (cell) cell.paras.push(para);
          pstack.push(para);
        }
      } else if (name === 't') {
        if (top && !selfc) top.inT += close ? -1 : 1;
      } else if (name === 'linesegarray') {
        if (top) {
          if (selfc) top.lseg = [i, i];
          else if (!close) top.lseg = [i, -1];
          else if (top.lseg) top.lseg[1] = i;
        }
      } else if (name === 'tbl') {
        if (close) tblStack.pop();
        else if (!selfc) {
          const t = { cells: [] };
          tables.push(t);
          tblStack.push(t);
        }
      } else if (name === 'tc') {
        if (close) tcStack.pop();
        else if (!selfc) {
          const t = tblStack[tblStack.length - 1];
          const cell = { row: -1, col: -1, rs: 1, cs: 1, paras: [], tbl: t || null };
          if (t) t.cells.push(cell);
          tcStack.push(cell);
        }
      } else if (name === 'cellAddr' && tcStack.length) {
        const a = attrs(m[3]), c = tcStack[tcStack.length - 1];
        c.row = +a.rowAddr || 0;
        c.col = +a.colAddr || 0;
      } else if (name === 'cellSpan' && tcStack.length) {
        const a = attrs(m[3]), c = tcStack[tcStack.length - 1];
        c.rs = Math.max(1, +a.rowSpan || 1);
        c.cs = Math.max(1, +a.colSpan || 1);
      }
    }
    for (const para of paras) {
      para.texts = para.pieces.map(i => decodeEnt(toks[i]));
      para.text = para.texts.join('');
    }
    paras.sort((a, b) => a.order - b.order);
    for (const t of tables) {
      for (const c of t.cells) c.text = c.paras.map(p => p.text).join('\n').trim();
    }
    return { toks, paras, others, tables };
  }

  // 여러 조각에 걸친 글자도 바꿀 수 있게: matches는 [{start, end, rep}] (앞에서부터, 겹치지 않음)
  function replaceInPieces(texts, matches) {
    const starts = [];
    let acc = 0;
    for (const t of texts) { starts.push(acc); acc += t.length; }
    const at = pos => {
      for (let i = 0; i < texts.length; i++) {
        if (texts[i].length && pos >= starts[i] && pos < starts[i] + texts[i].length) return i;
      }
      return texts.length - 1;
    };
    const out = texts.slice();
    for (let k = matches.length - 1; k >= 0; k--) {
      const { start, end, rep } = matches[k];
      const i = at(start), j = at(end - 1);
      const ls = start - starts[i], le = end - starts[j];
      if (i === j) out[i] = out[i].slice(0, ls) + rep + out[i].slice(le);
      else {
        out[i] = out[i].slice(0, ls) + rep;
        for (let q = i + 1; q < j; q++) out[q] = '';
        out[j] = out[j].slice(le);
      }
    }
    return out;
  }

  // 문단 글자를 바꾸고 XML을 다시 잇는다. 글자가 바뀐 문단은 줄 배치 정보(linesegarray)를 지워
  // 한글이 새로 계산하게 한다.
  function rewriteXml(scan, regex, replacer) {
    const { toks, paras, others } = scan;
    const newText = new Map(), drop = new Set();
    let n = 0;
    for (const para of paras) {
      if (!para.text) continue;
      const matches = [];
      regex.lastIndex = 0;
      let m;
      while ((m = regex.exec(para.text))) {
        if (!m[0]) { regex.lastIndex++; continue; }
        const rep = replacer(m);
        if (rep !== null && rep !== m[0]) matches.push({ start: m.index, end: m.index + m[0].length, rep });
      }
      if (!matches.length) continue;
      n += matches.length;
      const out = replaceInPieces(para.texts, matches);
      para.pieces.forEach((ti, k) => { if (out[k] !== para.texts[k]) newText.set(ti, out[k]); });
      if (para.lseg && para.lseg[1] >= para.lseg[0]) {
        for (let i = para.lseg[0]; i <= para.lseg[1]; i++) drop.add(i);
      }
    }
    for (const ti of others) {
      const s = decodeEnt(toks[ti]);
      regex.lastIndex = 0;
      const r = s.replace(regex, (...args) => {
        const m = args.slice(0, -2);
        m.index = args[args.length - 2];
        const rep = replacer(m);
        return rep === null ? args[0] : rep;
      });
      if (r !== s) { newText.set(ti, r); n++; }
    }
    if (!n) return { xml: null, count: 0 };
    let xml = '';
    for (let i = 0; i < toks.length; i++) {
      if (drop.has(i)) continue;
      xml += newText.has(i) ? encodeEnt(newText.get(i)) : toks[i];
    }
    return { xml, count: n };
  }

  // ------------------------------------------------------------ 한글 파일 열기
  const ENC = new TextEncoder();
  const DEC = new TextDecoder('utf-8');
  const PART_RE = /^Contents\/(section|masterpage)\d*\.xml$/;

  async function openHwpx(name, u8) {
    if (!(u8 instanceof Uint8Array)) u8 = new Uint8Array(u8);
    if (u8[0] === 0xD0 && u8[1] === 0xCF && u8[2] === 0x11 && u8[3] === 0xE0) throw new HGError('hwp');
    if (!(u8[0] === 0x50 && u8[1] === 0x4B)) {
      // 이름은 한글 파일인데 zip도 옛 한글도 아니면 문서보안(DRM)으로 잠긴 파일일 때가 많다
      const pdf = u8[0] === 0x25 && u8[1] === 0x50 && u8[2] === 0x44 && u8[3] === 0x46;
      throw new HGError(u8.length && !pdf && /\.hwpx?$/i.test(name || '') ? 'locked' : 'nothwpx');
    }
    let entries;
    try {
      entries = readZip(u8);
    } catch (e) {
      throw new HGError('broken');
    }
    const names = entries.map(e => e.name);
    if (!names.some(n => /^Contents\/section\d+\.xml$/.test(n))) {
      if (names.some(n => /^word\//.test(n))) throw new HGError('docx');
      throw new HGError('nothwpx');
    }
    const parts = [];
    for (const e of entries) {
      if (!PART_RE.test(e.name)) continue;
      const xml = DEC.decode(await entryBytes(e));
      parts.push({ entry: e, xml, scan: scanXml(xml) });
    }
    const num = n => (n.match(/\d+/) || ['0'])[0] * 1 + (n.includes('master') ? 1e6 : 0);
    parts.sort((a, b) => num(a.entry.name) - num(b.entry.name));
    const bin = names.filter(n => /^BinData\//.test(n));
    return {
      name,
      entries,
      parts,
      pics: bin.filter(n => /\.(png|jpe?g|gif|bmp|tiff?|wmf|emf|svg)$/i.test(n)).length,
      objects: bin.filter(n => /\.(ole|bin|ods|xlsx?|docx?|pptx?)$/i.test(n)).length,
    };
  }

  function docLines(doc) {
    const out = [], done = new Set();
    for (const part of doc.parts) {
      for (const p of part.scan.paras) {
        const t = p.cell && p.cell.tbl;
        if (!t) { if (p.text) out.push(p.text); continue; }
        if (done.has(t)) continue;
        done.add(t);
        const rows = new Map();
        for (const c of t.cells) {
          if (!rows.has(c.row)) rows.set(c.row, []);
          rows.get(c.row).push(c);
        }
        for (const r of [...rows.keys()].sort((a, b) => a - b)) {
          out.push('| ' + rows.get(r).sort((a, b) => a.col - b.col).map(c => c.text.replace(/\s*\n\s*/g, ' ')).join(' | ') + ' |');
        }
      }
    }
    return out;
  }

  function docParas(doc) {
    const out = [];
    for (const part of doc.parts) for (const p of part.scan.paras) if (p.text) out.push(p.text);
    return out;
  }

  // ------------------------------------------------------------ 개인정보 찾기
  const KINDS = [
    { id: 'name', label: '이름', tok: '이름' },
    { id: 'sid', label: '학번', tok: '학번' },
    { id: 'rrn', label: '주민·외국인등록번호', tok: '주민번호' },
    { id: 'phone', label: '전화번호', tok: '전화' },
    { id: 'email', label: '이메일', tok: '메일' },
    { id: 'account', label: '계좌번호', tok: '계좌' },
    { id: 'birth', label: '생년월일', tok: '생일' },
    { id: 'addr', label: '주소', tok: '주소' },
    { id: 'etc', label: '그 밖에 가릴 말', tok: '기타' },
  ];
  const KIND = Object.fromEntries(KINDS.map(k => [k.id, k]));
  const TOK_KIND = Object.fromEntries(KINDS.map(k => [k.tok, k.id]));
  const TOKEN_FIND = new RegExp('[\\[［【]\\s*(' + KINDS.map(k => k.tok).join('|') + ')\\s*(\\d{1,4})\\s*[\\]］】]', 'g');
  const SOURCE_RANK = { guess: 1, pattern: 2, label: 3, table: 3, user: 4 };

  const SURNAMES = '김이박최정강조윤장임한오서신권황안송류유전홍고문양손배백허남심노하곽성차주우구민진나지엄채원천방공현함변염여추도소석선설마길연위표명기반왕금옥육인맹제모탁국어은편용예봉경사부왕';
  const STOP = new Set(('이번 이후 이전 이상 이하 이외 이들 이런 이와 이름 정도 정규 정식 조사 주요 주간 신규 신입 신청 우수 우리 '
    + '전체 전공 전문 전국 전학 해당 해외 모든 모두 기존 기타 기초 기업 기관 참여 대상 재학 졸업 편입 휴학 복학 유학 외국 '
    + '장애 여러 여자 다른 같은 지원 지도 지역 선발 선정 선배 추천 담당 학과 학년 학생 일반 특별 성실 성인 성별 희망 구직 '
    + '취업 재직 인턴 현장 현재 고등 고학 대학 대표 석사 박사 교환 방문 초청 강사 외부 내부 남자 남학 여학 소속 국내 국외 '
    + '국립 사립 공립 공동 공공 공무 민간 문화 예술 체육 의료 간호 공학 경영 경제 행정 교육 사회 인문 자연 과학 정보 상위 '
    + '하위 중위 한국 야간 청년 중장 노인 어린 아동 장학 수혜 진로 상담 면접 서류 회장 총무 위원 반장 조장 팀원 조원 동문 '
    + '후배 동기 합격 수료 이수 최종 최우 최고 최저 명예 주관 주최 협력 연계 연번 번호 순번 구분 비고 합계 소계 총계 성명 '
    + '연락 연락처 주소 이메일 계좌 은행 예금주 생년 생일 날짜 일시 장소 내용 금액 서명 기간 확인 직위 직급 직책 부서 과정 '
    + '분야 회사 업체 학교 교수 학번 국적 남 여 예 계 상 중 하 성 명 각 제 본 해 그 저 위 아래 다음 오늘 내일 매년 매월 매주 '
    + '모집 운영 관리 사업 결과 계획 보고 실적 현황 개요 목적 방법 일정 예산 효과 성과 평가 만족 참석 불참 출석 결석 완료 '
    + '예정 대기 탈락 보통 미흡 있음 없음 아니오 서울 부산 대구 인천 광주 대전 울산 세종 경기 강원 충북 충남 전북 전남 경북 '
    + '경남 제주 안동 경국 국가 도내 시내 군내 관내 신규 고객 손님 주민 시민 군민 도민 국민 청소년 학부모 보호자 교직원 직원 '
    + '수강 수강생 교육생 연수생 훈련생 지원자 신청자 참가자 참여자 대상자 수상자 합격자 선정자 졸업생 재학생 신입생 유학생 '
    + '선생 원장 처장 팀장 과장 국장 부장 실장 사장 이사 감사 총장 학장 주무관 조교 도지사 구청장 기사 기자 사모 부모 어머 '
    + '변호사 노무사 간호사 주임 차장 전무 소장 지점장 전임 기획 사무 연구 진흥 마음 기관명 단체명 업체명 회사명 학교명 학과명 '
    + '사업명 과제명 프로그램 직장명 근무처 부서명 과목명 강좌명 행사명 기업명 소속기관 '
    + '전화 전화로 전화번호 문의 문의처 문자 안내 사무실 예약 전용 공용 공식 추후 미정 제가 저희 본인 '
    + '사진 소개 명단 강의 강의료 사례 사례비 경력 성과 연령 성비 전원 이미지 자료 정리 신청서 조사표 '
    + '마감 변경 연장 장기 단기 한번 한명 한분 오전 오후 주말 평일 '
    // 님·씨·선생님 앞에 자주 오는 직함·보통 말(성씨 글자로 시작해 이름으로 잘못 짐작하던 것)
    + '손글 도우미 사서 방과후 원어민 기간제 봉사자 자원봉사자 이장 조리사 조리원 공무관 경비원 배달원 미화원 편집장 이사장 '
    + '사원 심판 지휘자 연주자 반주자 배우 모델 강연자 진행자 사회자 해설사 통역사 실무사 상담사 상담원 복지사 요양사 지도사 '
    + '활동가 관장 교장 교감 원감 위원 의원 동장 통장 반장 시장 군수 장관 차관 고문 대리 인턴 멘토 멘티 코치 단장 감독 작가 '
    + '강사 가수 담임 보건 영양 사감 교무 보조 보조원 교사 관리자 운영자 작성자 담당자 제출자 대표자').split(/\s+/));

  const LABELS = [
    ['name', /^(성명|이름|학생명|학생이름|성명\(한글\)|한글성명|성명\(국문\)|신청자|신청자명|신청인|참가자|참가자명|참여자|참여자명|대표자|대표자명|보호자|보호자명|담당자|담당자명|작성자|작성자명|상담자|내담자|피상담자|지도교수|교수명|예금주|수령인|수령자|수취인|추천인|피추천인|대상자|대상자명|학생|강사명|강사|성명\(영문\)|영문성명|englishname|name|성함|학생성명|한글이름|참여학생|참가학생|대상학생|참석자|참석자명|수강생|수료생|교육생|연수생|훈련생|합격자|수상자|입상자|우수자|팀원|조원|멘토|멘티|지원자|면접자|발표자)$/],
    ['sid', /^(학번|학생번호)$/],
    ['rrn', /^(주민등록번호|주민번호|외국인등록번호|주민\(외국인\)등록번호|주민등록번호\(외국인등록번호\))$/],
    ['phone', /^(연락처|전화|전화번호|휴대폰|휴대전화|핸드폰|휴대폰번호|휴대전화번호|핸드폰번호|이동전화|비상연락처|보호자연락처|연락처\(휴대폰\)|연락처\(휴대전화\)|hp|h\.p|tel|phone|mobile)$/],
    ['email', /^(이메일|전자우편|e-?mail|메일|이메일주소|전자우편주소)$/],
    ['account', /^(계좌번호|계좌|입금계좌|통장번호|입금계좌번호|은행계좌|계좌번호\(은행명\)|은행및계좌번호|은행명및계좌번호|지급계좌|환급계좌)$/],
    ['birth', /^(생년월일|생일|출생일|생년월일\(6자리\))$/],
    ['addr', /^(주소|거주지|현주소|주소지|자택주소|집주소|실거주지|거주지주소)$/],
  ];

  function labelKind(text) {
    const t = text.replace(/[\s·:：*※]/g, '').replace(/\(필수\)$/, '').toLowerCase();
    if (!t || t.length > 20) return null;
    for (const [k, re] of LABELS) if (re.test(t)) return k;
    return null;
  }

  function isLabelish(text) {
    const k = text.replace(/[\s·:：*※]/g, '');
    if (!k || k.length > 14) return false;
    return !!labelKind(k) || STOP.has(k)
      || /(명|처|일|일자|일시|번호|여부|구분|사항|내용|기간|장소|금액|점수|등급|결과|비고|서명|확인|학과|학년|전공|소속|성별|직위|직급|과정|분야|연번|순번)$/.test(k);
  }

  function cleanValue(s) {
    return s.split('\n')[0].replace(/\(\s*(인|서명|印|sign)\s*\)|[(（]\s*인\s*[)）]|\s+인$|\s+\(?서명\)?$/gi, '').trim();
  }

  const COMPOUND = '(?:남궁|제갈|선우|황보|독고|사공|서문)';
  // 목록 한 칸이 이름 하나인지: 이름(+학생·님 등)(+괄호 설명)(+등·외 N명)만 있어야 한다
  const NAME_ITEM = new RegExp('^(' + COMPOUND + '[가-힣]{1,2}|[' + SURNAMES + '][가-힣]{1,2})(?:\\s*(?:학생|님|씨|군|양|교수님?|선생님?|강사님?))?(?:\\s*[(（][^)）]{0,30}[)）])?(?:\\s*(?:등|외)(?:\\s*\\d+\\s*(?:명|인))?)?(?:이에요|예요|입니다|이었어요|였어요|이었다|였다|이다|이고|이며|이랑|하고|이|가|은|는|을|를|도|랑)?[.!]?$');
  const LIST_SEP = /\s*(?:[,，、·ㆍ･‧/]|\s및\s|\s그리고\s)\s*/;

  const RE = {
    rrn: /(?<!\d)\d{6}\s?[-–]\s?[1-8](?:\d{6}|\d?[*xX●○]{5,6})(?!\d)/g,
    mobile: /(?<![\d-])01[016789][-.\s]?\d{3,4}[-.\s]?\d{4}(?![\d-])/g,
    tel: /(?<![\d-])\(?0(?:2|[3-6][1-5]|70)\)?[-.\s]?\d{3,4}[-.\s]\d{4}(?![\d-])/g,
    email: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
    sid: /(?<![\d-])(?:19|20)\d{7,8}(?![\d-])/g,
    labName: /(?:성\s*명|이\s*름|학\s*생\s*명|예금주|[가-힣]{0,6}(?:자|인|교수|강사|위원|대표|담당|기안|결재|검토|협조))\s*[:：]\s*([가-힣]{2,4})(?![가-힣])/g,
    labSid: /학\s*번\s*[:：]?\s*(\d{6,10})(?!\d)/g,
    labBirth: /(?:생\s*년\s*월\s*일|생\s*일|출\s*생\s*일)\s*[:：]?\s*(\d{2,4}\s*[.\-/년]\s*\d{1,2}\s*[.\-/월]\s*\d{1,2}\s*일?\.?|\d{6,8})(?!\d)/g,
    labAddr: /(?:주\s*소|거\s*주\s*지|현\s*주\s*소)\s*[:：]\s*([^\n]{4,80})/g,
    labAccount: /(?:계\s*좌(?:\s*번\s*호)?|입\s*금\s*계\s*좌|통\s*장)\s*[:：]?\s*(?:[가-힣A-Za-z()]{1,10}\s*)?(\d[\d\-\s]{6,22}\d)(?!\d)/g,
    bank: /(?:(?:농협|국민|신한|기업|우체국|새마을금고|신협|카카오뱅크|토스뱅크|케이뱅크|수협|iM뱅크|아이엠뱅크)(?:은행)?|(?:우리|하나|대구|부산|경남|광주|전북|제주|SC제일|씨티|산업)은행)\s*[:：]?\s*(\d{2,6}(?:-\d{1,7}){2,4})(?![\d-])/g,
    addr: /(?:서울특별시|부산광역시|대구광역시|인천광역시|광주광역시|대전광역시|울산광역시|세종특별자치시|경기도|강원특별자치도|강원도|충청북도|충청남도|전북특별자치도|전라북도|전라남도|경상북도|경상남도|제주특별자치도|서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)\s+[가-힣]{1,6}(?:시|군|구)(?:\s+[가-힣]{1,6}구)?(?:\s+[가-힣0-9]{1,14}(?:읍|면|동|가|리|로|길)){1,3}(?:\s*\d{1,5}(?:-\d{1,5})?)?(?:,?\s*\d{1,4}동\s*\d{1,5}호|,?\s*\d{1,5}호)?/g,
    guessName: new RegExp('(?<![가-힣])([' + SURNAMES + '][가-힣]{1,2})\\s?(?=학생|님|씨|교수|선생|학우|조교|주무관|팀장|과장|처장|원장|본부장|센터장)', 'g'),
    // "김철수 010-1234-5678", "김철수(hong@…)"처럼 연락처 바로 앞에 붙은 이름
    guessNameContact: new RegExp('(?<![가-힣])([' + SURNAMES + '][가-힣]{1,2})(?=\\s*[(,:/]?\\s*(?:0\\d{1,2}[-.\\s)]{0,2}\\d{3,4}[-.\\s]?\\d{4}(?!\\d)|[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\\.))', 'g'),
    // "담당은 김철수", "강사는 이영희가"처럼 역할 말 뒤의 이름(조사가 붙어도 이름만)
    // "참여 학생: 박민수, 최지우, 정다은", "수료생은 박민수, 최지우예요"처럼 단서 말 뒤에 죽 나열한 이름(나누기·모양 검사는 NAME_ITEM)
    nameList: /(참여\s*학생|참가\s*학생|대상\s*학생|학생\s*명단|참여자|참가자|참석자|수강생|수료생|교육생|연수생|훈련생|합격자|수상자|입상자|우수자|팀원|조원|멘토|멘티|지원자|면접자|발표자|학생|명단|성명|이름)(?:\s*(?:명단|이름|성명))?\s*([:：]|(?:은|는|이|가)(?=\s))\s*([^\n]{2,300})/g,
    // "박민수 외 24명"(세 글자 이름만)
    guessNameEtc: new RegExp('(?<![가-힣])(' + COMPOUND + '[가-힣]{1,2}|[' + SURNAMES + '][가-힣]{2})\\s*외\\s*\\d+\\s*(?:명|인)', 'g'),
    guessNameRole: new RegExp('(?:담당|담당자|담당교수|담당선생님|강사|작성자|대표자|신청자|참여자|발표자|인솔자|사회자|지도교수|멘토|상담사)\\s*(?:은|는|:|：)\\s*([' + SURNAMES + '][가-힣]{1,2})(?=(?:이|가|은|는|님|씨|에게|한테|하고|와|과|랑|이랑|의|도)?(?![가-힣]))', 'g'),
  };

  function validFor(kind, v) {
    const s = v.replace(/\s+/g, ' ').trim();
    if (!s || s.length < 2) return null;
    switch (kind) {
      case 'name': {
        const k = s.replace(/\s/g, '');
        if (/^[가-힣]{2,5}$/.test(k) && !STOP.has(k) && !labelKind(k) && SURNAMES.includes(k[0])) return s;
        if (/^[A-Z][A-Za-z'.-]+(?: [A-Z][A-Za-z'.-]+){1,3}$/.test(s) && s.length <= 40) return s;
        return null;
      }
      case 'sid': return /^\d{6,10}$/.test(s) ? s : null;
      case 'rrn': return /^\d{6}\s?-?\s?[1-8][\d*xX●○]{0,6}$/.test(s) && s.length >= 7 ? s : null;
      case 'phone': return /^[\d()+\-.\s]{9,18}$/.test(s) && (s.match(/\d/g) || []).length >= 9 ? s : null;
      case 'email': return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(s) ? s : null;
      case 'account': {
        if (/^\(?0(1[016789]|2|[3-6][1-5]|70)\)?[-.\s]?\d{3,4}[-.\s]\d{4}$/.test(s)) return null;
        const m = s.match(/\d[\d\-\s]{6,24}\d/);
        return m && (m[0].match(/\d/g) || []).length >= 8 ? m[0].trim() : null;
      }
      case 'birth': return /^(\d{2,4}\s*[.\-/년]\s*\d{1,2}\s*[.\-/월]\s*\d{1,2}\s*일?\.?|\d{6,8})$/.test(s) ? s : null;
      case 'addr': return s.length >= 6 && s.length <= 100 && /[가-힣]/.test(s) && /(시|군|구|동|로|길|읍|면|리)(\s|\d|$)/.test(s) ? s : null;
      default: return s;
    }
  }

  function escRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // 찾은 값마다 쓸 정규식 조각: 이름은 다른 낱말 한가운데서는 찾지 않고, 숫자는 더 긴 숫자의 일부가 아닐 때만.
  function valuePattern(c) {
    let p = escRe(c.value).replace(/\\?\s+/g, '\\s*');
    if (c.kind === 'name') return '(?<![가-힣])' + p;
    if (/^\d/.test(c.value)) p = '(?<![\\d])' + p;
    if (/\d$/.test(c.value)) p = p + '(?![\\d])';
    return p;
  }

  function buildRegex(cands) {
    const list = cands.slice().sort((a, b) => b.value.length - a.value.length);
    if (!list.length) return null;
    return new RegExp(list.map(valuePattern).join('|'), 'g');
  }

  function normKey(s) {
    return s.replace(/\s+/g, '');
  }

  // files: openHwpx 결과 목록, texts: 글 붙여넣기(문자열) 목록
  function detect(files, texts) {
    const cands = new Map();
    let order = 0;
    const add = (value, kind, ctx, source) => {
      const v = validFor(kind, value);
      if (!v) return;
      // 짐작한 이름 중 '이전과'·'이번에'처럼 보통 말 + 조사인 세 글자는 뺀다(표·이름 칸에서 찾은 것은 그대로)
      if (source === 'guess' && kind === 'name' && v.length === 3 && STOP.has(v.slice(0, 2)) && '과와가이은는도의랑에'.includes(v[2])) return;
      const key = normKey(v);
      const old = cands.get(key);
      if (!old) {
        cands.set(key, { value: v, kind, source, ctx: ctx || '', first: order++, count: 0, on: true });
      } else if (SOURCE_RANK[source] > SOURCE_RANK[old.source]) {
        old.kind = kind;
        old.source = source;
      }
    };
    const scanText = text => {
      if (!text) return;
      const run = (re, kind, group, source) => {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(text))) add(group ? m[group] : m[0], kind, text, source);
      };
      run(RE.rrn, 'rrn', 0, 'pattern');
      run(RE.email, 'email', 0, 'pattern');
      run(RE.labName, 'name', 1, 'label');
      run(RE.labSid, 'sid', 1, 'label');
      run(RE.labBirth, 'birth', 1, 'label');
      run(RE.labAccount, 'account', 1, 'label');
      run(RE.bank, 'account', 1, 'label');
      run(RE.mobile, 'phone', 0, 'pattern');
      run(RE.tel, 'phone', 0, 'pattern');
      run(RE.sid, 'sid', 0, 'pattern');
      run(RE.labAddr, 'addr', 1, 'label');
      run(RE.addr, 'addr', 0, 'pattern');
      run(RE.guessName, 'name', 1, 'guess');
      run(RE.guessNameContact, 'name', 1, 'guess');
      run(RE.guessNameRole, 'name', 1, 'guess');
      run(RE.guessNameEtc, 'name', 1, 'guess');
      // 목록은 칸마다 이름 모양인지 보고, 이름이 하나뿐이면 세 글자만 받는다(두 글자 낱말을 이름으로 잘못 보지 않게)
      RE.nameList.lastIndex = 0;
      let lm;
      while ((lm = RE.nameList.exec(text))) {
        RE.nameList.lastIndex = lm.index + lm[0].length - lm[3].length;  // '멘토: 김영수, 멘티: 이수진'처럼 목록 안의 다음 단서도 보게
        const names = lm[3].split(LIST_SEP).map(x => (x.trim().match(NAME_ITEM) || [])[1]).filter(Boolean);
        // 하나뿐이면 세 글자만 받는다. '이름: 홍길동'(쌍점)은 labName이 맡는다. 사람 단서 뒤의 보통 말을 가려도 받은 파일에서 되돌아오니, 놓치는 쪽보다 낫다
        if (names.length === 1 && (names[0].length < 3 || /명단/.test(lm[1]) || (/이름|성명/.test(lm[1]) && /[:：]/.test(lm[2])))) continue;
        for (const n of names) add(n, 'name', text, 'guess');
      }
    };
    const tableScan = tbl => {
      const grid = new Map();
      let maxRow = 0;
      for (const c of tbl.cells) {
        grid.set(c.row + ',' + c.col, c);
        maxRow = Math.max(maxRow, c.row + c.rs);
      }
      // 한 줄에 제목 칸만 있으면(열 제목 줄) 값은 아래 칸들에, 아니면(성명 | 홍길동 꼴) 오른쪽 칸에 있다.
      const headerRow = r => {
        const cells = tbl.cells.filter(c => c.row === r && c.text);
        if (cells.length <= 1) return true;
        return cells.filter(c => isLabelish(c.text)).length / cells.length >= 0.6;
      };
      for (const c of tbl.cells) {
        const kind = labelKind(c.text);
        if (!kind) continue;
        if (headerRow(c.row)) {
          for (let r = c.row + c.rs; r < maxRow; r++) {
            const b = grid.get(r + ',' + c.col);
            if (!b) continue;
            if (labelKind(b.text)) break;
            if (b.text) add(cleanValue(b.text), kind, '', 'table');
          }
        } else {
          const right = grid.get(c.row + ',' + (c.col + c.cs));
          if (right && right.text && !labelKind(right.text)) add(cleanValue(right.text), kind, '', 'table');
        }
      }
    };
    for (const f of files) {
      for (const part of f.parts) {
        for (const t of part.scan.tables) tableScan(t);
        for (const p of part.scan.paras) scanText(p.text);
      }
    }
    for (const t of texts || []) for (const line of t.split(/\r?\n/)) scanText(line);
    const list = [...cands.values()];
    count(list, files, texts);
    return list.filter(c => c.count > 0);
  }

  // 후보마다 몇 곳에 나오는지 세고, 처음 나온 곳 앞뒤 글을 보여 줄 수 있게 남긴다.
  function count(list, files, texts) {
    const re = buildRegex(list);
    if (!re) return;
    const byKey = new Map(list.map(c => [normKey(c.value), c]));
    list.forEach(c => { c.count = 0; c.ctx = ''; });
    const all = [];
    for (const f of files) all.push(...docLines(f));
    for (const t of texts || []) all.push(...t.split(/\r?\n/));
    let pos = 0;
    for (const text of all) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text))) {
        const c = byKey.get(normKey(m[0]));
        if (!c) continue;
        if (!c.count) {
          c.ctx = { before: text.slice(Math.max(0, m.index - 18), m.index), after: text.slice(m.index + m[0].length, m.index + m[0].length + 18) };
          c.first = pos + m.index;
        }
        c.count++;
      }
      pos += text.length + 1;
    }
  }

  // 직접 적어 넣은 말이 무엇인지 짐작한다(이름 칸에 [기타1]보다 [이름1]이 AI에게도 알기 쉽다)
  function guessKind(v) {
    const s = v.trim(), d = s.replace(/[\s.\-()]/g, '');
    if (/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(s)) return 'email';
    if (/^\d{6}\s?-?\s?[1-8]\d{6}$/.test(s)) return 'rrn';
    if (/^0\d{8,10}$/.test(d)) return 'phone';
    if (/^(?:19|20)\d{7,8}$/.test(d) || /^\d{6,8}$/.test(d)) return 'sid';
    if (/^\d{9,16}$/.test(d)) return 'account';
    if (/^[가-힣]{2,4}$/.test(s) && !STOP.has(s) && !labelKind(s)) return 'name';
    if (/^[A-Z][A-Za-z'.-]+(?: [A-Z][A-Za-z'.-]+){1,3}$/.test(s)) return 'name';
    return 'etc';
  }

  function addManual(list, files, texts, words, kind) {
    for (const w of words) {
      const v = w.trim();
      if (v.length < 2) continue;
      const key = normKey(v);
      const old = list.find(c => normKey(c.value) === key);
      const k = kind === 'auto' ? (old ? old.kind : guessKind(v)) : kind;
      if (old) { old.on = true; old.kind = k; old.source = 'user'; continue; }
      list.push({ value: v, kind: k, source: 'user', ctx: '', first: 1e12, count: 0, on: true, manual: true });
    }
    count(list, files, texts);
    return list;
  }

  // 켜진 후보에 [종류N] 표시를 정한다(종류마다 처음 나온 순서).
  function assignTokens(list) {
    const on = list.filter(c => c.on && c.count > 0).sort((a, b) => a.first - b.first);
    const n = {};
    const map = {};
    for (const c of on) {
      const tok = KIND[c.kind].tok;
      n[tok] = (n[tok] || 0) + 1;
      c.token = '[' + tok + n[tok] + ']';
      map[c.token] = c.value;
    }
    return { on, map };
  }

  // ------------------------------------------------------------ 가리기
  const BLANK_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAGkAAACUCAIAAAAf7JCqAAAAyUlEQVR42u3QoQEAAAwCIP9/WuvyMpxAylcUuHPnzh3u3Llzhzt37ty5w507d+5w586dO3e4c+fOHe7cuXPnDnfu3LnDnTt37tzhzp07d7hz584d7ty5c+cOd+7cucOdO3fu3OHOnTt3uHPnzp073Llz5w537ty5c4c7d+7c4c6dO3e4c+fOnTvcuXPnDnfu3Llzhzt37tzhzp07d+5w586dO9y5c+fOHe7cuXOHO3fu3LlT4M6dO3e4c+fOHe7cuXPnDnfu3LnjGOGScIC6FbYAAAAAAElFTkSuQmCC';

  function b64bytes(b64) {
    if (typeof atob === 'function') {
      const s = atob(b64);
      const u = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
      return u;
    }
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }

  async function rewriteText(e, fn) {
    let s = DEC.decode(await entryBytes(e));
    const bom = s.charCodeAt(0) === 0xFEFF;
    if (bom) s = s.slice(1);
    const r = fn(s);
    if (r !== s) e.changed = ENC.encode((bom ? '﻿' : '') + r);
  }

  async function maskFile(doc, cands) {
    const re = buildRegex(cands) || /(?!)/g;
    const byKey = new Map(cands.map(c => [normKey(c.value), c]));
    const rep = m => { const c = byKey.get(normKey(m[0])); return c ? c.token : null; };
    let total = 0;
    for (const part of doc.parts) {
      const r = rewriteXml(part.scan, re, rep);
      if (r.xml !== null) { part.entry.changed = ENC.encode(r.xml); total += r.count; }
    }
    const strRep = s => { re.lastIndex = 0; return s.replace(re, m => { const c = byKey.get(normKey(m)); return c ? c.token : m; }); };
    for (const e of doc.entries) {
      if (e.name === 'Preview/PrvText.txt') await rewriteText(e, strRep);
      else if (e.name === 'Preview/PrvImage.png') e.changed = b64bytes(BLANK_PNG);
      else if (e.name === 'Contents/content.hpf') {
        await rewriteText(e, s => s
          .replace(/(<(?:\w+:)?meta\b[^>]*\bname="(?:creator|lastsaveby)"[^>]*>)([^<]*)(<\/(?:\w+:)?meta>)/g, '$1$3')
          .replace(/(<(?:\w+:)?(?:title|meta)\b[^>]*>)([^<]+)(<\/(?:\w+:)?(?:title|meta)>)/g, (m, a, t, b) => a + encodeEnt(strRep(decodeEnt(t))) + b));
      }
    }
    const out = await writeZip(doc.entries);
    for (const e of doc.entries) delete e.changed;
    return { bytes: out, count: total };
  }

  // 가린 뒤 글 미리보기(앞쪽 몇 줄)
  function previewMasked(doc, cands, maxLines) {
    const re = buildRegex(cands) || /(?!)/g;
    const byKey = new Map(cands.map(c => [normKey(c.value), c]));
    const lines = [];
    for (const t of docLines(doc)) {
      re.lastIndex = 0;
      lines.push(t.replace(re, m => (byKey.get(normKey(m)) || {}).token || m));
      if (lines.length >= (maxLines || 40)) break;
    }
    return lines;
  }

  function maskText(text, cands) {
    const re = buildRegex(cands);
    if (!re) return text;
    const byKey = new Map(cands.map(c => [normKey(c.value), c]));
    return text.replace(re, m => (byKey.get(normKey(m)) || {}).token || m);
  }

  // ------------------------------------------------------------ 되돌리기
  function tokensIn(texts) {
    const found = new Set();
    for (const t of texts) {
      TOKEN_FIND.lastIndex = 0;
      let m;
      while ((m = TOKEN_FIND.exec(t))) found.add('[' + m[1] + m[2] + ']');
    }
    return found;
  }

  function fileTokens(doc) {
    return tokensIn(docParas(doc));
  }

  function restorer(map, missing) {
    return m => {
      const tok = '[' + m[1] + m[2] + ']';
      if (Object.prototype.hasOwnProperty.call(map, tok)) return map[tok];
      missing.add(tok);
      return null;
    };
  }

  async function restoreFile(doc, map) {
    const missing = new Set();
    const rep = restorer(map, missing);
    let total = 0;
    for (const part of doc.parts) {
      const r = rewriteXml(part.scan, TOKEN_FIND, rep);
      if (r.xml !== null) { part.entry.changed = ENC.encode(r.xml); total += r.count; }
    }
    const strRep = s => s.replace(TOKEN_FIND, (...a) => { const v = rep(a); return v === null ? a[0] : v; });
    for (const e of doc.entries) {
      if (e.name === 'Preview/PrvText.txt') await rewriteText(e, strRep);
      else if (e.name === 'Contents/content.hpf') {
        await rewriteText(e, s => s.replace(/(<(?:\w+:)?(?:title|meta)\b[^>]*>)([^<]+)(<\/(?:\w+:)?(?:title|meta)>)/g,
          (m, a, t, b) => a + encodeEnt(strRep(decodeEnt(t))) + b));
      }
    }
    const out = await writeZip(doc.entries);
    for (const e of doc.entries) delete e.changed;
    return { bytes: out, count: total, missing: [...missing] };
  }

  function restoreText(text, map) {
    const missing = new Set();
    const rep = restorer(map, missing);
    let n = 0;
    const out = text.replace(TOKEN_FIND, (...a) => { const v = rep(a); if (v === null) return a[0]; n++; return v; });
    return { text: out, count: n, missing: [...missing] };
  }

  // 기억해 둔 열쇠 가운데 이 결과물의 표시와 가장 많이 맞는 것
  function bestKey(keys, tokens) {
    let best = null, score = 0;
    for (const k of keys) {
      let s = 0;
      for (const t of tokens) if (Object.prototype.hasOwnProperty.call(k.map, t)) s++;
      if (s > score) { best = k; score = s; }
    }
    return best;
  }

  function makeKey(fileNames, map) {
    return { type: 'hwp-masker-key', version: 1, created: new Date().toISOString(), files: fileNames, map };
  }

  function parseKey(text) {
    let k;
    try { k = JSON.parse(text); } catch (e) { throw new HGError('badkey'); }
    if (!k || k.type !== 'hwp-masker-key' || typeof k.map !== 'object') throw new HGError('badkey');
    return k;
  }

  // ------------------------------------------------------------ 사진 넣기
  // 문서의 [사진1]·[사진2] 자리(표 칸이나 문단에 그 글자만 있는 곳)에 사진을 차례로 넣는다.
  // 사진 크기는 칸 안쪽(칸 여백·문단 여백·다른 줄을 뺀 곳)에 맞춘다. 사진은 이 컴퓨터 밖으로 나가지 않는다.
  const PHOTO_RE = /^\s*[\[［【]\s*사진\s*(\d{0,3})\s*[\]］】]\s*$/;
  const SHAPES = new Set(['tbl', 'pic', 'rect', 'ellipse', 'arc', 'polygon', 'curve', 'line', 'connectLine', 'container', 'ole', 'equation', 'textart', 'video', 'chart']);
  const NS = { hp: 'http://www.hancom.co.kr/hwpml/2011/paragraph', hc: 'http://www.hancom.co.kr/hwpml/2011/core' };

  // header.xml에서 문단 모양(여백·줄 간격)과 글자 크기만 읽는다. 문단 모양은 처음 나오는 값(HWPUNIT 쪽)을 쓴다.
  function headerStyles(xml) {
    const para = new Map(), chr = new Map();
    const pre = /<(?:\w+:)?paraPr\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?paraPr>/g;
    let m;
    while ((m = pre.exec(xml))) {
      const body = m[2];
      const val = tag => { const x = new RegExp('<(?:\\w+:)?' + tag + '\\b([^>]*)>').exec(body); return x ? attrs(x[1]) : {}; };
      const ls = val('lineSpacing');
      para.set(attrs(m[1]).id, {
        left: +val('left').value || 0, right: +val('right').value || 0, indent: +val('intent').value || 0,
        lsType: ls.type || 'PERCENT', lsVal: ls.value !== undefined ? +ls.value : 160,
      });
    }
    const cre = /<(?:\w+:)?charPr\b([^>]*)>/g;
    while ((m = cre.exec(xml))) { const a = attrs(m[1]); chr.set(a.id, +a.height || 1000); }
    return { para, chr };
  }

  // 줄 뒤에 붙는 줄 간격(실제 한글은 글자 크기 기준: 160%면 글자 크기의 60%)
  function lineExtra(pp, fh) {
    if (!pp) return Math.round(fh * 0.6);
    if (pp.lsType === 'PERCENT') return Math.max(0, Math.round(fh * (pp.lsVal - 100) / 100));
    if (pp.lsType === 'BETWEEN_LINES') return Math.max(0, pp.lsVal);
    return 0;
  }
  function lineHeight(pp, fh) {
    if (pp && (pp.lsType === 'FIXED' || pp.lsType === 'AT_LEAST')) return Math.max(pp.lsVal, fh);
    return fh + lineExtra(pp, fh);
  }

  // 구역 XML을 한 번 훑어 문단·표·줄·칸·그림 번호를 모은다(토큰 번호로 기억해 두고 나중에 그 자리만 바꾼다).
  function photoScan(xml) {
    const toks = xml.match(TOKEN_RE) || [];
    const stack = [], tbls = [], tcs = [], ps = [], paras = [], ids = new Set(), runs = [], tables = [];
    let maxZ = 0, page = null, curT = null, runCp = null, root = -1;
    for (let i = 0; i < toks.length; i++) {
      const s = toks[i];
      if (s[0] !== '<') {
        if (curT) curT.para.text += decodeEnt(s);
        continue;
      }
      if (s[1] === '?' || s[1] === '!') continue;
      const m = TAG_RE.exec(s);
      if (!m) continue;
      const close = m[1] === '/', name = m[2], selfc = m[4] === '/';
      if (close) {
        const outer = stack[stack.length - 2], top = tbls[tbls.length - 1];
        stack.pop();
        if (name === 'tbl') { const t = tbls.pop(); if (t) t.end = i; }
        else if (name === 'tr') { const r = top && top.trs[top.trs.length - 1]; if (r && r.end < 0) r.end = i; }
        else if (name === 'tc') { const c = tcs.pop(); if (c) c.end = i; }
        else if (name === 'p') { const p = ps.pop(); if (p) { p.end = i; if (p.cell) p.cell.paras.push(p); } }
        else if (name === 'run') runs.pop();
        else if (name === 't' && curT) { curT.end = i; curT = null; }
        else if (name === 'linesegarray' && ps.length && ps[ps.length - 1].lseg) ps[ps.length - 1].lseg[1] = i;
        else if ((name === 'caption' || name === 'cellzoneList') && outer === 'tbl' && top && top[name] && top[name][1] < 0) top[name][1] = i;
        continue;
      }
      if (root < 0) root = i;
      const parent = stack[stack.length - 1], a = attrs(m[3]);
      if (SHAPES.has(name)) {
        if (a.zOrder) maxZ = Math.max(maxZ, +a.zOrder || 0);
        if (a.id) ids.add(a.id);
        if (a.instid) ids.add(a.instid);
      }
      const tc = tcs[tcs.length - 1], tb = tbls[tbls.length - 1], pa = ps[ps.length - 1];
      switch (name) {
        case 'tbl':
          if (!selfc) {
            const t = { start: i, end: -1, szTok: -1, h: 0, inMargin: null, cells: [], trs: [], para: pa || null,
              run: runs.length ? runs[runs.length - 1] : -1, pos: null, caption: null, cellzoneList: null, zones: [] };
            tbls.push(t);
            tables.push(t);
          }
          break;
        case 'sz': if (parent === 'tbl' && tb) { tb.szTok = i; tb.h = +a.height || 0; } break;
        case 'pos': if (parent === 'tbl' && tb) tb.pos = a; break;
        case 'inMargin': if (parent === 'tbl' && tb) tb.inMargin = a; break;
        case 'caption': case 'cellzoneList': if (parent === 'tbl' && tb && !tb[name]) tb[name] = [i, selfc ? i : -1]; break;
        case 'cellzone': if (parent === 'cellzoneList' && tb) tb.zones.push({ tok: i, s: +a.startRowAddr || 0, e: +a.endRowAddr || 0 }); break;
        case 'tr': if (parent === 'tbl' && tb && !selfc) tb.trs.push({ start: i, end: -1, cells: [] }); break;
        case 'tc':
          if (!selfc) {
            const tr = tb && tb.trs.length ? tb.trs[tb.trs.length - 1] : null;
            const c = { tbl: tb || null, tr, start: i, end: -1, addrTok: -1, hasMargin: a.hasMargin === '1', row: 0, col: 0, rs: 1, cs: 1, w: 0, h: 0, szTok: -1, margin: null, paras: [] };
            if (tb) tb.cells.push(c);
            if (tr) tr.cells.push(c);
            tcs.push(c);
          }
          break;
        case 'cellAddr': if (parent === 'tc' && tc) { tc.row = +a.rowAddr || 0; tc.col = +a.colAddr || 0; tc.addrTok = i; } break;
        case 'cellSpan': if (parent === 'tc' && tc) { tc.rs = Math.max(1, +a.rowSpan || 1); tc.cs = Math.max(1, +a.colSpan || 1); } break;
        case 'cellSz': if (parent === 'tc' && tc) { tc.w = +a.width || 0; tc.h = +a.height || 0; tc.szTok = i; } break;
        case 'cellMargin': if (parent === 'tc' && tc) tc.margin = a; break;
        case 'p':
          if (!selfc) {
            const inCell = parent === 'subList' && stack[stack.length - 2] === 'tc';
            const p = { start: i, end: -1, paraPr: a.paraPrIDRef, charPr: null, text: '', ts: [], lseg: null, cell: inCell ? tc : null, body: parent === 'sec' };
            ps.push(p);
            paras.push(p);
          }
          break;
        case 'run': if (parent === 'p') runCp = a.charPrIDRef; if (!selfc) runs.push(i); break;
        case 't':
          if (parent === 'run' && pa && !selfc) {
            curT = { para: pa, start: i, end: -1 };
            pa.ts.push(curT);
            if (pa.charPr === null) pa.charPr = runCp;
          }
          break;
        case 'linesegarray': if (parent === 'p' && pa) pa.lseg = [i, selfc ? i : -1]; break;
        case 'pagePr': if (!page) page = { w: +a.width || 0, h: +a.height || 0, land: a.landscape === 'NARROWLY', l: 0, r: 0, g: 0, t: 0, b: 0, hd: 0, ft: 0, done: false }; break;
        case 'margin':
          if (parent === 'pagePr' && page && !page.done) {
            page.done = true;
            page.l = +a.left || 0; page.r = +a.right || 0; page.g = +a.gutter || 0;
            page.t = +a.top || 0; page.b = +a.bottom || 0; page.hd = +a.header || 0; page.ft = +a.footer || 0;
          }
          break;
      }
      if (!selfc) stack.push(name);
    }
    return { toks, paras, ids, maxZ, page, root, tables };
  }

  const cellText = c => c.paras.map(q => q.text).join(' ').replace(/\s+/g, ' ').trim();

  // 사진 자리 하나의 크기(HWPUNIT)와 옆 글(설명 칸) 찾기
  function slotFrame(p, sc, st) {
    const pp = st.para.get(p.paraPr), fh = st.chr.get(p.charPr) || 1000;
    const side = (pp ? pp.left + pp.right + Math.max(0, pp.indent) : 0) + 60;
    if (!p.cell) {
      const pg = sc.page && sc.page.w ? sc.page.w - sc.page.l - sc.page.r - sc.page.g : 42520;
      const w = Math.round(pg * 0.6);
      const k = sc.paras.indexOf(p);
      const next = sc.paras.slice(k + 1).find(q => q.body && q.text.trim() && !PHOTO_RE.test(q.text));
      return { w, h: Math.round(w * 0.75), grow: 0, hint: next ? next.text.trim() : '' };
    }
    const c = p.cell;
    const mg = c.hasMargin && c.margin ? c.margin : (c.tbl && c.tbl.inMargin) || c.margin || { left: 510, right: 510, top: 141, bottom: 141 };
    const innerW = c.w - (+mg.left || 0) - (+mg.right || 0), innerH = c.h - (+mg.top || 0) - (+mg.bottom || 0);
    let other = 0;
    for (const q of c.paras) if (q !== p) other += lineHeight(st.para.get(q.paraPr), st.chr.get(q.charPr) || 1000);
    const last = c.paras[c.paras.length - 1] === p;
    const w = innerW - side;
    let h = innerH - other - (last ? 0 : lineExtra(pp, fh)) - 60, grow = 0;
    if (h < w * 0.45) { grow = Math.round(w * 0.75) - h; h += grow; }
    // 사진 설명: 같은 칸의 다른 줄 → 바로 아래 칸(짧은 설명) → 같은 줄 왼쪽의 제목 칸
    let hint = c.paras.filter(q => q !== p).map(q => q.text.trim()).filter(Boolean).join(' ');
    const cells = c.tbl ? c.tbl.cells : [];
    const usable = d => { const t = cellText(d); return t && !PHOTO_RE.test(t) ? t : ''; };
    if (!hint) {
      const below = cells.find(d => d.col === c.col && d.row === c.row + c.rs);
      if (below && usable(below) && usable(below).length <= 40) hint = usable(below);
    }
    if (!hint) {
      const left = cells.filter(d => d.row <= c.row && c.row < d.row + d.rs && d.col < c.col && usable(d)).sort((a, b) => b.col - a.col)[0];
      if (left) hint = usable(left);
    }
    return { w: Math.max(0, w), h: Math.max(0, h), grow, hint };
  }

  async function photoContext(doc) {
    if (doc._photo) return doc._photo;
    const he = doc.entries.find(e => e.name === 'Contents/header.xml');
    const st = he ? headerStyles(DEC.decode(await entryBytes(he))) : { para: new Map(), chr: new Map() };
    const slots = [], scans = [];
    let maxZ = 0;
    const ids = new Set();
    for (const part of doc.parts) {
      if (!/section\d*\.xml$/.test(part.entry.name)) continue;
      const sc = photoScan(part.xml);
      scans.push({ part, sc });
      maxZ = Math.max(maxZ, sc.maxZ);
      sc.ids.forEach(x => ids.add(x));
      for (const p of sc.paras) {
        if (!(p.cell || p.body) || !p.ts.length || !PHOTO_RE.test(p.text)) continue;
        const f = slotFrame(p, sc, st);
        if (f.w < 1500 || f.h < 1000) continue;
        slots.push(Object.assign({ label: p.text.trim(), part, sc, para: p }, f));
      }
    }
    doc._photo = { slots, scans, maxZ, ids };
    return doc._photo;
  }

  // 사진 자리 목록: [{label:'[사진1]', w, h(HWPUNIT, 사진이 들어갈 틀), hint:'아래 칸: 1회 특강'}] 문서 차례대로
  async function photoSlots(doc) {
    const ctx = await photoContext(doc);
    return ctx.slots.map(s => ({ label: s.label, w: s.w, h: s.h, hint: s.hint }));
  }

  function fitBox(s, pxW, pxH, mode) {
    if (mode !== 'contain' || !pxW || !pxH) return { w: s.w, h: s.h };
    const k = Math.min(s.w / pxW, s.h / pxH);
    return { w: Math.max(1, Math.round(pxW * k)), h: Math.max(1, Math.round(pxH * k)) };
  }

  function newId(ids) {
    let v;
    do { v = String(100000000 + Math.floor(Math.random() * 2000000000)); } while (ids.has(v));
    ids.add(v);
    return v;
  }

  // 실제 한글이 저장하는 그림 XML 모양 그대로(글자처럼 취급, 원본 크기는 96dpi 기준 픽셀×75)
  function picXml(o) {
    const ow = o.pxW * 75, oh = o.pxH * 75;
    const sx = (o.w / ow).toFixed(6), sy = (o.h / oh).toFixed(6);
    return '<hp:pic id="' + o.id + '" zOrder="' + o.z + '" numberingType="PICTURE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" href="" groupLevel="0" instid="' + o.instid + '" reverse="0">'
      + '<hp:offset x="0" y="0"/><hp:orgSz width="' + ow + '" height="' + oh + '"/><hp:curSz width="' + o.w + '" height="' + o.h + '"/>'
      + '<hp:flip horizontal="0" vertical="0"/><hp:rotationInfo angle="0" centerX="' + (o.w >> 1) + '" centerY="' + (o.h >> 1) + '" rotateimage="1"/>'
      + '<hp:renderingInfo><hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:scaMatrix e1="' + sx + '" e2="0" e3="0" e4="0" e5="' + sy + '" e6="0"/><hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/></hp:renderingInfo>'
      + '<hc:img binaryItemIDRef="' + o.binId + '" bright="0" contrast="0" effect="REAL_PIC" alpha="0"/>'
      + '<hp:imgRect><hc:pt0 x="0" y="0"/><hc:pt1 x="' + ow + '" y="0"/><hc:pt2 x="' + ow + '" y="' + oh + '"/><hc:pt3 x="0" y="' + oh + '"/></hp:imgRect>'
      + '<hp:imgClip left="0" right="' + ow + '" top="0" bottom="' + oh + '"/><hp:inMargin left="0" right="0" top="0" bottom="0"/>'
      + '<hp:imgDim dimwidth="' + ow + '" dimheight="' + oh + '"/><hp:effects/>'
      + '<hp:sz width="' + o.w + '" widthRelTo="ABSOLUTE" height="' + o.h + '" heightRelTo="ABSOLUTE" protect="0"/>'
      + '<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>'
      + '<hp:outMargin left="0" right="0" top="0" bottom="0"/><hp:shapeComment>그림입니다.</hp:shapeComment></hp:pic>';
  }

  // photos: 사진 자리 차례대로 [{bytes(JPEG·PNG), pxW, pxH, type:'image/jpeg', mode:'cover'|'contain'} | null]
  // 'cover'면 사진을 틀 비율로 미리 잘라 둔 것으로 보고 틀 크기 그대로, 'contain'이면 틀 안에 비율대로 넣는다.
  async function insertPhotos(doc, photos) {
    const ctx = await photoContext(doc);
    const entries = doc.entries.slice();
    const hpf = entries.find(e => e.name === 'Contents/content.hpf');
    if (!hpf) throw new HGError('broken');
    let hpfText = DEC.decode(await entryBytes(hpf));
    let next = 1;
    for (const e of entries) { const x = /^BinData\/[A-Za-z]*(\d+)\./.exec(e.name); if (x) next = Math.max(next, +x[1] + 1); }
    for (const x of hpfText.matchAll(/\bid="[A-Za-z]*(\d+)"/g)) next = Math.max(next, +x[1] + 1);
    const ref = entries.find(e => e.name === 'mimetype') || entries[0];
    const pre = (/<(\w+:)?item\b/.exec(hpfText) || [])[1] || '';
    const items = [], added = [], byScan = new Map();
    let z = ctx.maxZ, count = 0;
    ctx.slots.forEach((s, k) => {
      const ph = photos[k];
      if (!ph || !ph.bytes || !ph.pxW || !ph.pxH) return;
      const png = ph.type === 'image/png';
      const binId = 'image' + next++;
      const name = 'BinData/' + binId + (png ? '.png' : '.jpg');
      added.push({ name, method: 0, time: ref.time, date: ref.date, crc: 0, usize: 0, raw: new Uint8Array(0), changed: ph.bytes });
      items.push('<' + pre + 'item id="' + binId + '" href="' + name + '" media-type="' + (png ? 'image/png' : 'image/jpeg') + '" isEmbeded="1"/>');
      const box = fitBox(s, ph.pxW, ph.pxH, ph.mode);
      const xml = picXml({ id: newId(ctx.ids), instid: newId(ctx.ids), z: ++z, binId, pxW: ph.pxW, pxH: ph.pxH, w: box.w, h: box.h });
      if (!byScan.has(s.sc)) byScan.set(s.sc, { part: s.part, list: [] });
      byScan.get(s.sc).list.push({ s, xml });
      count++;
    });
    if (!count) return { bytes: null, count: 0 };
    try {
      for (const [sc, { part, list }] of byScan) part.entry.changed = ENC.encode(withPhotos(sc, list));
      hpfText = hpfText.replace(/<\/(\w+:)?manifest>/, m => items.join('') + m);
      hpf.changed = ENC.encode(hpfText);
      const lastBin = entries.map(e => /^BinData\//.test(e.name)).lastIndexOf(true);
      entries.splice(lastBin >= 0 ? lastBin + 1 : entries.length, 0, ...added);
      return { bytes: await writeZip(entries), count };
    } finally {
      for (const e of doc.entries) delete e.changed;
    }
  }

  function withPhotos(sc, list) {
    const { toks } = sc;
    const rep = new Map(), drop = new Set(), rowGrow = new Map();
    for (const { s, xml } of list) {
      const p = s.para;
      const tPre = (/^<(\w+:)?t\b/.exec(toks[p.ts[0].start]) || [])[1] || '';
      p.ts.forEach((t, k) => {
        rep.set(t.start, (k === 0 ? xml : '') + '<' + tPre + 't/>');
        for (let i = t.start + 1; i <= t.end; i++) drop.add(i);
      });
      if (p.lseg && p.lseg[1] >= p.lseg[0]) for (let i = p.lseg[0]; i <= p.lseg[1]; i++) drop.add(i);
      if (s.grow > 0 && p.cell && p.cell.tbl) {
        const t = p.cell.tbl;
        if (!rowGrow.has(t)) rowGrow.set(t, new Map());
        const g = rowGrow.get(t);
        g.set(p.cell.row, Math.max(g.get(p.cell.row) || 0, s.grow));
      }
    }
    // 납작한 칸은 사진이 4:3으로 들어가게 그 줄 높이를 키운다(한글이 열 때 다시 계산하지만 미리 맞춰 둔다).
    const setH = (i, h) => { rep.set(i, toks[i].replace(/\bheight="\d+"/, 'height="' + h + '"')); };
    for (const [t, g] of rowGrow) {
      let total = 0;
      for (const v of g.values()) total += v;
      for (const c of t.cells) {
        let add = 0;
        for (const [row, v] of g) if (c.row <= row && row < c.row + c.rs) add += v;
        if (add && c.szTok >= 0) setH(c.szTok, c.h + add);
      }
      if (t.szTok >= 0) setH(t.szTok, t.h + total);
    }
    if (sc.root >= 0) {
      let r = rep.has(sc.root) ? rep.get(sc.root) : toks[sc.root];
      for (const [k, uri] of Object.entries(NS)) if (!new RegExp('\\sxmlns:' + k + '=').test(r)) r = r.replace(/\s*(\/?>)$/, ' xmlns:' + k + '="' + uri + '"$1');
      rep.set(sc.root, r);
    }
    let out = '';
    for (let i = 0; i < toks.length; i++) {
      if (drop.has(i)) continue;
      out += rep.has(i) ? rep.get(i) : toks[i];
    }
    return out;
  }

  // ------------------------------------------------------------ 사진 자리 늘리기·줄이기
  // 사진이 자리보다 많으면 마지막 사진 표의 마지막 묶음(사진 줄 + 그 아래 설명 줄)을 같은 모양으로 이어 붙이고,
  // 적으면 뒤쪽의 빈 묶음을 지운다. 글자처럼 취급한 표는 쪽을 넘겨 나뉘지 않아 한 쪽보다 길면 아래가 잘리므로,
  // 엔진(hwpdoc.py)과 같은 규칙으로 표 하나를 쪽 본문 높이 - PHOTO_ROOM까지만 키우고 넘치면 새 표로 잇는다.
  const PHOTO_ROOM = 10000;
  const UNIT_TAGS = new Set(['tr', 'tc', 'subList', 'p', 'run', 't', 'cellAddr', 'cellSpan', 'cellSz', 'cellMargin', 'linesegarray', 'lineseg']);

  function bodyLimit(sc) {
    const g = sc.page;
    const h = g && (g.land ? g.w : g.h) ? (g.land ? g.w : g.h) - g.t - g.b - g.hd - g.ft : 0;
    return (h > PHOTO_ROOM * 2 ? h : 70018) - PHOTO_ROOM;
  }
  const setAttr = (tok, k, v) => (new RegExp('\\b' + k + '="[^"]*"').test(tok)
    ? tok.replace(new RegExp('\\b' + k + '="[^"]*"'), k + '="' + v + '"') : tok.replace(/\s*(\/?>)$/, ' ' + k + '="' + v + '"$1'));
  const emptyT = tok => '<' + ((/^<(\w+:)?t\b/.exec(tok) || [])[1] || '') + 't/>';
  const bfOf = tok => (/\bborderFillIDRef="([^"]*)"/.exec(tok) || [])[1];
  const sameShape = (a, b) => a.cells.length === b.cells.length && a.cells.every((c, j) => c.col === b.cells[j].col && c.cs === b.cells[j].cs && c.rs === b.cells[j].rs);
  // 표 끝 줄의 테두리(아래 굵은 선 등)를 다른 줄로 옮길 때 쓴다: 줄 tr의 칸들 테두리 번호를 bf 목록으로 바꾼다
  const setRowBF = (ed, toks, tr, bf) => tr.cells.forEach((c, j) => { if (bf[j] && bfOf(toks[c.start]) !== bf[j]) ed.rep.set(c.start, setAttr(toks[c.start], 'borderFillIDRef', bf[j])); });

  // 표 하나의 줄 정보: 높이(줄 하나짜리 칸 중 가장 큰 높이), 사진이 4:3으로 들어가며 늘어날 몫, 사진 자리 칸
  function photoRows(ctx, tb) {
    const bySlot = new Map();
    for (const s of ctx.slots) if (s.para.cell && s.para.cell.tbl === tb) {
      if (!bySlot.has(s.para.cell)) bySlot.set(s.para.cell, []);
      bySlot.get(s.para.cell).push(s);
    }
    const rows = tb.trs.map(tr => {
      const one = tr.cells.filter(c => c.rs === 1).map(c => c.h);
      const ph = tr.cells.filter(c => bySlot.has(c));
      const grow = Math.max(0, ...ph.flatMap(c => bySlot.get(c).map(x => x.grow || 0)));
      return { tr, h: one.length ? Math.max(...one) : 0, grow, ph, photo: ph.length > 0 };
    });
    // 묶음: 사진 줄 + 다음 사진 줄 전까지의 줄. 첫 사진 줄 앞의 줄(제목 줄 등)은 첫 묶음에 붙인다
    const first = rows.findIndex(r => r.photo);
    const units = [];
    if (first >= 0) {
      for (let i = first; i < rows.length; i++) {
        if (rows[i].photo || !units.length) units.push([i]); else units[units.length - 1].push(i);
      }
      for (let i = first - 1; i >= 0; i--) units[0].unshift(i);
    }
    const uo = [];
    units.forEach((u, k) => u.forEach(i => { uo[i] = k; }));
    // 여러 줄을 합친 칸이 묶음 경계를 넘으면 줄 단위로 지우거나 복제할 수 없다
    const crosses = rows.some((r, i) => r.tr.cells.some(c => c.rs > 1 && uo[i] !== uo[Math.min(rows.length - 1, i + c.rs - 1)]))
      || rows.some((r, i) => r.tr.cells.some(c => i + c.rs > rows.length));
    return { rows, units, bySlot, crosses };
  }

  // 문단 p 안에 skip 범위들 말고는 빈 글자·run·줄 정보만 있는지(그러면 문단째 지워도 된다)
  function onlyIn(toks, p, skip) {
    for (let i = p.start + 1; i < p.end; i++) {
      const r = skip.find(x => x[0] <= i && i <= x[1]);
      if (r) { i = r[1]; continue; }
      const t = toks[i];
      if (t[0] !== '<') { if (t.trim()) return false; continue; }
      const m = TAG_RE.exec(t);
      if (m && !['run', 't', 'linesegarray', 'lineseg'].includes(m[2])) return false;
    }
    return true;
  }

  function lastUnitPlan(ctx) {
    const S = ctx.slots.length;
    if (!S) return { ok: false, why: 'none' };
    const L = ctx.slots[S - 1], c = L.para.cell;
    if (!c || !c.tbl || !c.tr) return { ok: false, why: 'notable' };
    const tb = c.tbl, sc = L.sc;
    if (!tb.para || tb.para.end < 0 || tb.run < 0 || tb.end < 0 || !tb.trs.length || tb.trs.some(r => r.end < 0)) return { ok: false, why: 'shape' };
    const pr = photoRows(ctx, tb);
    if (!pr.units.length || pr.crosses) return { ok: false, why: 'span' };
    const u = pr.units[pr.units.length - 1];
    if (!u.some(i => pr.rows[i].tr === c.tr)) return { ok: false, why: 'shape' };
    // 복제할 묶음에는 줄·칸·글자만 있어야 한다(그림·표·필드 같은 개체가 있으면 늘리지 않는다)
    const lo = pr.rows[u[0]].tr.start, hi = pr.rows[u[u.length - 1]].tr.end;
    let inT = false;
    for (let i = lo; i <= hi; i++) {
      const t = sc.toks[i];
      if (t[0] !== '<') continue;
      const m = TAG_RE.exec(t);
      if (!m) continue;
      if (inT) { if (m[1] === '/' && m[2] === 't') inT = false; continue; }
      if (!UNIT_TAGS.has(m[2])) return { ok: false, why: 'obj' };
      if (m[2] === 't' && !m[1] && !m[4]) inT = true;
    }
    const unitSlots = ctx.slots.filter(s => s.para.cell && u.some(i => pr.rows[i].tr === s.para.cell.tr));
    if (!unitSlots.length) return { ok: false, why: 'shape' };
    return { ok: true, sc, part: L.part, tb, pr, u, lo, hi, unitSlots };
  }

  // 사진 자리를 n곳으로 늘린다(마지막 묶음 복제)
  function growEdits(ctx, g, n) {
    const { sc, tb, pr, u, lo, hi, unitSlots } = g;
    const toks = sc.toks, rows = pr.rows, S = ctx.slots.length;
    const k = unitSlots.length, nu = Math.ceil((n - S) / k);
    const uh = u.reduce((a, i) => a + rows[i].h + rows[i].grow, 0), uhRaw = u.reduce((a, i) => a + rows[i].h, 0);
    const limit = bodyLimit(sc);
    const tMap = new Map(), addr = new Map(), skips = [];
    u.forEach((ri, j) => {
      for (const c of rows[ri].tr.cells) {
        if (c.addrTok >= 0) addr.set(c.addrTok, j);
        for (const p of c.paras) {
          if (p.lseg && p.lseg[1] >= p.lseg[0]) skips.push(p.lseg);
          p.ts.forEach((t, q) => { if (t.end >= t.start) tMap.set(t.start, { t, p, first: q === 0 }); });
        }
      }
    });
    // 테두리: 표의 마지막 줄은 아래 테두리(굵은 선 등)를 가진 경우가 많다. 묶음을 이어 붙이면 그 줄이 가운데로 가므로
    // 앞 묶음 마지막 줄(가운데 줄)의 테두리로 바꾸고, 맨 마지막에 붙는 묶음에만 원래 테두리를 남긴다.
    const lastRow = rows[u[u.length - 1]], prevU = pr.units.length > 1 ? pr.units[pr.units.length - 2] : null;
    let mid = prevU && prevU[prevU.length - 1] > 0 ? rows[prevU[prevU.length - 1]] : null;
    if (!mid && pr.units.length === 1) {
      // 묶음마다 나뉜 사진 표: 바로 앞 사진 표의 마지막 줄(가운데 줄)의 테두리를 쓴다
      const k0 = ctx.slots.indexOf(unitSlots[0]), ps = k0 > 0 ? ctx.slots[k0 - 1] : null;
      const ptb = ps && ps.sc === sc && ps.para.cell && ps.para.cell.tbl;
      if (ptb && ptb !== tb && ptb.trs.length) mid = { tr: ptb.trs[ptb.trs.length - 1] };
    }
    const midBF = mid && mid !== lastRow && sameShape(mid.tr, lastRow.tr) ? mid.tr.cells.map(c => bfOf(toks[c.start])) : null;
    const lastTc = new Map(lastRow.tr.cells.map((c, j) => [c.start, j]));
    let num = S, made = 0;
    const cloneUnit = rowBase => {
      const lab = new Map(unitSlots.map(s => { num++; return [s.para, num <= n ? '[사진' + num + ']' : '']; }));
      const useMid = midBF && ++made < nu;
      let out = '';
      for (let i = lo; i <= hi; i++) {
        const sk = skips.find(r => r[0] === i);
        if (sk) { i = sk[1]; continue; }
        if (useMid && lastTc.has(i) && midBF[lastTc.get(i)]) { out += setAttr(toks[i], 'borderFillIDRef', midBF[lastTc.get(i)]); continue; }
        const tm = tMap.get(i);
        if (tm) {
          const text = tm.first && lab.get(tm.p);
          const pre = (/^<(\w+:)?t\b/.exec(toks[i]) || [])[1] || '';
          out += text ? '<' + pre + 't>' + text + '</' + pre + 't>' : '<' + pre + 't/>';
          i = tm.t.end;
          continue;
        }
        out += addr.has(i) ? toks[i].replace(/\browAddr="\d+"/, 'rowAddr="' + (rowBase + addr.get(i)) + '"') : toks[i];
      }
      return out;
    };
    const ed = { part: g.part, rep: new Map(), drop: [], after: new Map() };
    if (midBF) setRowBF(ed, toks, lastRow.tr, midBF);
    // 묶음 하나짜리 표(엔진이 묶음마다 나눈 사진 표)는 키우지 않고 같은 모양의 새 표를 묶음마다 하나씩 잇는다.
    // 한 표로 키우면 쪽 끝에 다 들어가지 않을 때 표 전체가 다음 쪽으로 넘어가 앞 쪽 아래가 크게 빈다.
    const single = pr.units.length === 1;
    // 1) 지금 표에 쪽 높이가 허락하는 만큼 묶음을 붙인다
    let th = rows.reduce((a, r) => a + r.h + r.grow, 0), inT = 0;
    while (!single && inT < nu && th + uh <= limit) { th += uh; inT++; }
    if (inT) {
      let base = rows.length, add = '';
      for (let q = 0; q < inT; q++) { add += cloneUnit(base); base += u.length; }
      ed.rep.set(tb.end, add + toks[tb.end]);
      ed.rep.set(tb.start, setAttr(toks[tb.start], 'rowCnt', base));
      if (tb.szTok >= 0) ed.rep.set(tb.szTok, setAttr(toks[tb.szTok], 'height', tb.h + inT * uhRaw));
    }
    // 2) 남은 묶음은 같은 모양의 새 표에 나눠 담아 바로 뒤 문단으로 붙인다
    let left = nu - inT;
    if (left > 0) {
      const per = single ? 1 : Math.max(1, Math.floor(limit / uh));
      const cut = [tb.caption, tb.cellzoneList].filter(r => r && r[1] >= r[0]);
      let shell = '', omTok = -1;
      for (let i = tb.start + 1; i < rows[0].tr.start; i++) {
        const r = cut.find(x => x[0] <= i && i <= x[1]);
        if (r) { i = r[1]; continue; }
        if (single && omTok < 0 && /^<(\w+:)?outMargin\b/.test(toks[i])) { omTok = i; shell += '\u0000OM\u0000'; continue; }
        shell += i === tb.szTok ? '\u0000SZ\u0000' : toks[i];
      }
      // 이어 붙이는 표끼리 맞닿는 쪽의 바깥 여백을 없애 한 쪽 안에서는 한 표처럼 붙어 보이게 한다
      const om = last => (omTok < 0 ? '' : last ? setAttr(toks[omTok], 'top', '0') : setAttr(setAttr(toks[omTok], 'top', '0'), 'bottom', '0'));
      if (omTok >= 0) ed.rep.set(omTok, setAttr(toks[omTok], 'bottom', '0'));
      const pOpen = setAttr(setAttr(toks[tb.para.start], 'pageBreak', '0'), 'columnBreak', '0');
      const rpre = (/^<(\w+:)?run\b/.exec(toks[tb.run]) || [])[1] || '';
      const tpre = (/^<(\w+:)?tbl\b/.exec(toks[tb.start]) || [])[1] || '';
      let paras = '', z = ctx.maxZ;
      while (left > 0) {
        const m = Math.min(per, left);
        let body = '', base = 0;
        for (let q = 0; q < m; q++) { body += cloneUnit(base); base += u.length; }
        let open = setAttr(toks[tb.start], 'rowCnt', base);
        open = setAttr(open, 'id', newId(ctx.ids));
        if (/\bzOrder="/.test(open)) open = setAttr(open, 'zOrder', ++z);
        const sz = tb.szTok >= 0 ? setAttr(toks[tb.szTok], 'height', m * uhRaw) : '';
        paras += pOpen + toks[tb.run] + open + shell.replace('\u0000SZ\u0000', sz).replace('\u0000OM\u0000', om(m === left)) + body + toks[tb.end]
          + '<' + tpre + 't/>' + '</' + rpre + 'run>' + toks[tb.para.end];
        left -= m;
      }
      ctx.maxZ = z;
      ed.after.set(tb.para.end, paras);
    }
    if (tb.para.lseg && tb.para.lseg[1] >= tb.para.lseg[0]) ed.drop.push(tb.para.lseg);
    return new Map([[sc, ed]]);
  }

  // 사진 자리를 n곳으로 줄인다: 뒤쪽 빈 묶음은 줄째 지우고, 반만 찬 묶음은 빈 사진 칸과 그 아래 설명 칸을 비운다
  function shrinkEdits(ctx, n) {
    const out = new Map(), idx = new Map(ctx.slots.map((s, k) => [s, k])), seen = new Set(), dels = new Map();
    const E = s => {
      if (!out.has(s.sc)) out.set(s.sc, { part: s.part, rep: new Map(), drop: [], after: new Map() });
      return out.get(s.sc);
    };
    const blank = (ed, toks, p) => {
      for (const t of p.ts) {
        if (t.end < t.start) continue;
        ed.rep.set(t.start, emptyT(toks[t.start]));
        if (t.end > t.start) ed.drop.push([t.start + 1, t.end]);
      }
      if (p.lseg && p.lseg[1] >= p.lseg[0]) ed.drop.push(p.lseg);
    };
    for (let k = n; k < ctx.slots.length; k++) {
      const s = ctx.slots[k], ed = E(s), toks = s.sc.toks, c = s.para.cell;
      if (!c) {
        if (s.para.body && s.para.end > s.para.start && onlyIn(toks, s.para, s.para.ts.map(t => [t.start, t.end]))) ed.drop.push([s.para.start, s.para.end]);
        else blank(ed, toks, s.para);
        continue;
      }
      const tb = c.tbl;
      if (!tb || seen.has(tb)) continue;
      seen.add(tb);
      const { rows, units, bySlot, crosses } = photoRows(ctx, tb);
      const whole = !crosses && tb.para && tb.para.end > tb.para.start && tb.end > tb.start && tb.trs.every(r => r.end > r.start);
      const gone = units.map(u => whole && u.every(i => rows[i].ph.every(cc => bySlot.get(cc).every(x => idx.get(x) >= n))));
      if (units.length && gone.every(Boolean)) {
        // 표 전체가 빈 자리 → 표만 있는 문단이면 문단째, 아니면 표만 지운다
        if (onlyIn(toks, tb.para, [[tb.start, tb.end]])) ed.drop.push([tb.para.start, tb.para.end]);
        else ed.drop.push([tb.start, tb.end]);
        continue;
      }
      const del = new Set();
      units.forEach((u, j) => { if (gone[j]) u.forEach(i => del.add(i)); });
      dels.set(tb, del);
      if (del.size) {
        const keep = rows.map((r, i) => i).filter(i => !del.has(i));
        const nr = new Map(keep.map((i, j) => [i, j]));
        for (const i of del) ed.drop.push([rows[i].tr.start, rows[i].tr.end]);
        for (const i of keep) for (const cc of rows[i].tr.cells) {
          if (cc.addrTok >= 0 && nr.get(i) !== i) ed.rep.set(cc.addrTok, toks[cc.addrTok].replace(/\browAddr="\d+"/, 'rowAddr="' + nr.get(i) + '"'));
        }
        ed.rep.set(tb.start, setAttr(toks[tb.start], 'rowCnt', keep.length));
        if (tb.szTok >= 0) ed.rep.set(tb.szTok, setAttr(toks[tb.szTok], 'height', Math.max(1, tb.h - [...del].reduce((a, i) => a + rows[i].h, 0))));
        let zl = 0;
        for (const zn of tb.zones) {
          const kept = keep.filter(i => zn.s <= i && i <= zn.e);
          if (!kept.length) { ed.drop.push([zn.tok, zn.tok]); continue; }
          zl++;
          ed.rep.set(zn.tok, setAttr(setAttr(toks[zn.tok], 'startRowAddr', nr.get(kept[0])), 'endRowAddr', nr.get(kept[kept.length - 1])));
        }
        if (tb.cellzoneList && tb.cellzoneList[1] >= tb.cellzoneList[0] && tb.zones.length && !zl) ed.drop.push(tb.cellzoneList);
        if (tb.para && tb.para.lseg && tb.para.lseg[1] >= tb.para.lseg[0]) ed.drop.push(tb.para.lseg);
      }
      // 남은 묶음 안의 빈 자리: 사진 칸 글자와 같은 묶음에서 그 칸 아래(같은 열 범위)의 설명 칸을 비운다
      units.forEach((u, j) => {
        if (gone[j]) return;
        for (const i of u) for (const cc of rows[i].ph) {
          if (!bySlot.get(cc).every(x => idx.get(x) >= n)) continue;
          cc.paras.forEach(p => blank(ed, toks, p));
          for (const i2 of u) if (!rows[i2].photo) {
            for (const d of rows[i2].tr.cells) if (d.col >= cc.col && d.col + d.cs <= cc.col + cc.cs) d.paras.forEach(p => blank(ed, toks, p));
          }
        }
      });
    }
    // 표 끝이 앞으로 당겨졌으면(뒤 묶음·뒤 표를 지움) 원래 마지막 줄의 테두리(아래 굵은 선 등)를 새 마지막 줄에 옮긴다
    const keep = ctx.slots[n - 1], last = ctx.slots[ctx.slots.length - 1];
    const kt = keep.para.cell && keep.para.cell.tbl, lt = last.para.cell && last.para.cell.tbl;
    if (kt && lt && lt.trs.length) {
      const del = dels.get(kt) || new Set();
      const kept = kt.trs.filter((r, i) => !del.has(i));
      const newLast = kept[kept.length - 1], origLast = lt.trs[lt.trs.length - 1];
      if (newLast && newLast !== origLast && kept.length > 1 && sameShape(newLast, origLast)) {
        setRowBF(E(keep), keep.sc.toks, newLast, origLast.cells.map(c => bfOf(last.sc.toks[c.start])));
      }
    }
    return out;
  }

  function applyEdits(sc, ed) {
    const { toks } = sc, cut = new Uint8Array(toks.length);
    for (const [a, b] of ed.drop) for (let i = a; i <= b; i++) cut[i] = 1;
    let out = '';
    for (let i = 0; i < toks.length; i++) {
      if (!cut[i]) out += ed.rep.has(i) ? ed.rep.get(i) : toks[i];
      if (ed.after.has(i)) out += ed.after.get(i);
    }
    return out;
  }

  // 사진 자리를 늘리거나 줄일 수 있는지: { slots, canGrow, why, unit:[{w,h}] (늘릴 때 새 자리 크기, 차례대로 되풀이) }
  async function photoPlan(doc) {
    const ctx = await photoContext(doc);
    const g = lastUnitPlan(ctx);
    return { slots: ctx.slots.length, canGrow: g.ok, why: g.ok ? '' : g.why, unit: g.ok ? g.unitSlots.map(s => ({ w: s.w, h: s.h })) : [] };
  }

  // 사진 자리를 n곳으로 맞춘 새 파일 bytes. 바꿀 수 없으면 bytes: null(why에 까닭)
  async function fitPhotoSlots(doc, n) {
    const ctx = await photoContext(doc);
    const S = ctx.slots.length;
    n = Math.max(1, Math.floor(+n || 0));
    if (!S || n === S) return { bytes: null, why: S ? 'same' : 'none' };
    let edits;
    if (n > S) {
      const g = lastUnitPlan(ctx);
      if (!g.ok) return { bytes: null, why: g.why };
      edits = growEdits(ctx, g, n);
    } else {
      edits = shrinkEdits(ctx, n);
    }
    const entries = doc.entries.slice();
    try {
      for (const [sc, ed] of edits) ed.part.entry.changed = ENC.encode(applyEdits(sc, ed));
      return { bytes: await writeZip(entries), why: '' };
    } finally {
      for (const e of doc.entries) delete e.changed;
    }
  }

  return {
    HGError, KINDS, KIND, TOK_KIND, canStream, openHwpx, detect, addManual, guessKind, assignTokens, maskFile, maskText,
    previewMasked, fileTokens, tokensIn, restoreFile, restoreText, bestKey, makeKey, parseKey, docParas,
    photoSlots, insertPhotos, photoPlan, fitPhotoSlots,
    _test: { scanXml, replaceInPieces, rewriteXml, readZip, writeZip, crc32, labelKind, validFor, RE, TOKEN_FIND, photoScan, headerStyles, PHOTO_RE },
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = HG;
