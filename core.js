/* ==========================================================================
   AI 예보관 · 계산 핵심(core.js)
   - 화면(index.html·teacher.html)과 시험(node)이 같은 함수를 씁니다.
   - 그림·판정·문구는 모두 여기서 나온 숫자 하나에서 만들어집니다(소스 단일화).
   ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Core = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var HOUR = 3600 * 1000;
  var MMHG_TO_HPA = 1.333224;
  var KMH_TO_MS = 1 / 3.6;

  /* ---------------- CSV ---------------- */
  function parseCSV(text) {
    var rows = [], row = [], field = '', q = false, i = 0, c;
    text = String(text).replace(/^﻿/, '');
    for (; i < text.length; i++) {
      c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
        else field += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        if (row.length > 1 || row[0] !== '') rows.push(row);
        row = [];
      } else field += c;
    }
    if (field !== '' || row.length) { row.push(field); if (row.length > 1 || row[0] !== '') rows.push(row); }
    return rows;
  }

  function num(v) {
    if (v === undefined || v === null) return NaN;
    var s = String(v).trim();
    if (s === '') return NaN;
    var n = Number(s);
    return isFinite(n) ? n : NaN;
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function fmtHour(ms) { // KST 기준 'YYYY-MM-DD HH:00'
    var d = new Date(ms + 9 * HOUR);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + ' ' + pad(d.getUTCHours()) + ':00';
  }
  function fmtTime(ms) {
    var d = new Date(ms + 9 * HOUR);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + ' ' +
      pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds());
  }
  /** 'YYYY-MM-DD HH:MM(:SS)', 'YYYY/MM/DD …', '오전/오후 h:mm:ss', 'AM/PM' 을 KST 로 읽어 ms 로 */
  function parseKST(s) {
    s = String(s || '').trim();
    var m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})[ T]+(오전|오후|AM|PM)?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i);
    if (!m) return NaN;
    var h = +m[5], ap = (m[4] || m[8] || '').toUpperCase();
    if ((ap === '오후' || ap === 'PM') && h < 12) h += 12;
    if ((ap === '오전' || ap === 'AM') && h === 12) h = 0;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], h, +m[6], +(m[7] || 0)) - 9 * HOUR;
  }

  /* ---------------- 기상청 ASOS 시간자료(기상자료개방포털 CSV) → 슬림 행 ---------------- */
  // 열 이름 일부로 찾는다(포털이 열 순서를 바꿔도 견디도록). QC 플래그 열은 제외.
  var ASOS_COLS = {
    t:  function (h) { return h === '일시' || /^일시/.test(h); },
    ta: function (h) { return /^기온/.test(h); },
    rn: function (h) { return /^강수량/.test(h); },
    ws: function (h) { return /^풍속/.test(h); },
    wd: function (h) { return /^풍향/.test(h); },
    rh: function (h) { return /^습도/.test(h); },
    p:  function (h) { return /^현지기압/.test(h); },
    stn:function (h) { return /^지점$/.test(h); }
  };

  function parseAsosPortal(text) {
    var rows = parseCSV(text);
    if (!rows.length) throw new Error('빈 파일입니다');
    var head = rows[0].map(function (h) { return String(h).trim(); });
    var idx = {};
    Object.keys(ASOS_COLS).forEach(function (k) {
      idx[k] = head.findIndex(function (h) { return !/QC/i.test(h) && ASOS_COLS[k](h); });
    });
    ['t', 'ta', 'rn', 'rh', 'p'].forEach(function (k) {
      if (idx[k] < 0) throw new Error('필수 열을 찾지 못했습니다: ' + k + ' · 머리글: ' + head.join(' | '));
    });
    var out = [];
    for (var i = 1; i < rows.length; i++) {
      var r = rows[i];
      var ms = parseKST(r[idx.t]);
      if (isNaN(ms)) continue;
      // ASOS 시간자료의 강수량 빈칸 = 그 시간 강수 기록 없음 → 0 으로 둔다(데이터 카드에 명시)
      var rn = num(r[idx.rn]); if (isNaN(rn)) rn = 0;
      out.push({
        ms: ms, stn: idx.stn >= 0 ? r[idx.stn] : '',
        ta: num(r[idx.ta]), rh: num(r[idx.rh]), p: num(r[idx.p]), rn: rn,
        ws: idx.ws >= 0 ? num(r[idx.ws]) : NaN, wd: idx.wd >= 0 ? num(r[idx.wd]) : NaN
      });
    }
    return out;
  }

  var SLIM_HEAD = ['t', 'ta', 'rh', 'p', 'ws', 'wd', 'rn'];
  function toSlimCSV(rows) {
    var seen = {}, list = rows.slice().sort(function (a, b) { return a.ms - b.ms; }).filter(function (r) {
      if (seen[r.ms]) return false; seen[r.ms] = 1; return true;
    });
    var f = function (v) { return isNaN(v) ? '' : String(Math.round(v * 10) / 10); };
    return SLIM_HEAD.join(',') + '\n' + list.map(function (r) {
      return [fmtHour(r.ms), f(r.ta), f(r.rh), f(r.p), f(r.ws), isNaN(r.wd) ? '' : String(Math.round(r.wd)), f(r.rn)].join(',');
    }).join('\n') + '\n';
  }
  function parseSlim(text) {
    var rows = parseCSV(text), head = rows[0], ix = {};
    SLIM_HEAD.forEach(function (k) { ix[k] = head.indexOf(k); });
    if (ix.t < 0 || ix.p < 0 || ix.rn < 0) throw new Error('AI 예보관 자료 형식(t,ta,rh,p,ws,wd,rn)이 아닙니다');
    var out = [];
    for (var i = 1; i < rows.length; i++) {
      var r = rows[i], ms = parseKST(r[ix.t]);
      if (isNaN(ms)) continue;
      var rn = num(r[ix.rn]); if (isNaN(rn)) rn = 0;
      out.push({ ms: ms, ta: num(r[ix.ta]), rh: num(r[ix.rh]), p: num(r[ix.p]), ws: num(r[ix.ws]), wd: num(r[ix.wd]), rn: rn });
    }
    return out;
  }

  /* ---------------- 업로드 편의: 형식 자동 판별 · 병합 · 연도별 점검 ---------------- */
  /** 한글 CSV 바이트 → 문자열. UTF-8로 읽어 깨지면 EUC-KR(CP949)로 다시 읽음(기상자료개방포털 기본) */
  function decodeKorean(buf) {
    var u = new TextDecoder('utf-8').decode(buf);
    if (u.indexOf('\uFFFD') < 0) return u;
    return new TextDecoder('euc-kr').decode(buf);
  }
  /** 웹앱 자료(t,ta,…) 또는 기상자료개방포털 원자료 중 무엇이든 받아 시간 행으로 */
  function parseAnyWeather(text) {
    var first = String(text).replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0];
    if (/^t,ta,/.test(first)) return { kind: 'slim', rows: parseSlim(text) };
    return { kind: 'portal', rows: parseAsosPortal(text) };
  }
  /** 여러 파일의 행을 합치고 같은 시각은 하나만 남김(뒤 파일 우선) */
  function mergeRows(lists) {
    var by = {};
    lists.forEach(function (rows) { rows.forEach(function (r) { by[r.ms] = r; }); });
    return Object.keys(by).map(function (k) { return by[k]; }).sort(function (a, b) { return a.ms - b.ms; });
  }
  /** 연도별 행 수와 그해 전체 시간 수 비교(빠진 해·겹친 해 확인용) */
  function yearCoverage(rows) {
    var c = {};
    rows.forEach(function (r) { var y = new Date(r.ms + 9 * HOUR).getUTCFullYear(); c[y] = (c[y] || 0) + 1; });
    return Object.keys(c).sort().map(function (y) {
      var leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
      return { year: +y, n: c[y], expected: leap ? 8784 : 8760 };
    });
  }
  /** 파일셋 ZIP(CSV 묶음) 풀기 — 브라우저·Node 18+ 의 DecompressionStream 사용. [{name, bytes}] */
  function readZip(buf) {
    var dv = new DataView(buf), u8 = new Uint8Array(buf), eocd = -1;
    for (var i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) return Promise.reject(new Error('ZIP 형식이 아닙니다'));
    var n = dv.getUint16(eocd + 10, true), p = dv.getUint32(eocd + 16, true), jobs = [];
    for (var k = 0; k < n; k++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      var method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
      var nl = dv.getUint16(p + 28, true), el = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
      var local = dv.getUint32(p + 42, true), nameBytes = u8.slice(p + 46, p + 46 + nl);
      var name = decodeKorean(nameBytes);
      p += 46 + nl + el + cl;
      if (/\/$/.test(name) || !/\.csv$/i.test(name)) continue;
      var start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
      var data = u8.slice(start, start + csize);
      jobs.push((function (name, data, method) {
        if (method === 0) return Promise.resolve({ name: name, bytes: data.buffer });
        if (method !== 8) return Promise.reject(new Error(name + ': 지원하지 않는 압축 방식(' + method + ')'));
        var ds = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Response(ds).arrayBuffer().then(function (b) { return { name: name, bytes: b }; });
      })(name, data, method));
    }
    return Promise.all(jobs);
  }

  /* ---------------- 이 브라우저에만 저장(커밋 전 시험용, IndexedDB) ---------------- */
  function idb() {
    return new Promise(function (ok, no) {
      if (typeof indexedDB === 'undefined') return no(new Error('이 브라우저는 IndexedDB를 쓸 수 없습니다'));
      var q = indexedDB.open('ai-forecaster', 1);
      q.onupgradeneeded = function () { q.result.createObjectStore('kv'); };
      q.onsuccess = function () { ok(q.result); }; q.onerror = function () { no(q.error); };
    });
  }
  function idbPut(k, v) { return idb().then(function (db) { return new Promise(function (ok, no) { var t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = function () { ok(); }; t.onerror = function () { no(t.error); }; }); }); }
  function idbGet(k) { return idb().then(function (db) { return new Promise(function (ok, no) { var q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = function () { ok(q.result); }; q.onerror = function () { no(q.error); }; }); }); }

  /* ---------------- 풍향 ---------------- */
  var DIR16 = ['북', '북북동', '북동', '동북동', '동', '동남동', '남동', '남남동', '남', '남남서', '남서', '서남서', '서', '서북서', '북서', '북북서'];
  function sector16(wd, ws) {
    // 정온: 풍속 0.3 m/s 미만이면 풍향값과 상관없이(센서 풍향은 바람이 없어도 값이 나옴)
    if (!isNaN(ws) && ws < 0.3) return -2;
    if (isNaN(wd)) return -1;
    if (wd === 0 && isNaN(ws)) return -2; // ASOS: 풍향 0 = 정온
    return Math.round(((wd % 360) + 360) % 360 / 22.5) % 16;
  }
  /** 남풍 계열 = 남동·남남동·남·남남서·남서 (16방위 6~10번). 풍향을 모르면 NaN(‘아님’으로 치지 않음) */
  function isSouth(wd, ws) { var s = sector16(wd, ws); if (s === -1) return NaN; return s >= 6 && s <= 10 ? 1 : 0; }
  function dirName(wd, ws) { var s = sector16(wd, ws); return s === -2 ? '정온' : s < 0 ? '—' : DIR16[s]; }

  /* ---------------- 특성 만들기 ---------------- */
  /**
   * hourly 행 → 학습용 행
   *  dp3   = 지금 현지기압 − 3시간 전 현지기압 (hPa)
   *  rain  = 다음 1~H시간 동안 강수량 합 ≥ 0.1 mm 이면 1   (H 기본 6)
   *  다음 H시간 중 한 시간이라도 기록이 없으면 정답을 정할 수 없으므로 제외
   */
  function buildFeatures(rows, H) {
    H = H || 6;
    var by = {};
    rows.forEach(function (r) { by[r.ms] = r; });
    var list = rows.slice().sort(function (a, b) { return a.ms - b.ms; });
    var out = [], dropped = 0;
    for (var i = 0; i < list.length; i++) {
      var r = list[i], prev = by[r.ms - 3 * HOUR];
      var sum = 0, ok = true;
      for (var k = 1; k <= H; k++) {
        var f = by[r.ms + k * HOUR];
        if (!f) { ok = false; break; }
        sum += f.rn;
      }
      var dp3 = prev && !isNaN(prev.p) && !isNaN(r.p) ? Math.round((r.p - prev.p) * 10) / 10 : NaN;
      var south = isSouth(r.wd, r.ws);
      if (!ok || isNaN(dp3) || isNaN(r.rh) || isNaN(r.ta) || isNaN(r.ws) || isNaN(south)) { dropped++; continue; }
      var d = new Date(r.ms + 9 * HOUR);
      out.push({
        ms: r.ms, year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, hour: d.getUTCHours(),
        dp3: dp3, rh: r.rh, ta: r.ta, ws: r.ws,
        south: south, rain: sum >= 0.1 ? 1 : 0
      });
    }
    return { rows: out, dropped: dropped, H: H };
  }

  /* ---------------- 속담 → 가설 ---------------- */
  var HYPS = {
    pressure: {
      proverb: '할머니 무릎이 쑤시면 비가 온다',
      science: '기압이 내려간다 → 저기압이 다가온다 → 상승 기류 → 공기가 팽창하며 냉각 → 구름 → 비',
      feature: 'dp3', op: '<=', def: -1.0, min: -4, max: -0.1, step: 0.1, unit: 'hPa',
      text: function (th) { return '3시간 동안 기압이 ' + Math.abs(th).toFixed(1) + ' hPa 이상 내려갔다'; }
    },
    humid: {
      proverb: '공기가 눅눅하면 비가 온다',
      science: '상대 습도가 높다 → 이슬점에 가까워 조금만 냉각돼도 포화 → 응결 → 구름 → 비 (상대 습도가 높다고 수증기량이 많은 것은 아님)',
      feature: 'rh', op: '>=', def: 85, min: 50, max: 100, step: 1, unit: '%',
      text: function (th) { return '상대 습도가 ' + th + '% 이상이다'; }
    },
    south: {
      proverb: '남풍이 불면 비가 온다',
      science: '남쪽(바다·저위도)에서 불어오는 바람 → 따뜻하고 습한 공기 유입 → 상승·냉각 → 비',
      feature: 'south', op: '==', def: 1, min: 1, max: 1, step: 1, unit: '',
      text: function () { return '바람이 남풍 계열(남동~남서)이다'; }
    }
  };
  function condFn(c) { // c = {feature, op, th}
    if (c.op === '<=') return function (r) { return r[c.feature] <= c.th; };
    if (c.op === '>=') return function (r) { return r[c.feature] >= c.th; };
    return function (r) { return r[c.feature] === c.th; };
  }
  function ruleFn(conds) { // 모두 만족(AND)하면 '비'
    var fs = conds.map(condFn);
    return function (r) { for (var i = 0; i < fs.length; i++) if (!fs[i](r)) return 0; return 1; };
  }

  /* ---------------- 교차표 · 가설 판정 ---------------- */
  function crossTab(rows, test) {
    var a = 0, b = 0, c = 0, d = 0;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i], t = test(r);
      if (t) { if (r.rain) a++; else b++; } else { if (r.rain) c++; else d++; }
    }
    var n = a + b + c + d;
    var pCond = (a + b) ? a / (a + b) : NaN, pNot = (c + d) ? c / (c + d) : NaN, pBase = n ? (a + c) / n : NaN;
    return { a: a, b: b, c: c, d: d, n: n, nCond: a + b, pCond: pCond, pNot: pNot, pBase: pBase, ratio: pCond / pBase };
  }
  /** 수업용 판정 기준(통계적 검정이 아님 — 화면에 그렇게 표시) */
  var VERDICT_RULE = { minN: 50, strong: 1.5, weak: 1.1, none: 0.9 };
  function verdict(ct) {
    var R = VERDICT_RULE;
    if (!(ct.nCond >= R.minN)) return { key: 'few', label: '판단 보류 — 조건에 맞는 시간이 ' + ct.nCond + '개뿐', tone: 'muted' };
    if (ct.ratio >= R.strong) return { key: 'strong', label: '가설 지지 — 평소보다 뚜렷하게 높다', tone: 'good' };
    if (ct.ratio >= R.weak) return { key: 'weak', label: '약하게 지지 — 조금 높다', tone: 'ochre' };
    if (ct.ratio >= R.none) return { key: 'none', label: '기각 — 평소와 거의 같다', tone: 'muted' };
    return { key: 'reverse', label: '기각 — 오히려 평소보다 낮다', tone: 'danger' };
  }

  /* ---------------- 평가 ---------------- */
  function evaluate(rows, pred) {
    var tp = 0, fn = 0, fp = 0, tn = 0;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i], y = pred(r);
      if (r.rain) { if (y) tp++; else fn++; } else { if (y) fp++; else tn++; }
    }
    var n = tp + fn + fp + tn;
    return {
      tp: tp, fn: fn, fp: fp, tn: tn, n: n,
      acc: n ? (tp + tn) / n : NaN,          // 정확도
      recall: (tp + fn) ? tp / (tp + fn) : NaN, // 비 온 시간 중 맞힌 비율(재현율)
      precision: (tp + fp) ? tp / (tp + fp) : NaN // '비'라고 한 것 중 실제 비
    };
  }

  /* ---------------- 의사결정트리(CART · 지니) ---------------- */
  var FEATS = [
    { key: 'dp3', name: '3시간 기압 변화', unit: 'hPa', round: 0.1 },
    { key: 'rh', name: '상대 습도', unit: '%', round: 1 },
    { key: 'south', name: '남풍 계열', unit: '', binary: true },
    { key: 'ta', name: '기온', unit: '°C', round: 1 },
    { key: 'ws', name: '풍속', unit: 'm/s', round: 0.1 },
    { key: 'hour', name: '관측 시각', unit: '시', round: 1 }
  ];
  function featByKey(k) { for (var i = 0; i < FEATS.length; i++) if (FEATS[i].key === k) return FEATS[i]; return null; }
  function roundTo(v, step) { var r = Math.round(v / step) * step; return Math.round(r * 1000) / 1000; }

  function candidates(rows, f) {
    if (f.binary) return [0.5];
    var vals = rows.map(function (r) { return r[f.key]; }).sort(function (a, b) { return a - b; });
    var out = [];
    for (var q = 0.05; q < 0.951; q += 0.05) {
      var v = roundTo(vals[Math.floor(q * (vals.length - 1))], f.round);
      if (out.indexOf(v) < 0) out.push(v);
    }
    return out.sort(function (a, b) { return a - b; });
  }
  function gini(wp, wn) { var w = wp + wn; if (!w) return 0; var p = wp / w; return 2 * p * (1 - p); }

  /**
   * opts: { maxDepth=3, minLeaf=200, weightRain=1, feats=[key…] }
   * 예/아니요 질문 하나로 둘로 나누기를 반복(스무고개). 잎의 예측 = 가중치 다수결.
   */
  function trainTree(rows, opts) {
    opts = opts || {};
    var maxDepth = opts.maxDepth || 3, minLeaf = opts.minLeaf || Math.max(100, Math.round(rows.length * 0.01));
    var wr = opts.weightRain || 1;
    var feats = (opts.feats || FEATS.map(function (f) { return f.key; })).map(featByKey);
    var cands = feats.map(function (f) { return candidates(rows, f); });
    // 각 행이 후보 경계 중 몇 번째 칸에 드는지 미리 계산: bin = (값 <= 경계) 인 첫 경계 번호
    var bins = feats.map(function (f, j) {
      var cs = cands[j];
      return rows.map(function (r) {
        var v = r[f.key], lo = 0, hi = cs.length;
        while (lo < hi) { var mid = (lo + hi) >> 1; if (v <= cs[mid]) hi = mid; else lo = mid + 1; }
        return lo;
      });
    });
    var imp = {}; feats.forEach(function (f) { imp[f.key] = 0; });
    var nodeId = 0;

    function grow(idx, depth) {
      var wp = 0, wn = 0, np = 0;
      for (var i = 0; i < idx.length; i++) { if (rows[idx[i]].rain) { wp += wr; np++; } else wn += 1; }
      var node = { id: nodeId++, n: idx.length, nRain: np, pRain: idx.length ? np / idx.length : 0,
        pred: wp >= wn ? 1 : 0, depth: depth };
      if (depth >= maxDepth || np === 0 || np === idx.length || idx.length < 2 * minLeaf) return node;
      var parentImp = (wp + wn) * gini(wp, wn), best = null;
      for (var j = 0; j < feats.length; j++) {
        var C = cands[j].length, hp = new Float64Array(C + 1), hn = new Float64Array(C + 1), hc = new Int32Array(C + 1);
        for (i = 0; i < idx.length; i++) {
          var b = bins[j][idx[i]];
          if (rows[idx[i]].rain) hp[b] += wr; else hn[b] += 1;
          hc[b]++;
        }
        var lp = 0, ln = 0, lc = 0;
        for (var t = 0; t < C; t++) { // 왼쪽 = 값 <= cands[t]
          lp += hp[t]; ln += hn[t]; lc += hc[t];
          var rc = idx.length - lc;
          if (lc < minLeaf || rc < minLeaf) continue;
          var g = parentImp - (lp + ln) * gini(lp, ln) - (wp - lp + wn - ln) * gini(wp - lp, wn - ln);
          if (!best || g > best.gain + 1e-12) best = { j: j, t: t, gain: g };
        }
      }
      if (!best || best.gain <= 1e-9) return node;
      var f = feats[best.j], thr = cands[best.j][best.t];
      var L = [], R = [];
      for (i = 0; i < idx.length; i++) (bins[best.j][idx[i]] <= best.t ? L : R).push(idx[i]);
      imp[f.key] += best.gain;
      // 연속 특성: '예' = 값 ≤ 경계. 이진 특성(남풍)만 '예' = 남풍 계열로 읽기 좋게 뒤집는다
      node.split = f.binary
        ? { f: f.key, thr: 0.5, op: '>', yes: grow(R, depth + 1), no: grow(L, depth + 1) }
        : { f: f.key, thr: thr, op: '<=', yes: grow(L, depth + 1), no: grow(R, depth + 1) };
      return node;
    }

    var all = rows.map(function (_, i) { return i; });
    var tree = grow(all, 0);
    var tot = 0; Object.keys(imp).forEach(function (k) { tot += imp[k]; });
    var importance = feats.map(function (f) { return { key: f.key, name: f.name, value: tot ? imp[f.key] / tot : 0 }; })
      .sort(function (a, b) { return b.value - a.value; });
    return { root: tree, importance: importance, opts: { maxDepth: maxDepth, minLeaf: minLeaf, weightRain: wr } };
  }
  function splitYes(s, r) { return s.op === '<=' ? r[s.f] <= s.thr : r[s.f] > s.thr; }
  function leafOf(model, r) { var n = model.root; while (n.split) n = splitYes(n.split, r) ? n.split.yes : n.split.no; return n; }
  function predictTree(model) { return function (r) { return leafOf(model, r).pred; }; }
  function questionText(s) {
    var f = featByKey(s.f);
    if (f.binary) return f.name + '인가?';
    return f.name + josa(f.name) + ' ' + s.thr + (f.unit === '%' || f.unit === '시' ? f.unit : f.unit ? ' ' + f.unit : '') + ' 이하인가?';
  }
  function josa(word) { // 받침 있으면 '이', 없으면 '가'
    var c = word.charCodeAt(word.length - 1);
    if (c < 0xAC00 || c > 0xD7A3) return '이';
    return (c - 0xAC00) % 28 ? '이' : '가';
  }

  /* ---------------- 기간 나누기 ---------------- */
  var SEASONS = { all: [1,2,3,4,5,6,7,8,9,10,11,12], spring: [3,4,5], summer: [6,7,8], autumn: [9,10,11], winter: [12,1,2] };
  function filterRows(rows, y0, y1, season) {
    var ms = SEASONS[season || 'all'];
    return rows.filter(function (r) { return r.year >= y0 && r.year <= y1 && ms.indexOf(r.month) >= 0; });
  }

  /* ---------------- SPARKvue 내보내기 CSV ---------------- */
  /**
   * 머리글 예: "일시 실행 1","시간 (s) 실행 1","온도, xxx-005 (°C) 실행 1","기압 (mmHg) 실행 1" …
   * 규칙: ① '… 실행 N'/'… Run N' 으로 실행 번호 분리 ② 마지막 괄호 = 단위 ③ 이름으로 종류 판별
   *       ④ 값이 빈 행은 건너뜀 ⑤ 기압 → hPa, 풍속 → m/s 로 환산
   */
  function classify(name) {
    var n = name.toLowerCase();
    if (/^일시|date ?time|^date$/.test(n)) return 'time';
    if (/^시간|^time/.test(n)) return 'elapsed';
    if (/이슬점|풍랭|humidex|습도감안|dew|chill|heat/.test(n)) return null;
    if (/상대 ?습도|relative humidity/.test(n)) return 'rh';
    if (/절대 ?습도|absolute humidity/.test(n)) return null;
    if (/기압|barometric/.test(n)) return 'p';
    if (/온도|기온|temperature/.test(n)) return 'ta';
    if (/풍속|wind speed/.test(n)) return 'ws';
    return null;
  }
  function parseSparkvue(text) {
    var rows = parseCSV(text);
    if (rows.length < 2) throw new Error('데이터 행이 없습니다');
    var head = rows[0], runs = {};
    head.forEach(function (h, i) {
      var m = String(h).trim().match(/^(.*?)\s*(?:실행|Run)\s*#?\s*(\d+)\s*$/i);
      var base = m ? m[1].trim() : String(h).trim(), run = m ? +m[2] : 1;
      var um = base.match(/\(([^()]*)\)\s*$/), unit = um ? um[1].trim() : '';
      var kind = classify(base);
      if (!kind) return;
      runs[run] = runs[run] || {};
      if (!(kind in runs[run])) runs[run][kind] = { i: i, unit: unit, name: base };
    });
    var out = {};
    Object.keys(runs).forEach(function (run) {
      var c = runs[run], list = [];
      if (!c.ta && !c.p && !c.rh) return;
      for (var k = 1; k < rows.length; k++) {
        var r = rows[k];
        var o = {
          ms: c.time ? parseKST(r[c.time.i]) : NaN,
          sec: c.elapsed ? num(r[c.elapsed.i]) : NaN,
          ta: c.ta ? num(r[c.ta.i]) : NaN,
          rh: c.rh ? num(r[c.rh.i]) : NaN,
          p: c.p ? toHpa(num(r[c.p.i]), c.p.unit) : NaN,
          ws: c.ws ? toMs(num(r[c.ws.i]), c.ws.unit) : NaN
        };
        if (isNaN(o.ta) && isNaN(o.rh) && isNaN(o.p)) continue;
        if (isNaN(o.ms) && isNaN(o.sec)) continue;
        list.push(o);
      }
      out[run] = { cols: c, rows: list, hasClock: !!c.time };
    });
    if (!Object.keys(out).length) throw new Error('온도·습도·기압 열을 찾지 못했습니다');
    return out;
  }
  function toHpa(v, unit) {
    var u = String(unit || '').toLowerCase().replace(/\s/g, '');
    if (isNaN(v)) return NaN;
    if (u === 'mmhg') return v * MMHG_TO_HPA;
    if (u === 'kpa') return v * 10;
    if (u === 'pa') return v / 100;
    if (u === 'atm') return v * 1013.25;
    return v; // hPa · mbar
  }
  function toMs(v, unit) {
    var u = String(unit || '').toLowerCase().replace(/\s/g, '');
    if (isNaN(v)) return NaN;
    if (u === 'km/hr' || u === 'km/h') return v * KMH_TO_MS;
    if (u === 'mph') return v * 0.44704;
    return v;
  }
  /** 시계 열이 없으면 startMs + 경과초. 1분 평균으로 묶는다. */
  function resampleMinute(list, startMs) {
    var g = {}, keys = [];
    list.forEach(function (o) {
      var ms = !isNaN(o.ms) ? o.ms : startMs + o.sec * 1000;
      if (isNaN(ms)) return;
      var key = Math.floor(ms / 60000) * 60000;
      if (!g[key]) { g[key] = { ta: [], rh: [], p: [] }; keys.push(key); }
      ['ta', 'rh', 'p'].forEach(function (k) { if (!isNaN(o[k])) g[key][k].push(o[k]); });
    });
    var mean = function (a) { return a.length ? Math.round(a.reduce(function (s, v) { return s + v; }, 0) / a.length * 100) / 100 : NaN; };
    return keys.sort(function (a, b) { return a - b; }).map(function (k) {
      return { ms: k, ts: fmtTime(k), ta: mean(g[k].ta), rh: mean(g[k].rh), p: mean(g[k].p) };
    });
  }

  /* ---------------- 실시간 계열 → 오늘의 입력값 ---------------- */
  /** series: [{ts,p,…}] (KST 문자열). 3시간 전 값은 2.5~3.5시간 전 범위에서 3시간에 가장 가까운 점 */
  function liveInputs(series) {
    if (!series || !series.length) return null;
    var pts = series.map(function (s) { return { ms: parseKST(s.ts), p: num(s.p), ta: num(s.ta), rh: num(s.rh), ws: num(s.ws), wd: num(s.wd) }; })
      .filter(function (s) { return !isNaN(s.ms); }).sort(function (a, b) { return a.ms - b.ms; });
    if (!pts.length) return null;
    var now = pts[pts.length - 1], target = now.ms - 3 * HOUR, best = null;
    pts.forEach(function (s) {
      var dt = Math.abs(s.ms - target);
      if (dt <= 0.5 * HOUR && !isNaN(s.p) && (!best || dt < Math.abs(best.ms - target))) best = s;
    });
    return {
      at: fmtTime(now.ms), atMs: now.ms, ta: now.ta, rh: now.rh, ws: now.ws, wd: now.wd,
      south: isSouth(now.wd, now.ws), dir: dirName(now.wd, now.ws),
      dp3: best && !isNaN(now.p) ? Math.round((now.p - best.p) * 10) / 10 : NaN,
      p: now.p, p3: best ? best.p : NaN, p3at: best ? fmtTime(best.ms) : ''
    };
  }

  return {
    VERSION: '0.2.0', HOUR: HOUR, MMHG_TO_HPA: MMHG_TO_HPA,
    parseCSV: parseCSV, parseKST: parseKST, fmtHour: fmtHour, fmtTime: fmtTime, num: num,
    parseAsosPortal: parseAsosPortal, toSlimCSV: toSlimCSV, parseSlim: parseSlim,
    decodeKorean: decodeKorean, parseAnyWeather: parseAnyWeather, mergeRows: mergeRows, yearCoverage: yearCoverage, readZip: readZip, idbPut: idbPut, idbGet: idbGet,
    sector16: sector16, isSouth: isSouth, dirName: dirName, DIR16: DIR16,
    buildFeatures: buildFeatures, HYPS: HYPS, condFn: condFn, ruleFn: ruleFn,
    crossTab: crossTab, verdict: verdict, VERDICT_RULE: VERDICT_RULE, evaluate: evaluate,
    FEATS: FEATS, featByKey: featByKey, trainTree: trainTree, predictTree: predictTree, leafOf: leafOf,
    splitYes: splitYes, questionText: questionText,
    SEASONS: SEASONS, filterRows: filterRows,
    parseSparkvue: parseSparkvue, resampleMinute: resampleMinute, toHpa: toHpa, liveInputs: liveInputs
  };
});
