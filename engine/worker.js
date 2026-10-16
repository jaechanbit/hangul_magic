/* 한글 엔진 일꾼: 브라우저 안 파이썬(Pyodide)에서 hwpdoc.py를 돌린다. 문서는 이 컴퓨터 밖으로 나가지 않는다. */
let ready = null;
// 진행 단계와 보안 정책 차단을 화면에 알린다(문제 찾기용).
const T0 = performance.now();
const sec = () => ((performance.now() - T0) / 1000).toFixed(1) + '초';
function stage(text) { self.postMessage({ stage: text + ' ' + sec() }); }
self.addEventListener('securitypolicyviolation', (e) => stage('차단: ' + e.violatedDirective + ' ' + (e.blockedURI || '')));
self.addEventListener('error', (e) => stage('오류: ' + e.message));
self.addEventListener('unhandledrejection', (e) => stage('놓친 오류: ' + ((e.reason && e.reason.message) || e.reason)));
// 살아 있는지 알리는 신호: 이게 멈추면 일꾼이 파이썬 안에서 묶여 있는 것이다.
setInterval(() => self.postMessage({ beat: sec() }), 2000);
const LXML = 'lxml-6.0.2-cp313-cp313-pyemscripten_2025_0_wasm32.whl';

// 클로드 페이지는 압축 파일(.zip·.whl)을 그대로 못 올려서 글자(base64)로 올린다. 파이썬이 그 파일을 달라고 하면 풀어서 건넨다.
const realFetch = self.fetch.bind(self);
async function fromB64(url) {
  const text = await (await realFetch(url + '.b64.txt')).text();
  const bin = atob(text.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
self.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : (input.href || input.url || String(input));
  const name = url.split('/').pop().slice(0, 24);
  stage('받기 ' + name);
  if (/(python_stdlib\.zip|\.whl)$/.test(url)) {
    const r = new Response(await fromB64(url), { headers: { 'content-type': 'application/zip' } });
    stage('받음 ' + name);
    return r;
  }
  const r = await realFetch(input, init);
  stage('받음 ' + name + ' ' + r.status);
  return r;
};

function boot() {
  if (ready) return ready;
  ready = (async () => {
    const lib = new URL('../lib/', self.location.href).href;
    stage('일꾼 시작');
    importScripts(lib + 'pyodide/pyodide.js');
    stage('파이썬 불러오는 중');
    const py = await loadPyodide({ indexURL: lib + 'pyodide/', stdout: (t) => stage('출력 ' + t.slice(0, 60)), stderr: (t) => stage('경고 ' + t.slice(0, 60)) });
    stage('파이썬 준비 끝');
    stage('lxml 불러오는 중');
    await py.loadPackage(lib + 'wheels/' + LXML);
    stage('엔진 받는 중');
    const resp = await fetch(new URL('hwpdoc.py', self.location.href));
    const src = await resp.text();
    stage('엔진 받음 ' + resp.status + ' ' + src.length + '자');
    py.FS.writeFile('/hwpdoc.py', src);
    py.runPython("import sys\nsys.path.insert(0, '/')");
    py.runPython('import lxml.etree');
    stage('lxml 열림');
    py.runPython('import hwpdoc');
    stage('엔진 열림');
    return py;
  })();
  return ready;
}

// 엔진 명령 하나를 돌리고 화면에 찍힌 글과 만들어진 파일을 돌려준다.
async function run(py, argv, files, outputs) {
  for (const [name, bytes] of Object.entries(files || {})) py.FS.writeFile('/w/' + name, bytes);
  py.globals.set('ARGV', py.toPy(argv));
  stage('실행 중');
  const res = py.runPython(`
import io, contextlib, hwpdoc
_buf = io.StringIO()
with contextlib.redirect_stdout(_buf), contextlib.redirect_stderr(_buf):
    _code = hwpdoc.main(list(ARGV))
(_code, _buf.getvalue())
`).toJs();
  stage('실행 끝');
  const out = {};
  for (const name of outputs || []) {
    try { out[name] = py.FS.readFile('/w/' + name); } catch (e) { out[name] = null; }
  }
  return { code: res[0], log: res[1], files: out };
}

self.onmessage = async (e) => {
  const { id, argv, files, outputs } = e.data;
  try {
    const t0 = performance.now();
    const py = await boot();
    try { py.FS.mkdir('/w'); } catch (err) { /* 이미 있음 */ }
    const r = argv ? await run(py, argv, files, outputs) : { code: 0, log: '', files: {} };
    const transfer = Object.values(r.files).filter(Boolean).map(b => b.buffer);
    self.postMessage({ id, ok: true, ...r, ms: Math.round(performance.now() - t0) }, transfer);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
