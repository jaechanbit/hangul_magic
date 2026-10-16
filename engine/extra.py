"""한글 척척 엔진 도우미(사이트판). 엔진 파일(hwpdoc.py)은 선생님 배포본과 같아야 해서 고치지 않고, 엔진 함수를 불러 쓴다.

    extra photos <문서.hwpx> <설명.json> -o <결과.hwpx>
        사진 칸이 없는 문서 끝에 '붙임 사진' 쪽을 붙인다. 표는 엔진이 개요의 [표]를 만들 때 쓰는 함수 그대로
        (검은 실선 표, 사진 칸은 4:3, 한 쪽을 넘으면 묶음마다 나눔).
        설명.json: 사진 차례대로 설명 글 목록(빈 글이면 설명 없음). 설명이 하나도 없으면 설명 줄 없이 사진만 넣는다.
    extra cover <문서.hwpx>
        제출 문구·날짜·서명란이 든 칸(법정 서식 첫 쪽의 '…제출합니다 / 년 월 일 / (서명 또는 인) / ○○장 귀하')마다
        '키<탭>줄 수<탭>줄1 / 줄2 / …'를 찍는다. 이 칸을 AI가 줄을 빼고 다시 쓰면 첨부 서류·서명란·귀하 줄이 사라지므로,
        앱은 줄 수가 같게 쓴 값만 넣고 아니면 원래대로 둔다.
    extra room <문서.hwpx>
        쪽 크기 표(법정 서식처럼 쪽마다 글자처럼 취급한 표 하나) 칸마다 '키<탭>줄 수<탭>줄당 글자 수'를 찍는다.
        한글은 칸을 글에 맞춰 늘리는데 이 표는 다음 쪽으로 못 넘어가 쪽 아래가 잘리므로, 앱이 AI에게 칸 분량으로 알려 준다.
    extra fit <문서.hwpx> <키.json> -o <결과.hwpx>
        AI가 채운 칸(키.json)이 넘치면 쪽 크기 표 칸은 줄 간격을 조금 줄여(120%까지) 맞추고, 그래도 넘치는 칸은
        한글처럼 칸을 늘린다(미리보기도 한글과 같게). 쪽 크기 표가 쪽보다 커지면 '- 주의:'와 '넘침<탭>쪽<탭>칸'을 찍는다.
"""
import argparse
import copy
import json
import math
import re

from lxml import etree

import hwpdoc as H

TITLE = '붙임 사진'


def body_width(blocks):
    """쪽 본문 너비(HWPUNIT): 용지 너비 - 왼쪽·오른쪽·제본 여백. 찾지 못하면 0."""
    for b in blocks:
        for pp in b.iter(H.P('pagePr')):
            try:
                w = int(pp.get('height') if pp.get('landscape') == 'NARROWLY' else pp.get('width'))
                m = pp.find(H.P('margin'))
                if m is not None:
                    w -= sum(int(m.get(k, '0') or 0) for k in ('left', 'right', 'gutter'))
                return max(0, w)
            except (TypeError, ValueError):
                return 0
    return 0


