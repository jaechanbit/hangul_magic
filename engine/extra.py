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
import os
import re
import zipfile
import zlib

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
    hdr_el = pkg.xml('Contents/header.xml')
    if fix_header_spacing(hdr_el):
        pkg.put_xml('Contents/header.xml', hdr_el)
    H.finish_package(pkg, sec_name, sec, None)
    pkg.save(out_path)
    print('[칸 맞춤] %s — 채운 칸 %d곳, 늘린 줄 %d곳' % (out_path, len(keys), len(grow)))
    for x in notes + over:
        print(x)


# ---------------------------------------------------------------- 조립 문서(build) 스마트 쪽 나눔 · 표 행 높이 확장 · 머리글 폭 보정

def fix_header_spacing(hdr_root):
    """자간(spacing)이 과도하게 좁거나(-6% 미만) 휴먼명조(12)에 인위적 굵게(bold)가 걸려 글자가 뭉개지는 정의를 보정."""
    changed = False
    for cp in hdr_root.findall('.//' + H.H('charPr')):
        fr = cp.find(H.H('fontRef'))
        is_myeongjo = fr is not None and fr.get('hangul') in ('10', '12')
        sp = cp.find(H.H('spacing'))
        if sp is not None:
            for k in ('hangul', 'latin', 'hanja', 'japanese', 'other', 'symbol', 'user'):
                try:
                    v = int(sp.get(k, '0') or 0)
                    if v < -6:
                        sp.set(k, '0' if is_myeongjo else '-5')
                        changed = True
                except ValueError:
                    pass
        if is_myeongjo and cp.get('id') == '62':
            b_el = cp.find(H.H('bold'))
            if b_el is not None:
                cp.remove(b_el)
                changed = True
    return changed


def balance_table_col_widths(tbl):
    """머리행(첫 줄)의 짧은 항목명(예: '구분(안건)')이 폭이 좁아 ')' 한 글자만 줄바꿈되는 현상을 방지."""
    trs = tbl.findall(H.P('tr'))
    if not trs:
        return
    head_tcs = trs[0].findall(H.P('tc'))
    C = len(head_tcs)
    if C < 2 or any(H.tc_span(tc) != (1, 1) for tc in head_tcs):
        return
    widths = [H.tc_size(tc)[0] for tc in head_tcs]
    total_w = sum(widths)
    if total_w <= 0:
        return
    min_w = []
    for j, tc in enumerate(head_tcs):
        txt = ' '.join(H.tc_text(tc).split())
        dlen = H.disp_len(txt)
        if 0 < dlen <= 7.0:
            need_w = int(dlen * 1450 + 1300)
            min_w.append(min(need_w, int(total_w * 0.28)))
        else:
            min_w.append(min(widths[j], max(8500, int(total_w * 0.22))))

    deficit = sum(max(0, min_w[j] - widths[j]) for j in range(C))
    if deficit <= 0:
        return
    slack_cols = [j for j in range(C) if widths[j] > min_w[j] + 1200]
    total_slack = sum(widths[j] - min_w[j] for j in slack_cols)
    if total_slack < deficit:
        return
    new_w = list(widths)
    for j in range(C):
        if min_w[j] > widths[j]:
            new_w[j] = min_w[j]
    rem = sum(new_w) - total_w
    for j in slack_cols:
        share = int(round(rem * (widths[j] - min_w[j]) / total_slack))
        new_w[j] -= share
    new_w[-1] += total_w - sum(new_w)

    for tr in trs:
        tcs = tr.findall(H.P('tc'))
        if len(tcs) == C and all(H.tc_span(tc)[0] == 1 for tc in tcs):
            for j, tc in enumerate(tcs):
                sz = tc.find(H.P('cellSz'))
                if sz is not None:
                    sz.set('width', str(new_w[j]))


def cell_need_safe(g, tc):
    """칸 글이 차지하는 높이(미리보기 렌더러 및 한글 줄바꿈 오차를 고려한 안전 여유 포함)."""
    w = H.tc_size(tc)[0]
    m = cell_margin(tc)
    avail = max(w - m[0] - m[1], 1000)
    safe_avail = max(int(avail * 0.88), 800)
    inner = tail = 0
    for q in H._tc_paras(tc):
        h, tail, _ = g.para(q, safe_avail)
        inner += h
    return inner - tail + m[2] + m[3] + 240


