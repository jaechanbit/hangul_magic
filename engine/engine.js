/* 한글 엔진: 브라우저 안 파이썬(Pyodide)에서 hwpdoc.py를 돌린다. 문서는 이 컴퓨터 밖으로 나가지 않는다.
 * claude.ai 페이지 안에서는 일꾼(Worker)이 파일을 받을 때 몹시 느려서(18KB에 30초) 페이지 본체에서 돌린다.
 */
const LXML = 'lxml-6.0.2-cp313-cp313-pyemscripten_2025_0_wasm32.whl';
const BASE = new URL('../', import.meta.url).href;
let ready = null;

function b64ToBytes(text) {
  const bin = atob(text.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// 엔진을 한 번만 준비한다. onStage(글)로 진행 단계를 알린다.
export function loadEngine(onStage = () => {}) {
  if (ready) return ready;
  ready = (async () => {
    const lib = BASE + 'lib/';
    const t0 = performance.now();
    const stage = (t) => onStage(t + ' ' + ((performance.now() - t0) / 1000).toFixed(1) + '초');
    // 클로드 페이지는 압축 파일(.zip·.whl)을 그대로 못 올려서 글자(base64)로 올렸다. 파이썬이 그 파일을 달라고 하면 풀어서 건넨다.
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : (input.href || input.url || String(input));
      if (/(python_stdlib\.zip|\.whl)$/.test(url)) {
        const text = await (await realFetch(url + '.b64.txt')).text();
        return new Response(b64ToBytes(text), { headers: { 'content-type': 'application/zip' } });
      }
      return realFetch(input, init);
    };
    try {
      stage('파이썬 불러오는 중');
      const { loadPyodide } = await import(lib + 'pyodide/pyodide.mjs');
      const py = await loadPyodide({ indexURL: lib + 'pyodide/' });
      stage('lxml 불러오는 중');
      await py.loadPackage(lib + 'wheels/' + LXML);
      stage('엔진 불러오는 중');
      const src = await (await realFetch(BASE + 'engine/hwpdoc.py')).text();
      py.FS.writeFile('/hwpdoc.py', src);
      // 엔진 도우미(붙임 사진 쪽·서명란 칸 찾기, 엔진 함수를 그대로 쓴다). 인터넷이 끊겨도 쓰게 처음에 같이 받는다
      py.FS.writeFile('/extra.py', await (await realFetch(BASE + 'engine/extra.py')).text());
      py.runPython("import sys\nsys.path.insert(0, '/')\nimport hwpdoc");
      try { py.FS.mkdir('/w'); } catch (e) { /* 이미 있음 */ }
      stage('준비 끝');
      return py;
    } finally {
      globalThis.fetch = realFetch;
    }
  })();
  ready.catch(() => { ready = null; });
  return ready;
}

// 엔진 명령 하나(analyze·build·slots·fill·check·text)를 돌리고 찍힌 글과 만들어진 파일을 돌려준다.
// mod를 'extra'로 주면 도우미(photos·cover)를 돌린다.
export async function runEngine(argv, files = {}, outputs = [], mod = 'hwpdoc') {
  const py = await loadEngine();
  for (const [name, bytes] of Object.entries(files)) py.FS.writeFile('/w/' + name, bytes);
  py.globals.set('ARGV', py.toPy(argv));
  py.globals.set('MOD', mod);
  const res = py.runPython(`
import io, contextlib, importlib
_buf = io.StringIO()
with contextlib.redirect_stdout(_buf), contextlib.redirect_stderr(_buf):
    try:
        _code = importlib.import_module(MOD).main(list(ARGV))
    except SystemExit as _e:
        _code = _e.code if isinstance(_e.code, int) else 1
(_code, _buf.getvalue())
`).toJs();
  const out = {};
  for (const name of outputs) {
    try { out[name] = py.FS.readFile('/w/' + name); } catch (e) { out[name] = null; }
  }
  for (const name of [...Object.keys(files), ...outputs]) {
    try { py.FS.unlink('/w/' + name); } catch (e) { /* 없음 */ }
  }
  return { code: res[0], log: res[1], files: out };
}
