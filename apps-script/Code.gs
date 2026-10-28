/**
 * AI 예보관 · 우리 학교 기상관측소 — Apps Script 백엔드
 * ---------------------------------------------------------------
 * 역할
 *   1) 교사 PC의 Python 브리지가 보내는 무선 날씨센서 실측값(live)을 시트에 쌓는다.
 *   2) 학생 웹앱이 '최신값 + 최근 6시간 계열'을 가져간다 → CacheService로 응답(시트 직접 읽기 최소화).
 *   3) 1차시 모둠 관측(obs), 2차시 예보 카드(forecast), 3차시 실제 날씨(truth)를 저장·제공한다.
 *
 * 배포
 *   - 확장 프로그램 > Apps Script 에 이 파일을 붙여넣고, setup() 을 한 번 실행한다.
 *   - 배포 > 새 배포 > 유형: 웹 앱 / 실행: 나 / 액세스: 모든 사용자
 *   - 프로젝트 설정 > 스크립트 속성 에 WRITE_TOKEN(브리지·교사용 비밀값)을 넣는다.
 *
 * 응답 규칙
 *   - GET  ?action=latest|obs|forecasts|truth|ping  (&callback=fn 이면 JSONP)
 *   - POST body(JSON 문자열, text/plain) : {kind:'live'|'obs'|'forecast'|'truth', ...}
 *
 * 단위 규칙(시트에 저장되는 값)
 *   기온 °C · 상대습도 % · 기압 hPa(현지기압) · 풍속 m/s · 풍향 °(북=0, 시계방향)
 */

var VER = '0.1.1';
var SHEETS = {
  live:     ['ts', 'ta', 'rh', 'p', 'ws', 'wd', 'src'],
  obs:      ['received', 'group', 'place', 'ts', 'ta', 'rh', 'p', 'note'],
  forecast: ['received', 'date', 'issued', 'H', 'cls', 'group', 'hyp', 'ruleText', 'proverb', 'rule', 'ai', 'dp3', 'rh', 'south', 'ta', 'ws', 'hour', 'reason'],
  truth:    ['received', 'date', 'cls', 'rain', 'mm', 'note']
};
var CACHE_SEC = { latest: 25, obs: 20, forecasts: 20, truth: 30 };
var LIVE_WINDOW_H = 6;      // 웹앱이 받아 가는 최근 계열 길이(시간)
var LIVE_MAX_POINTS = 400;  // 캐시 크기 제한(100KB) 안에 들도록 솎아냄

/* ---------- 최초 1회 ---------- */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(SHEETS).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    if (sh.getLastRow() === 0) sh.appendRow(SHEETS[name]);
    sh.setFrozenRows(1);
  });
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('WRITE_TOKEN')) {
    props.setProperty('WRITE_TOKEN', Utilities.getUuid().slice(0, 8));
  }
  Logger.log('WRITE_TOKEN = ' + props.getProperty('WRITE_TOKEN'));
}

/* ---------- GET ---------- */
function doGet(e) {
  var p = (e && e.parameter) || {};
  var action = p.action || 'ping';
  var out;
  try {
    if (action === 'latest') out = cached_('latest', buildLatest_);
    else if (action === 'obs') out = cached_('obs', buildObs_);
    else if (action === 'forecasts') out = cached_('forecasts', buildForecasts_);
    else if (action === 'truth') out = cached_('truth', buildTruth_);
    else out = { ok: true, ver: VER, now: new Date().toISOString() };
  } catch (err) {
    out = { ok: false, error: String(err) };
  }
  return respond_(out, p.callback);
}