def split_table_at_row(p_el, split_idx, ids, repeat_header=True):
    """p_el 안의 표를 split_idx(본문 행 기준)에서 두 문단(p1, p2)으로 나누고 p2는 pageBreak='1'로 설정."""
    tbl1 = p_el.find('.//' + H.P('tbl'))
    if tbl1 is None:
        return None
    trs1 = tbl1.findall(H.P('tr'))
    if split_idx <= 1 or split_idx >= len(trs1):
        return None
    for r_i, tr in enumerate(trs1):
        for tc in tr.findall(H.P('tc')):
            rs = H.tc_span(tc)[1]
            if r_i < split_idx < r_i + rs:
                return None

    p2 = copy.deepcopy(p_el)
    tbl2 = p2.find('.//' + H.P('tbl'))
    trs2 = tbl2.findall(H.P('tr'))

    for tr in trs1[split_idx:]:
        tbl1.remove(tr)
    keep2 = ([0] if repeat_header else []) + list(range(split_idx, len(trs2)))
    for i, tr in enumerate(trs2):
        if i not in keep2:
            tbl2.remove(tr)

    for tbl in (tbl1, tbl2):
        rows = tbl.findall(H.P('tr'))
        total_h = 0
        for new_r, tr in enumerate(rows):
            rh = 0
            for tc in tr.findall(H.P('tc')):
                ad = tc.find(H.P('cellAddr'))
                if ad is not None:
                    ad.set('rowAddr', str(new_r))
                rh = max(rh, H.tc_size(tc)[1])
            total_h += rh
        tbl.set('rowCnt', str(len(rows)))
        zl = tbl.find(H.P('cellzoneList'))
        if zl is not None:
            tbl.remove(zl)
        sz = tbl.find(H.P('sz'))
        if sz is not None:
            sz.set('height', str(total_h))
        H.strip_lineseg(p_el)

    H.remove_ctrls(p2)
    for r in H.para_runs(p2):
        for tt in H.run_ts(r):
            for c in list(tt):
                tt.remove(c)
            tt.text = ''
    p2.set('pageBreak', '1')
    p2.set('columnBreak', '0')
    ids.renew(p2)
    H.strip_lineseg(p2)
    return p2