def photos(path, caps, out_path):
    caps = [str(c or '').strip() for c in caps]
    if not caps:
        raise H.HwpError('넣을 사진이 없습니다.')
    doc = H.RefDoc(path)
    ids = H.IdState(doc.root)
    warns = []
    cols = 1 if len(caps) == 1 else 2
    with_caps = any(caps)
    rows = []
    for i in range(0, len(caps), cols):
        part = caps[i:i + cols]
        rows.append(['[사진]'] * len(part) + [''] * (cols - len(part)))
        if with_caps:
            rows.append(part + [''] * (cols - len(part)))
    # 엔진의 기본 표 너비(46000)가 쪽 본문보다 넓으면 본문 너비에 맞춘다(표 바깥 여백 몫을 뺀다)
    first = doc.blocks[0].el if doc.blocks else doc.root
    bw = body_width([first])
    width = min(46000, bw - 800) if bw > 20000 else 46000
    orig = H._col_widths
    H._col_widths = lambda r, c, w, ex: orig(r, c, width, ex)
    try:
        tbl_p, _ = H.make_plain_table(doc, rows, ids, warns)
    finally:
        H._col_widths = orig
    tbl_p.set('pageBreak', '0')
    tbl_p.set('columnBreak', '0')
    # 설명 줄도 사진 칸처럼 가운데 정렬·글머리표 없이
    for tbl in tbl_p.iter(H.P('tbl')):
        for tr in tbl.findall(H.P('tr')):
            if any(H.PHOTO_RE.match(H.tc_text(tc)) for tc in tr.findall(H.P('tc'))):
                continue
            for x in tr.iter(H.P('p')):
                x.set('paraPrIDRef', doc.hedit.photo_para(x.get('paraPrIDRef')))
    # 제목 줄: 표 문단과 같은 모양에서 표를 빼고 글자만, 새 쪽에서 시작
    head = copy.deepcopy(tbl_p)
    runs = H.para_runs(head)
    for r in runs[1:]:
        head.remove(r)
    run = runs[0]
    for c in list(run):
        run.remove(c)
    etree.SubElement(run, H.P('t')).text = TITLE
    H.strip_lineseg(head)
    head.set('pageBreak', '1')
    # 구역이 여럿이면 마지막 구역 끝에 붙인다
    last = doc.sections[-1]
    root = doc.root if last == doc.sec_name else doc.pkg.xml(last)
    blocks = [first, head, tbl_p]  # 첫 문단은 쪽 크기를 읽는 데만 쓴다
    H.split_photo_tables(blocks, 1, ids, warns, doc.hedit)
    H.keep_with_tables(blocks, 1, doc.hedit)
    for b in blocks[1:]:
        root.append(b)
    if root is not doc.root:
        doc.pkg.put_xml(last, root)
    doc.hedit.save()
    H.finish_package(doc.pkg, doc.sec_name, doc.root, None)
    doc.pkg.save(out_path)
    n = sum(1 for b in blocks[1:] for t in b.iter(H.P('tbl')) for tc in t.iter(H.P('tc'))
            if H.PHOTO_RE.match(H.tc_text(tc)))
    print('[사진 쪽] %s — 사진 자리 %d곳%s' % (out_path, n, ', 설명 줄 있음' if with_caps else ''))
    for w in warns:
        if '기본 모양' not in w:
            print('- 참고: ' + w)


COVER_RE = re.compile(r'\(\s*서명\s*또는\s*인\s*\)|귀하\s*$|년\s{2,}월\s{2,}일')


def cover(path):
    """제출 문구·날짜·서명란 칸: 글 있는 문단이 3개 이상이고, '(서명 또는 인)'·'…귀하'로 끝나는 줄·빈 날짜('년  월  일')가 든 칸.
    [(키, 글 있는 줄 목록(띄어쓰기는 하나로))] 문서 차례대로."""
    pkg = H.Package(path)
    sec = pkg.xml(pkg.section_names()[0])
    out = []
    for key, el, kind, _ in H._walk_slots(sec):
        if kind != 'cell':
            continue
        lines = [' '.join(H.para_text(p).split()) for p in H._tc_paras(el)]
        lines = [x for x in lines if x]
        if len(lines) >= 3 and any(COVER_RE.search(x) for x in lines):
            out.append((key, lines))
    return out


# ---------------------------------------------------------------- 칸 분량 · 넘친 칸 맞추기

FIXED_RATIO = 0.8  # 글자처럼 취급한 표의 높이가 쪽 본문 높이의 이만큼 이상이면 쪽 크기 표로 본다
MIN_LS = 120       # 넘친 칸을 맞출 때 줄 간격(%)을 이보다 줄이지 않는다
TOL = 60           # 어림 오차(HWPUNIT, 약 0.2mm)
EDGE_TOL = 280     # 쪽 크기 표가 종이 끝 1mm 앞까지 내려오면 잘리는 것으로 본다(어림 오차 여유)