/* ---------- POST ---------- */
function doPost(e) {
  var body;
  try { body = JSON.parse(e.postData.contents); }
  catch (err) { return respond_({ ok: false, error: 'JSON 형식이 아닙니다' }); }

  var kind = body.kind;
  var needToken = (kind === 'live' || kind === 'truth');
  if (needToken && body.token !== PropertiesService.getScriptProperties().getProperty('WRITE_TOKEN')) {
    return respond_({ ok: false, error: '토큰이 맞지 않습니다' });
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return respond_({ ok: false, error: '잠시 후 다시 보내 주세요' });
  try {
    var n = 0;
    if (kind === 'live') n = saveLive_(body.rows || []);
    else if (kind === 'obs') n = saveObs_(body);
    else if (kind === 'forecast') n = saveForecast_(body);
    else if (kind === 'truth') n = saveTruth_(body);
    else return respond_({ ok: false, error: '알 수 없는 kind: ' + kind });
    return respond_({ ok: true, saved: n });
  } finally {
    lock.releaseLock();
  }
}

/* ---------- 저장 ---------- */
function saveLive_(rows) {
  var clean = rows.map(function (r) {
    return [txt_(r.ts), num_(r.ta), num_(r.rh), num_(r.p), num_(r.ws), num_(r.wd), String(r.src || 'bridge')];
  }).filter(function (r) { return r[0] && r[0] !== 'undefined'; });
  if (!clean.length) return 0;
  var sh = sheet_('live');
  sh.getRange(sh.getLastRow() + 1, 1, clean.length, clean[0].length).setValues(clean);
  // 캐시를 지우지 않고 바로 다시 만든다 → 다음 학생 요청은 시트를 읽지 않음.
  // 브리지가 60초마다 보내므로 이 캐시는 다음 전송까지(최대 60초) 살려 둔다.
  putCache_('latest', buildLatest_(), 60);
  return clean.length;
}

function saveObs_(b) {
  var group = String(b.group || '').slice(0, 20);
  var place = String(b.place || '').slice(0, 40);
  var rows = (b.rows || []).slice(0, 2000).map(function (r) {
    return [new Date(), txt_(group), txt_(place), txt_(r.ts), num_(r.ta), num_(r.rh), num_(r.p), String(b.note || '').slice(0, 200)];
  });
  if (!rows.length || !group) return 0;
  var sh = sheet_('obs');
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  CacheService.getScriptCache().remove('obs');
  return rows.length;
}

function saveForecast_(b) {
  var row = [new Date(), txt_(b.date), txt_(b.issued), num_(b.H), txt_(b.cls), txt_(String(b.group || '').slice(0, 20)),
    String(b.hyp || ''), String(b.ruleText || '').slice(0, 160),
    String(b.proverb || ''), String(b.rule || ''), String(b.ai || ''),
    num_(b.dp3), num_(b.rh), num_(b.south), num_(b.ta), num_(b.ws), num_(b.hour), String(b.reason || '').slice(0, 400)];
  if (!row[3]) return 0;
  sheet_('forecast').appendRow(row);
  CacheService.getScriptCache().remove('forecasts');
  return 1;
}

function saveTruth_(b) {
  sheet_('truth').appendRow([new Date(), txt_(b.date), txt_(b.cls), String(b.rain || ''), num_(b.mm), String(b.note || '')]);
  CacheService.getScriptCache().remove('truth');
  return 1;
}

/* ---------- 읽기(캐시 재료) ---------- */
function buildLatest_() {
  var sh = sheet_('live');
  var last = sh.getLastRow();
  if (last < 2) return { ok: true, latest: null, series: [] };
  // 브리지 30초 간격이면 6시간 ≈ 720행 → 끝에서 최대 1500행만 읽는다
  var nRead = Math.min(last - 1, 1500);
  var vals = sh.getRange(last - nRead + 1, 1, nRead, 6).getValues();
  var lastTs = parseTs_(vals[vals.length - 1][0]);
  var from = lastTs - LIVE_WINDOW_H * 3600 * 1000;
  var series = vals.filter(function (r) { return parseTs_(r[0]) >= from; })
    .map(function (r) { return { ts: tsStr_(r[0]), ta: r[1], rh: r[2], p: r[3], ws: r[4], wd: r[5] }; });
  if (series.length > LIVE_MAX_POINTS) {
    var step = Math.ceil(series.length / LIVE_MAX_POINTS);
    var keep = series.filter(function (_, i) { return i % step === 0; });
    if (keep[keep.length - 1] !== series[series.length - 1]) keep.push(series[series.length - 1]);
    series = keep;
  }
  return { ok: true, latest: series[series.length - 1], series: series, built: new Date().toISOString() };
}

function buildObs_() {
  return { ok: true, rows: readAll_('obs', 6000) };
}
function buildForecasts_() {
  return { ok: true, rows: readAll_('forecast', 600) };
}
function buildTruth_() {
  return { ok: true, rows: readAll_('truth', 200) };
}

/* ---------- 도우미 ---------- */
function cached_(key, builder) {
  var cache = CacheService.getScriptCache();
  var hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  var data = builder();
  putCache_(key, data, CACHE_SEC[key] || 20);
  return data;
}

/** CacheService 한도는 값 하나당 100KB(바이트). 한글은 3바이트라 바이트로 잰다. */
function putCache_(key, data, sec) {
  var s = JSON.stringify(data);
  if (Utilities.newBlob(s).getBytes().length > 95000) return;
  try { CacheService.getScriptCache().put(key, s, sec); } catch (err) { /* 캐시 실패는 무시(시트에서 다시 읽음) */ }
}

/** 시트가 '2-1', '2026-10-27' 같은 문자열을 날짜로 바꾸지 않도록 텍스트로 고정 */
function txt_(v) {
  var s = String(v === undefined || v === null ? '' : v);
  return s === '' ? '' : "'" + s;
}

function readAll_(name, maxRows) {
  var sh = sheet_(name);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var n = Math.min(last - 1, maxRows);
  var head = SHEETS[name];
  return sh.getRange(last - n + 1, 1, n, head.length).getValues().map(function (r) {
    var o = {};
    head.forEach(function (h, i) { o[h] = (r[i] instanceof Date) ? tsStr_(r[i]) : r[i]; });
    return o;
  });
}

function sheet_(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) { sh = ss.insertSheet(name); sh.appendRow(SHEETS[name]); sh.setFrozenRows(1); }
  return sh;
}

function respond_(obj, callback) {
  var s = JSON.stringify(obj);
  if (callback && /^[A-Za-z_$][\w$]{0,40}$/.test(callback)) {
    return ContentService.createTextOutput(callback + '(' + s + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(s).setMimeType(ContentService.MimeType.JSON);
}

function num_(v) {
  var n = Number(v);
  return (v === '' || v === null || v === undefined || isNaN(n)) ? '' : n;
}

function parseTs_(v) {
  if (v instanceof Date) return v.getTime();
  var s = String(v).replace(/\//g, '-').replace(' ', 'T');
  var t = Date.parse(s.length === 19 ? s + '+09:00' : s);
  return isNaN(t) ? 0 : t;
}

function tsStr_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss');
  return String(v);
}

/* ---------- 브리지 없이 동작 시험(편집기에서 실행) ---------- */
function testInsertFakeLive() {
  var now = new Date();
  var rows = [];
  for (var i = 12; i >= 0; i--) {
    var t = new Date(now.getTime() - i * 15 * 60000);
    rows.push({ ts: Utilities.formatDate(t, 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss'),
      ta: 18, rh: 60, p: 1012 - i * 0.05, ws: 1.2, wd: 180, src: 'TEST(가짜값)' });
  }
  Logger.log(saveLive_(rows) + '행 저장 · src 열에 TEST 표시 — 시험 후 live 시트에서 지우세요');
}