def paginate_built_section(sec, hdr_root, frame_end=0):
    """조립된 문서(build 모드)의 모든 표 열 폭과 행 높이를 실제 줄 수에 맞게 맞추고,
    쪽 끝에서 표가 잘리거나 소제목이 홀로 남지 않도록 pageBreak 및 표 분할을 수행."""
    g = H.PageGauge(hdr_root, [sec])
    ids = H.IdState(sec)
    W, Hh = page_box(sec)
    grown_rows = 0
    page_moves = 0

    for p in sec.findall(H.P('p'))[frame_end:]:
        for tbl in p.iter(H.P('tbl')):
            trs = tbl.findall(H.P('tr'))
            if len(trs) < 2:
                continue
            balance_table_col_widths(tbl)
            for r_idx, tr in enumerate(trs):
                max_delta = 0
                for tc in tr.findall(H.P('tc')):
                    if H.tc_span(tc)[1] > 1:
                        continue
                    hgt = H.tc_size(tc)[1]
                    need = cell_need_safe(g, tc)
                    if need > hgt:
                        max_delta = max(max_delta, need - hgt)
                if max_delta > 0:
                    grow_row(tbl, r_idx, max_delta)
                    grown_rows += 1
            H.strip_lineseg(p)

    SAFE_Hh = Hh - 1800
    paras = list(sec.findall(H.P('p')))
    y = 0.0
    i = 0
    while i < len(paras):
        p = paras[i]
        if p.get('pageBreak') == '1' and y > 0:
            y = 0.0
        h, tail, _ = g.para(p, W)
        tbl = H.content_table(p)

        if i >= frame_end and tbl is not None:
            head_start = i
            head_h = 0.0
            j = i - 1
            while j >= frame_end and H.content_table(paras[j]) is None:
                pj = paras[j]
                hj, _, _ = g.para(pj, W)
                head_h += hj
                head_start = j
                if H.para_text(pj).strip() or H.has_inline_obj(pj):
                    break
                j -= 1

            if y - tail + h > SAFE_Hh and y > 0:
                trs = tbl.findall(H.P('tr'))
                row_hs = [max([H.tc_size(tc)[1] for tc in tr.findall(H.P('tc'))] + [0]) for tr in trs]
                min_stay_h = sum(row_hs[:min(len(row_hs), 3)]) + 600
                if len(trs) <= 5 or (y + min_stay_h > SAFE_Hh):
                    target_idx = head_start
                    while target_idx < i and not H.para_text(paras[target_idx]).strip() and not H.has_inline_obj(paras[target_idx]):
                        sec.remove(paras[target_idx])
                        paras.pop(target_idx)
                        i -= 1
                    paras[target_idx].set('pageBreak', '1')
                    page_moves += 1
                    y = 0.0
                    for k in range(target_idx, i + 1):
                        hk, _, _ = g.para(paras[k], W)
                        y += hk
                    if y > SAFE_Hh and len(trs) > 2:
                        avail_for_tbl = SAFE_Hh - (y - h)
                        acc = 0
                        split_at = -1
                        for r_i, rh in enumerate(row_hs):
                            if acc + rh > avail_for_tbl and r_i >= 2:
                                split_at = r_i
                                break
                            acc += rh
                        if split_at > 1:
                            p2 = split_table_at_row(p, split_at, ids, repeat_header=True)
                            if p2 is not None:
                                idx_in_sec = list(sec).index(p)
                                sec.insert(idx_in_sec + 1, p2)
                                paras.insert(i + 1, p2)
                                h1, _, _ = g.para(p, W)
                                y = (y - h) + h1
                                page_moves += 1
                    i += 1
                    continue
                else:
                    avail_for_tbl = SAFE_Hh - y
                    acc = 0
                    split_at = -1
                    for r_i, rh in enumerate(row_hs):
                        if acc + rh > avail_for_tbl and r_i >= 2:
                            split_at = r_i
                            break
                        acc += rh
                    if split_at > 1:
                        p2 = split_table_at_row(p, split_at, ids, repeat_header=True)
                        if p2 is not None:
                            idx_in_sec = list(sec).index(p)
                            sec.insert(idx_in_sec + 1, p2)
                            paras.insert(i + 1, p2)
                            h1, _, _ = g.para(p, W)
                            y += h1
                            page_moves += 1
                            i += 1
                            continue

        if i >= frame_end and tbl is None and y + h - tail > SAFE_Hh and y > 0:
            if i > frame_end and H.has_inline_obj(paras[i - 1]) and H.content_table(paras[i - 1]) is None:
                prev_p = paras[i - 1]
                if i - 2 >= frame_end and not H.para_text(paras[i - 2]).strip() and not H.has_inline_obj(paras[i - 2]):
                    sec.remove(paras[i - 2])
                    paras.pop(i - 2)
                    i -= 1
                prev_p.set('pageBreak', '1')
                page_moves += 1
                hp_prev, _, _ = g.para(prev_p, W)
                y = hp_prev + h
                i += 1
                continue
            else:
                y = h
                i += 1
                continue

        y += h
        i += 1
    return grown_rows, page_moves


def paginate_doc(path, out_path):
    try:
        ref = H.RefDoc(path)
        frame_end = ref.frame_end
    except Exception:
        frame_end = 0
    pkg = H.Package(path)
    hdr = pkg.xml('Contents/header.xml')
    if fix_header_spacing(hdr):
        pkg.put_xml('Contents/header.xml', hdr)
    sec_name = pkg.section_names()[0]
    sec = pkg.xml(sec_name)
    grown, moves = paginate_built_section(sec, hdr, frame_end=frame_end)
    H.finish_package(pkg, sec_name, sec, None)
    pkg.save(out_path)
    print('[쪽 나눔·표 맞춤] %s — 표 행 높이 보정 %d곳, 쪽 경계 정렬 %d곳' % (out_path, grown, moves))