def page_box(sec):
    """쪽 본문 (너비, 높이): 용지에서 여백·머리말·꼬리말을 뺀 것(PageGauge.pages와 같은 계산)."""
    W, Hh = 48190, 70018
    pp = next(sec.iter(H.P('pagePr')), None)
    if pp is not None:
        try:
            land = pp.get('landscape') == 'NARROWLY'
            W, Hh = int(pp.get('height' if land else 'width')), int(pp.get('width' if land else 'height'))
            m = pp.find(H.P('margin'))
            if m is not None:
                W -= sum(int(m.get(k, '0') or 0) for k in ('left', 'right', 'gutter'))
                Hh -= sum(int(m.get(k, '0') or 0) for k in ('top', 'bottom', 'header', 'footer'))
        except (TypeError, ValueError):
            pass
    return W, Hh


def page_edge(sec):
    """쪽 본문 위에서 종이 아래 끝까지의 높이(본문 + 꼬리말 + 아래 여백). 한글은 글자처럼 취급한 쪽 크기 표가
    본문보다 길면 아래 여백까지 그대로 그리고 종이 끝에서 자른다(한컴 뷰어로 확인)."""
    Hh = page_box(sec)[1]
    pp = next(sec.iter(H.P('pagePr')), None)
    m = pp.find(H.P('margin')) if pp is not None else None
    if m is None:
        return Hh
    try:
        return Hh + int(m.get('bottom', '0') or 0) + int(m.get('footer', '0') or 0)
    except (TypeError, ValueError):
        return Hh


def fixed_tables(sec, Hh):
    """쪽 크기 표 [(문단, 표)]: 본문 문단에 글자처럼 취급해 넣은, 높이가 쪽 본문에 가까운 표.
    글자처럼 취급한 표는 쪽을 넘어 나뉘지 않아서, 한글이 칸을 글에 맞춰 늘리면 쪽 아래가 잘린다."""
    out = []
    for p in sec.findall(H.P('p')):
        for r in H.para_runs(p):
            for c in r:
                pos = c.find(H.P('pos')) if c.tag == H.P('tbl') else None
                if pos is None or pos.get('treatAsChar') != '1':
                    continue
                try:
                    if int(c.find(H.P('sz')).get('height')) >= Hh * FIXED_RATIO:
                        out.append((p, c))
                except (AttributeError, TypeError, ValueError):
                    pass
    return out


def outer_table(e):
    t = None
    while e is not None:
        if e.tag == H.P('tbl'):
            t = e
        e = e.getparent()
    return t


def cell_margin(tc):
    """칸 여백 [왼, 오, 위, 아래](PageGauge.table과 같게: 칸에 따로 정한 여백이 없으면 표 안 여백)."""
    tbl = H._ancestor(tc, 'tbl')
    im = tbl.find(H.P('inMargin')) if tbl is not None else None
    m = [int(im.get(k, 0) or 0) for k in ('left', 'right', 'top', 'bottom')] if im is not None else [141] * 4
    cm = tc.find(H.P('cellMargin'))
    if tc.get('hasMargin') == '1' and cm is not None:
        m = [int(cm.get(k, 0) or 0) for k in ('left', 'right', 'top', 'bottom')]
    return m


def cell_need(g, tc):
    """칸 글이 차지하는 높이(칸 위아래 여백 포함). 한글은 칸을 이만큼 늘린다(PageGauge.table과 같은 계산)."""
    w = H.tc_size(tc)[0]
    m = cell_margin(tc)
    inner = tail = 0
    for q in H._tc_paras(tc):
        h, tail, _ = g.para(q, max(w - m[0] - m[1], 1000))
        inner += h
    return inner - tail + m[2] + m[3]