# ---------------------------------------------------------------- 참고·근거 자료(.xlsx / .docx / .pdf) 로컬 텍스트·표 추출

def _col_idx(ref):
    m = re.match(r'^([A-Z]+)', ref or '')
    if not m:
        return 0
    idx = 0
    for ch in m.group(1):
        idx = idx * 26 + (ord(ch) - 64)
    return max(0, idx - 1)


def extract_xlsx(path):
    """엑셀(.xlsx) 통합문서에서 시트별 표 데이터를 파이프(|) 구분 텍스트로 추출."""
    try:
        zf = zipfile.ZipFile(path, 'r')
    except Exception:
        raise H.HwpError('엑셀(.xlsx) 파일을 열 수 없습니다. 암호가 걸려 있거나 손상된 파일인지 확인해 주세요.')
    with zf:
        names = set(zf.namelist())
        shared = []
        if 'xl/sharedStrings.xml' in names:
            root = etree.fromstring(zf.read('xl/sharedStrings.xml'))
            for si in root.findall('.//{*}si'):
                shared.append(''.join(t.text or '' for t in si.findall('.//{*}t')).strip())

        sheets = []
        if 'xl/workbook.xml' in names:
            wb = etree.fromstring(zf.read('xl/workbook.xml'))
            rels = {}
            if 'xl/_rels/workbook.xml.rels' in names:
                rel_root = etree.fromstring(zf.read('xl/_rels/workbook.xml.rels'))
                for r in rel_root.findall('.//{*}Relationship'):
                    rid = r.get('Id')
                    tgt = (r.get('Target') or '').lstrip('/')
                    if not tgt.startswith('xl/'):
                        tgt = 'xl/' + tgt
                    rels[rid] = tgt
            for sh in wb.findall('.//{*}sheet'):
                sname = sh.get('name') or '시트'
                rid = None
                for k, v in sh.attrib.items():
                    if k.endswith('}id') or k == 'r:id':
                        rid = v
                        break
                tgt = rels.get(rid, '')
                if tgt in names:
                    sheets.append((sname, tgt))
        if not sheets:
            for n in sorted(names):
                if re.match(r'^xl/worksheets/sheet\d+\.xml$', n):
                    sheets.append((os.path.basename(n), n))

        out_blocks = []
        for sname, spath in sheets:
            sroot = etree.fromstring(zf.read(spath))
            rows_out = []
            for row in sroot.findall('.//{*}sheetData/{*}row'):
                cells = {}
                max_c = -1
                for idx, c in enumerate(row.findall('{*}c')):
                    ref = c.get('r') or ''
                    ci = _col_idx(ref) if ref else idx
                    ctype = c.get('t') or ''
                    val = ''
                    if ctype == 'inlineStr':
                        val = ''.join(t.text or '' for t in c.findall('.//{*}t'))
                    else:
                        v_el = c.find('{*}v')
                        raw = (v_el.text or '').strip() if v_el is not None else ''
                        if ctype == 's' and raw.isdigit() and int(raw) < len(shared):
                            val = shared[int(raw)]
                        else:
                            val = raw
                    val = ' '.join(val.replace('\r', ' ').replace('\n', ' ').split())
                    if val:
                        cells[ci] = val
                        if ci > max_c:
                            max_c = ci
                if max_c >= 0:
                    line_cells = [cells.get(i, '') for i in range(min(max_c + 1, 30))]
                    if any(line_cells):
                        rows_out.append(' | '.join(line_cells).strip())
            if rows_out:
                out_blocks.append(f'[엑셀 시트: {sname}]\n' + '\n'.join(rows_out))
        if not out_blocks:
            raise H.HwpError('엑셀 파일에서 읽을 수 있는 데이터가 없습니다.')
        return '\n\n'.join(out_blocks)


def extract_docx(path):
    """워드(.docx) 문서에서 문단과 표를 순서대로 추출."""
    try:
        zf = zipfile.ZipFile(path, 'r')
    except Exception:
        raise H.HwpError('워드(.docx) 파일을 열 수 없습니다. 암호가 걸려 있거나 손상된 파일인지 확인해 주세요.')
    with zf:
        if 'word/document.xml' not in zf.namelist():
            raise H.HwpError('올바른 워드(.docx) 문서 구조가 아닙니다.')
        root = etree.fromstring(zf.read('word/document.xml'))
        body = root.find('.//{*}body')
        if body is None:
            body = root
        out = []
        for ch in body:
            tag = ch.tag.split('}')[-1]
            if tag == 'p':
                txt = ''.join(t.text or '' for t in ch.findall('.//{*}t')).strip()
                if txt:
                    out.append(txt)
            elif tag == 'tbl':
                t_rows = ['[표]']
                for tr in ch.findall('.//{*}tr'):
                    row_vals = []
                    for tc in tr.findall('./{*}tc'):
                        cell_p = [''.join(t.text or '' for t in p.findall('.//{*}t')).strip()
                                  for p in tc.findall('.//{*}p')]
                        row_vals.append(' / '.join(x for x in cell_p if x))
                    if any(row_vals):
                        t_rows.append(' | '.join(row_vals))
                t_rows.append('[/표]')
                if len(t_rows) > 2:
                    out.append('\n'.join(t_rows))
        if not out:
            raise H.HwpError('워드 문서에서 추출할 본문 텍스트가 없습니다.')
        return '\n'.join(out)


def _decode_pdf_hex(hex_str, cmap):
    h = re.sub(r'\s+', '', hex_str)
    if not h or len(h) % 2 != 0:
        return ''
    if h.upper().startswith('FEFF'):
        try:
            return bytes.fromhex(h[4:]).decode('utf-16-be', errors='ignore')
        except Exception:
            pass
    if cmap and len(h) % 4 == 0:
        chars = []
        mapped = 0
        for i in range(0, len(h), 4):
            code = int(h[i:i + 4], 16)
            if code in cmap:
                chars.append(cmap[code])
                mapped += 1
            elif 0x20 <= code <= 0x7E or 0xAC00 <= code <= 0xD7A3:
                chars.append(chr(code))
        if mapped > 0 or chars:
            return ''.join(chars)
    if len(h) % 4 == 0:
        try:
            u16 = bytes.fromhex(h).decode('utf-16-be', errors='ignore')
            if sum(1 for c in u16 if '\uac00' <= c <= '\ud7a3' or ' ' <= c <= '~') >= len(u16) * 0.6:
                return u16
        except Exception:
            pass
    try:
        b = bytes.fromhex(h)
        return b.decode('utf-8', errors='ignore') or b.decode('cp949', errors='ignore')
    except Exception:
        return ''


def _decode_pdf_lit(lit):
    # octal and escape sequences
    def _oct(m):
        return chr(int(m.group(1), 8))
    s = re.sub(r'\\([0-7]{1,3})', _oct, lit)
    s = s.replace(r'\n', '\n').replace(r'\r', '\r').replace(r'\t', '\t')
    s = s.replace(r'\(', '(').replace(r'\)', ')').replace(r'\\', '\\')
    raw = s.encode('latin1', errors='ignore')
    if raw.startswith(b'\xfe\xff'):
        return raw[2:].decode('utf-16-be', errors='ignore')
    for enc in ('utf-8', 'cp949'):
        try:
            return raw.decode(enc)
        except Exception:
            pass
    return raw.decode('latin1', errors='ignore')