def main_para(tc):
    """칸에 채운 글 대부분이 따르는 문단: 글자 있는 마지막 문단(엔진은 넘치는 줄에 이 모양을 쓴다), 없으면 첫 문단."""
    ps = H._tc_paras(tc)
    styles = [x for x in ps if H.para_text(x).strip()] or ps[:1]
    return styles[-1] if styles else None


def para_font(g, p):
    """문단의 (글자 모양 번호, 글자 크기): 글자 있는 run 가운데 가장 큰 것."""
    runs = [r for r in H.para_runs(p) if any(H.t_text(t).strip() for t in H.run_ts(r))] or H.para_runs(p)
    cids = [r.get('charPrIDRef') for r in runs if r.get('charPrIDRef') is not None]
    if not cids:
        return None, 1000
    cid = max(cids, key=lambda c: g.ch(c)[0])
    return cid, g.ch(cid)[0]


def room_of(g, tc):
    """(줄 수, 줄당 한글 글자 수): 칸을 늘리지 않고 들어가는 분량(어림)."""
    w, h = H.tc_size(tc)
    m = cell_margin(tc)
    p = main_para(tc)
    if p is None:
        return 1, 1
    cid, fs = para_font(g, p)
    d = g.pp(p.get('paraPrIDRef'))
    pit = max(g.pitch(fs, d), 1)
    lines = int((h - m[2] - m[3] - fs) // pit) + 1 if h - m[2] - m[3] > fs else 1
    avail = w - m[0] - m[1] - max(d['left'], 0) - max(d['right'], 0) - abs(d['intent'])
    cw = g.width('가', cid) * g.k if cid else 1000
    return max(1, lines), max(1, int(avail // max(cw, 1)))


def room(path):
    """쪽 크기 표 칸마다 (키, 줄 수, 줄당 글자 수). 쪽 크기 표가 없는 양식이면 빈 목록."""
    pkg = H.Package(path)
    sec = pkg.xml(pkg.section_names()[0])
    g = H.PageGauge(pkg.xml('Contents/header.xml'), [sec])
    fixed = [t for _, t in fixed_tables(sec, page_box(sec)[1])]
    out = []
    for key, el, kind, _ in H._walk_slots(sec):
        if kind == 'cell' and any(outer_table(el) is t for t in fixed):
            n, c = room_of(g, el)
            out.append((key, n, c))
    return out


def ls_para(hed, pid, lv):
    """같은 문단 모양에 줄 간격(%)만 lv로 바꾼 정의의 번호(HeaderEditor.seam_para와 같은 방식)."""
    hed._load()
    if not hasattr(hed, 'pps'):
        hed.pps = hed.root.find('.//' + H.H('paraProperties'))
        hed.pp_by_id = {x.get('id'): x for x in hed.pps.findall(H.H('paraPr'))} if hed.pps is not None else {}
    b = hed.pp_by_id.get(pid)
    if b is None:
        return pid
    key = ('ls', pid, lv)
    if key in hed.cache:
        return hed.cache[key]
    nb = copy.deepcopy(b)
    for e in nb.iter(H.H('lineSpacing')):
        if e.get('type', 'PERCENT') == 'PERCENT':
            e.set('value', str(lv))
    new_id = str(max(int(i) for i in hed.pp_by_id) + 1)
    nb.set('id', new_id)
    hed.pps.append(nb)
    hed.pp_by_id[new_id] = nb
    hed.pps.set('itemCnt', str(len(hed.pp_by_id)))
    hed.cache[key] = new_id
    hed.dirty = True
    return new_id


def tighten(g, hed, tc, hgt):
    """칸 문단의 줄 간격을 칸에 들어갈 만큼만(5%씩, MIN_LS까지) 줄인다. (줄인 줄 간격 또는 None, 원래 줄 간격)"""
    base = {}
    for q in H._tc_paras(tc):
        pid = q.get('paraPrIDRef')
        d = g.pp(pid)
        if d['lt'] == 'PERCENT' and d['lv'] > MIN_LS:
            base[pid] = d
    if not base:
        return None, None
    top = max(d['lv'] for d in base.values())
    lv = None
    try:
        for v in range(top - 5, MIN_LS - 1, -5):
            for pid, d in base.items():
                g._p[pid] = dict(d, lv=min(d['lv'], v))
            lv = v
            if cell_need(g, tc) <= hgt + TOL:
                break
    finally:
        for pid, d in base.items():
            g._p[pid] = d
    for q in H._tc_paras(tc):
        pid = q.get('paraPrIDRef')
        if pid in base and base[pid]['lv'] > lv:
            nid = ls_para(hed, pid, lv)
            q.set('paraPrIDRef', nid)
            g.hdr.para[nid] = hed.pp_by_id[nid]
    return lv, top


def even_first_line(g, tc):
    """칸 첫 줄만 글자가 큰 것을 나머지 줄 모양으로 맞춘다. 서식 첫 문단의 큰 '○'(머리 기호만 큰 모양)을 AI가 쓴 첫 줄 전체가
    물려받아 첫 줄만 커진다. 첫 줄 머리 기호가 다른 줄 머리에도 나올 때만(같은 단계의 줄) — '□ 제목'처럼 일부러 큰 줄은 둔다."""
    ps = [q for q in H._tc_paras(tc) if H.para_text(q).strip()]
    if len(ps) < 3:
        return False

    def cids(q):
        return {r.get('charPrIDRef') for r in H.para_runs(q) if any(H.t_text(t).strip() for t in H.run_ts(r))}
    first = cids(ps[0])
    rest = set().union(*(cids(q) for q in ps[1:]))
    if len(first) != 1 or len(rest) != 1 or first == rest:
        return False
    a, b = next(iter(first)), next(iter(rest))
    if g.ch(a)[0] <= g.ch(b)[0]:
        return False
    mark = H.para_text(ps[0]).strip()[:1]
    if not mark or mark.isalnum() or not any(H.para_text(q).strip().startswith(mark) for q in ps[1:]):
        return False
    for r in H.para_runs(ps[0]):
        r.set('charPrIDRef', b)
    return True


def grow_row(tbl, r, delta):
    """표의 r번째 줄(그 줄에 걸친 칸 모두)과 표 높이를 delta만큼 늘린다."""
    delta = int(math.ceil(delta))
    if delta <= 0:
        return
    for tr in tbl.findall(H.P('tr')):
        for c in tr.findall(H.P('tc')):
            a, sz = c.find(H.P('cellAddr')), c.find(H.P('cellSz'))
            if a is None or sz is None:
                continue
            r0, rs = int(a.get('rowAddr', '0')), H.tc_span(c)[1]
            if r0 <= r < r0 + rs:
                sz.set('height', str(int(sz.get('height', '0')) + delta))
    tsz = tbl.find(H.P('sz'))
    if tsz is not None:
        tsz.set('height', str(int(tsz.get('height', '0')) + delta))


def cell_label(tc, filled):
    """사람이 알아볼 칸 이름: 왼쪽 이름표 칸(AI가 채운 칸 말고), 없으면 위쪽 칸 글자."""
    tbl = H._ancestor(tc, 'tbl')
    a = tc.find(H.P('cellAddr'))
    if tbl is None or a is None:
        return ''
    r, c = int(a.get('rowAddr', '0')), int(a.get('colAddr', '0'))
    grid = []
    for tr in tbl.findall(H.P('tr')):
        for x in tr.findall(H.P('tc')):
            b = x.find(H.P('cellAddr'))
            if b is not None:
                cs, rs = H.tc_span(x)
                grid.append((int(b.get('rowAddr', '0')), int(b.get('colAddr', '0')), rs, cs, x))
    left = sorted((g for g in grid if g[1] + g[3] <= c and g[0] <= r < g[0] + g[2]), key=lambda g: -g[1])
    up = sorted((g for g in grid if g[0] + g[2] <= r and g[1] <= c < g[1] + g[3]), key=lambda g: -g[0])
    for cand in (left, up):
        for g in cand:
            x = g[4]
            if any(x is f for f in filled):
                continue
            t = ' '.join(H.tc_text(x).replace('\n', ' / ').split())
            if t:
                o, run = [], False
                for w in t.replace(' / ', ' ').split(' '):
                    one = re.match(r'^[가-힣]$', w) is not None
                    if one and run:
                        o[-1] += w
                    else:
                        o.append(w)
                    run = one
                t = ' '.join(o)
                return t[:20] + ('…' if len(t) > 20 else '')
            break
    return ''


def over_text(cells):
    """[(칸 이름, 넘친 줄)] → ['「사업계획」 1줄', '「추진 실적」 2칸 1줄씩', …](같은 이름은 묶는다)"""
    by = {}
    for name, n in cells:
        by.setdefault(name, []).append(n)
    out = []
    for name, ns in by.items():
        if len(ns) == 1:
            out.append('「%s」 %d줄' % (name, ns[0]))
        elif len(set(ns)) == 1:
            out.append('「%s」 %d칸 %d줄씩' % (name, len(ns), ns[0]))
        else:
            out.append('「%s」 %d칸 모두 %d줄' % (name, len(ns), sum(ns)))
    return out


def fit(path, keys, out_path):
    pkg = H.Package(path)
    sec_name = pkg.section_names()[0]
    sec = pkg.xml(sec_name)
    hed = H.HeaderEditor(pkg)
    hed._load()
    g = H.PageGauge(hed.root, [sec])
    W, Hh = page_box(sec)
    edge = page_edge(sec)
    fixed = fixed_tables(sec, Hh)
    # 쪽 크기 표마다 원래 높이·쪽 번호(PageGauge.pages처럼 쪽을 넘기며 센다)
    info = {}
    y, n = 0.0, 1
    for p in sec.findall(H.P('p')):
        if p.get('pageBreak') == '1' and y > 0:
            n, y = n + 1, 0.0
        h, tail, solid = g.para(p, W)
        if y + h - tail <= Hh:
            start = n
            y += h
        elif solid:
            if y > 0:
                n += 1
            start = n
            y = min(h, Hh)
        else:
            start = n
            y += h
            while y > Hh:
                n, y = n + 1, y - Hh
        for fp, t in fixed:
            if fp is p:
                # 원래 높이: 서식에 적힌 표 높이 + 바깥 여백(채운 글로 늘어난 높이는 빼고)
                om = t.find(H.P('outMargin'))
                h0 = int(t.find(H.P('sz')).get('height')) + (int(om.get('top', 0) or 0) + int(om.get('bottom', 0) or 0) if om is not None else 0)
                info[id(t)] = {'page': start, 'h0': h0, 'cells': [], 'pit': 1500}
    slots = H._walk_slots(sec)
    order = {k: i for i, (k, _, _, _) in enumerate(slots)}
    cells = {k: el for k, el, kind, _ in slots if kind == 'cell'}
    keys = sorted({k for k in keys if k in cells}, key=order.get)
    filled = [cells[k] for k in keys]
    grow = {}
    notes = []
    for k in keys:
        tc = cells[k]
        even_first_line(g, tc)
        hgt = H.tc_size(tc)[1]
        need = cell_need(g, tc)
        if need <= hgt + TOL:
            continue
        top = outer_table(tc)
        fx = info.get(id(top)) if top is not None else None
        p = main_para(tc)
        cid, fs = para_font(g, p) if p is not None else (None, 1000)
        pit = max(g.pitch(fs, g.pp(p.get('paraPrIDRef'))) if p is not None else 1600, 1)
        if fx is not None:
            lv, lv0 = tighten(g, hed, tc, hgt)
            need = cell_need(g, tc)
            if lv and need <= hgt + TOL:
                notes.append('- 참고: %d쪽 「%s」 칸은 줄 간격을 %d%%에서 %d%%로 줄여 칸에 맞췄습니다.'
                             % (fx['page'], cell_label(tc, filled) or k, lv0, lv))
                continue
            fx['cells'].append((cell_label(tc, filled) or k, max(1, int(math.ceil((need - hgt) / pit - 0.15)))))
            fx['pit'] = pit
        tbl = H._ancestor(tc, 'tbl')
        a = tc.find(H.P('cellAddr'))
        last = int(a.get('rowAddr', '0')) + H.tc_span(tc)[1] - 1 if a is not None else 0
        gk = (id(tbl), last)
        if gk not in grow or grow[gk][2] < need - hgt:
            grow[gk] = (tbl, last, need - hgt)
    for tbl, r, d in grow.values():
        grow_row(tbl, r, d)
    over = []
    for fp, t in fixed:
        fx = info.get(id(t))
        if not fx:
            continue
        h1 = g.table(t)
        cut = h1 + EDGE_TOL - max(edge, fx['h0'])
        if cut > 0 and fx['cells']:
            H.strip_lineseg(fp)
            lines = max(1, int(round(cut / float(fx['pit']))))
            what = ', '.join(over_text(fx['cells']))
            notes.append('- 주의: %d쪽은 칸보다 글이 많아 한글에서 쪽 아래가 약 %d줄 잘립니다(넘친 칸: %s). '
                         '아래 「AI에게 고쳐 달라고 하기」로 칸에 맞게 줄여 주세요.' % (fx['page'], lines, what))
            over.append('넘침\t%d\t%s' % (fx['page'], what))
    hed.save()
    H.finish_package(pkg, sec_name, sec, None)
    pkg.save(out_path)
    print('[칸 맞춤] %s — 채운 칸 %d곳, 늘린 줄 %d곳' % (out_path, len(keys), len(grow)))
    for x in notes + over:
        print(x)


def main(argv=None):
    ap = argparse.ArgumentParser(description='한글 척척 엔진 도우미')
    sp = ap.add_subparsers(dest='cmd')
    a = sp.add_parser('photos', help='문서 끝에 붙임 사진 쪽 붙이기')
    a.add_argument('hwpx')
    a.add_argument('caps')
    a.add_argument('-o', '--out', required=True)
    c = sp.add_parser('cover', help='제출 문구·날짜·서명란 칸 찾기')
    c.add_argument('hwpx')
    r = sp.add_parser('room', help='쪽 크기 표 칸마다 들어가는 분량')
    r.add_argument('hwpx')
    f = sp.add_parser('fit', help='AI가 채운 칸이 넘치면 줄 간격을 줄이거나 칸을 늘리기')
    f.add_argument('hwpx')
    f.add_argument('keys')
    f.add_argument('-o', '--out', required=True)
    args = ap.parse_args(argv)
    try:
        if args.cmd == 'photos':
            with open(args.caps, encoding='utf-8-sig') as f:
                photos(args.hwpx, json.load(f), args.out)
        elif args.cmd == 'cover':
            for k, lines in cover(args.hwpx):
                print('%s\t%d\t%s' % (k, len(lines), ' / '.join(lines)))
        elif args.cmd == 'room':
            for k, n, c in room(args.hwpx):
                print('%s\t%d\t%d' % (k, n, c))
        elif args.cmd == 'fit':
            with open(args.keys, encoding='utf-8-sig') as f:
                fit(args.hwpx, json.load(f), args.out)
        else:
            ap.print_help()
            return 1
    except H.HwpError as e:
        print('[안내] %s' % e)
        return 2
    except Exception as e:
        import traceback
        traceback.print_exc()
        print('[오류] 도우미가 처리하지 못했습니다(%s: %s).' % (type(e).__name__, e))
        return 3
    return 0


if __name__ == '__main__':
    import sys
    sys.exit(main())