def extract_pdf(path):
    """PDF 파일에서 FlateDecode 스트림 및 ToUnicode CMap을 해석하여 텍스트를 추출."""
    with open(path, 'rb') as f:
        data = f.read()
    if not data.startswith(b'%PDF'):
        raise H.HwpError('올바른 PDF 파일이 아닙니다.')

    streams = []
    for m in re.finditer(rb'stream\r?\n(.*?)\r?\nendstream', data, re.DOTALL):
        raw = m.group(1)
        dec = None
        for wbits in (zlib.MAX_WBITS, -zlib.MAX_WBITS):
            try:
                dec = zlib.decompress(raw, wbits)
                break
            except Exception:
                pass
        if dec is None:
            dec = raw
        streams.append(dec)

    # 1단계: ToUnicode CMap 수집
    cmap = {}
    for st in streams:
        if b'beginbfchar' not in st and b'beginbfrange' not in st:
            continue
        txt = st.decode('latin1', errors='ignore')
        for blk in re.findall(r'beginbfchar(.*?)endbfchar', txt, re.DOTALL):
            for src, dst in re.findall(r'<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>', blk):
                try:
                    cmap[int(src, 16)] = bytes.fromhex(dst).decode('utf-16-be', errors='ignore')
                except Exception:
                    pass
        for blk in re.findall(r'beginbfrange(.*?)endbfrange', txt, re.DOTALL):
            for s1, s2, dst in re.findall(r'<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>', blk):
                try:
                    c1, c2, base = int(s1, 16), int(s2, 16), int(dst, 16)
                    if c2 - c1 <= 2048:
                        for offset in range(c2 - c1 + 1):
                            cmap[c1 + offset] = chr(base + offset)
                except Exception:
                    pass

    # 2단계: BT ... ET 텍스트 블록에서 문자열 추출
    lines = []
    for st in streams:
        if b'BT' not in st or b'beginbfchar' in st:
            continue
        txt = st.decode('latin1', errors='ignore')
        for bt in re.findall(r'\bBT\b(.*?)\bET\b', txt, re.DOTALL):
            seg_parts = []
            for tok in re.finditer(r'<([0-9A-Fa-f\s]+)>|\((?:\\.|[^\\()])*\)|(\bT[dDmM\*]\b|\bT[jJ]\b)', bt):
                hx, op = tok.group(1), tok.group(2)
                full = tok.group(0)
                if hx is not None:
                    seg_parts.append(_decode_pdf_hex(hx, cmap))
                elif full.startswith('(') and full.endswith(')'):
                    seg_parts.append(_decode_pdf_lit(full[1:-1]))
                elif op in ('Td', 'TD', 'T*', 'Tm'):
                    if seg_parts:
                        joined = ''.join(seg_parts).strip()
                        if joined:
                            lines.append(joined)
                        seg_parts = []
            if seg_parts:
                joined = ''.join(seg_parts).strip()
                if joined:
                    lines.append(joined)

    cleaned = []
    for ln in lines:
        s = ' '.join(re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f]', '', ln).split())
        if s and (not cleaned or cleaned[-1] != s):
            cleaned.append(s)

    result = '\n'.join(cleaned).strip()
    if len(result) < 5:
        raise H.HwpError('PDF에서 텍스트를 추출하지 못했습니다(스캔 이미지 PDF 등). 한글(.hwpx/.hwp)이나 엑셀(.xlsx)·워드(.docx)·텍스트 파일로 올려 주세요.')
    return result


def extract_file(path, out_path):
    ext = os.path.splitext(path)[1].lower()
    if ext == '.xlsx':
        txt = extract_xlsx(path)
    elif ext == '.docx':
        txt = extract_docx(path)
    elif ext == '.pdf':
        txt = extract_pdf(path)
    else:
        raise H.HwpError(f'지원하지 않는 문서 형식입니다: {ext}')
    with open(out_path, 'w', encoding='utf-8') as f:
        f.write(txt)
    print(f'[자료 추출 완료] {ext} — {len(txt)}자')


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
    pg = sp.add_parser('paginate', help='조립된 문서의 표 행 높이와 쪽 나눔을 자동 보정')
    pg.add_argument('hwpx')
    pg.add_argument('-o', '--out', required=True)
    ex = sp.add_parser('extract', help='참고자료(.xlsx, .docx, .pdf) 텍스트·표 추출')
    ex.add_argument('src')
    ex.add_argument('-o', '--out', required=True)
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
        elif args.cmd == 'paginate':
            paginate_doc(args.hwpx, args.out)
        elif args.cmd == 'extract':
            extract_file(args.src, args.out)
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
