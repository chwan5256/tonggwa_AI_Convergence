/**
 * 통합과학2 Ⅲ. 과학과 미래 사회 · AI 융합수업(AI 예보관) — Apps Script 백엔드
 * ---------------------------------------------------------------
 * 역할
 *   1) 교사 PC의 Python 브리지가 보내는 무선 날씨센서 실측값(live)을 시트에 쌓는다.
 *   2) 학생 웹앱이 '최신값 + 최근 6시간 계열'을 가져간다 → CacheService로 응답(시트 직접 읽기 최소화).
 *   3) 1차시 모둠 관측(obs), 2차시 예보 카드(forecast), 3차시 실제 날씨(truth), 4차시 정책 제안(policy)을 저장·제공한다.
 *   4) 교사 화면 입장 확인: 허용 구글 계정(ID 토큰 서버 확인) + 비밀번호(tonggwa2 와 같은 방식)
 *
 * 배포
 *   - 확장 프로그램 > Apps Script 에 이 파일을 붙여넣고, setup() 을 한 번 실행한다.
 *   - 배포 > 새 배포 > 유형: 웹 앱 / 실행: 나 / 액세스: 모든 사용자
 *   - setup() 이 WRITE_TOKEN(브리지용)을 만들고, 구글 로그인 확인에 필요한 권한도 함께 받는다.
 *   - 교사 비밀번호: 편집기에서 SETUP_PIN 에 넣고 setup 실행(저장소에는 비밀번호를 적지 않음)
 *
 * 응답 규칙
 *   - GET  ?action=latest|obs|forecasts|truth|policies|ping|chkwho|gtoken|checkpin|token|settruth  (&callback=fn 이면 JSONP)
 *   - POST body(JSON 문자열, text/plain) : {kind:'live'|'obs'|'forecast'|'truth'|'policy', ...}
 *
 * 단위 규칙(시트에 저장되는 값)
 *   기온 °C · 상대습도 % · 기압 hPa(현지기압) · 풍속 m/s · 풍향 °(북=0, 시계방향)
 */

var VER = '0.3.0';

/* ★ 교사 화면 입장 — tonggwa2 와 같은 계정·클라이언트 ID */
/* 비밀번호는 저장소에 적지 않습니다. 편집기에서 아래 SETUP_PIN 에 넣고 setup 을 실행하면
   스크립트 속성 pin 에 저장되고, 그 뒤에는 SETUP_PIN 을 다시 비워도 됩니다. */
var SETUP_PIN = '';   // ← 편집기에서만 채우기(저장소에는 빈 칸으로 둠)
var DEFAULT_WHO = ['cadrical@gmail.com', 'chwan5256@namkang.sen.hs.kr'];  // 허용 계정(공개돼도 됨: 계정 확인은 구글 토큰으로)
var CLIENT_ID = '1036707162661-v7jeqklr0ga8jlgqm1e36pga4j42mje2.apps.googleusercontent.com';
var TRY_MAX = 8, TRY_WINDOW = 5 * 60 * 1000, TRY_HOLD = 60 * 1000;   // 틀림 8번 → 1분만 막음(학생이 일부러 막아도 오래가지 않게)
var SHEETS = {
  live:     ['ts', 'ta', 'rh', 'p', 'ws', 'wd', 'src'],
  obs:      ['received', 'group', 'place', 'ts', 'ta', 'rh', 'p', 'note'],
  forecast: ['received', 'date', 'issued', 'H', 'cls', 'group', 'hyp', 'ruleText', 'proverb', 'rule', 'ai', 'dp3', 'rh', 'south', 'ta', 'ws', 'hour', 'reason'],
  truth:    ['received', 'date', 'cls', 'rain', 'mm', 'note'],
  policy:   ['received', 'cls', 'group', 'role', 'stance', 'claim', 'evidence', 'principles', 'conditions', 'rebuttal']
};
var CACHE_SEC = { latest: 25, obs: 20, forecasts: 20, truth: 30, policies: 20 };
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
  if (SETUP_PIN) props.setProperty('pin', String(SETUP_PIN).trim());
  if (!props.getProperty('pin')) throw new Error('교사 비밀번호가 없습니다. 위쪽 SETUP_PIN 에 비밀번호를 넣고 setup 을 다시 실행하세요.');
  props.setProperty('clientid', CLIENT_ID);
  // 구글 로그인 확인(UrlFetchApp)에 필요한 권한을 여기서 함께 받는다. 응답 코드 400 이 정상.
  var r = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=x', { muteHttpExceptions: true });
  Logger.log('WRITE_TOKEN = ' + props.getProperty('WRITE_TOKEN') + ' · 교사 비밀번호 저장됨 · 권한 확인 ' + r.getResponseCode() + '(400 정상) · SETUP_PIN 은 이제 비워도 됩니다');
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
    else if (action === 'policies') out = cached_('policies', buildPolicies_);
    else if (action === 'chkwho') out = { ok: allowed_(p.email), ver: VER };
    else if (action === 'gtoken') out = gToken_(p);
    else if (action === 'checkpin') out = { ok: pinOk_(p.pin), ver: VER };
    else if (action === 'token') out = pinOk_(p.pin) ? { ok: true, token: PropertiesService.getScriptProperties().getProperty('WRITE_TOKEN') } : { ok: false, error: '비밀번호가 맞지 않습니다' };
    else if (action === 'settruth') {
      if (!pinOk_(p.pin)) out = { ok: false, error: '비밀번호가 맞지 않습니다' };
      else { var lk = LockService.getScriptLock(); lk.waitLock(10000); try { saveTruth_(p); } finally { lk.releaseLock(); } out = { ok: true }; }
    }
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
    else if (kind === 'policy') n = savePolicy_(body);
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
    return [new Date(), txt_(group), txt_(place), txt_(r.ts), num_(r.ta), num_(r.rh), num_(r.p), txt_(String(b.note || '').slice(0, 200))];
  });
  if (!rows.length || !group) return 0;
  var sh = sheet_('obs');
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  CacheService.getScriptCache().remove('obs');
  return rows.length;
}

function saveForecast_(b) {
  var row = [new Date(), txt_(b.date), txt_(b.issued), num_(b.H), txt_(b.cls), txt_(String(b.group || '').slice(0, 20)),
    txt_(b.hyp), txt_(String(b.ruleText || '').slice(0, 160)),
    txt_(b.proverb), txt_(b.rule), txt_(b.ai),
    num_(b.dp3), num_(b.rh), num_(b.south), num_(b.ta), num_(b.ws), num_(b.hour), txt_(String(b.reason || '').slice(0, 400))];
  if (!row[3]) return 0;
  sheet_('forecast').appendRow(row);
  CacheService.getScriptCache().remove('forecasts');
  return 1;
}

function saveTruth_(b) {
  sheet_('truth').appendRow([new Date(), txt_(b.date), txt_(b.cls), txt_(b.rain), num_(b.mm), txt_(b.note)]);
  CacheService.getScriptCache().remove('truth');
  return 1;
}

function savePolicy_(b) {
  var cut = function (v, n) { return String(v || '').slice(0, n); };
  var row = [new Date(), txt_(b.cls), txt_(cut(b.group, 20)), txt_(cut(b.role, 30)), txt_(cut(b.stance, 20)), txt_(cut(b.claim, 400)),
    txt_(cut(b.evidence, 600)), txt_(cut(b.principles, 80)), txt_(cut(b.conditions, 800)), txt_(cut(b.rebuttal, 400))];
  if (!row[2]) return 0;
  sheet_('policy').appendRow(row);
  CacheService.getScriptCache().remove('policies');
  return 1;
}

/* ---------- 교사 화면 입장(tonggwa2 와 같은 방식) ----------
   브라우저가 "나 이 계정이야" 라고 말하는 것은 근거가 되지 않으므로,
   구글 ID 토큰을 받아 이 서버가 구글에 직접 물어 확인한 뒤 허용 목록과 대조한다. */
function norm_(s) { return String(s || '').trim().toLowerCase(); }
function who_() {
  try { var w = JSON.parse(PropertiesService.getScriptProperties().getProperty('who') || 'null'); if (w && w.length) return w; } catch (err) {}
  return DEFAULT_WHO;
}
function allowed_(email) { var t = norm_(email); return !!t && who_().some(function (w) { return norm_(w) === t; }); }
function pin_() { return PropertiesService.getScriptProperties().getProperty('pin') || ''; }
function pinOk_(v) {
  if (!pin_()) return false;                                     // 비밀번호가 설정되지 않았으면 아무도 통과 못 함
  var lock = LockService.getScriptLock();
  try { lock.waitLock(5000); } catch (err) { return false; }
  try { return pinCheck_(v); } finally { lock.releaseLock(); }
}
function pinCheck_(v) {
  var sp = PropertiesService.getScriptProperties(), st = {}, t = Date.now();
  try { st = JSON.parse(sp.getProperty('try') || '{}'); } catch (err) { st = {}; }
  if (st.hold && t < st.hold) return false;                       // 여러 번 틀려 잠시 막힘
  if (!st.first || t - st.first > TRY_WINDOW) { st.first = t; st.n = 0; }
  if (String(v || '').trim() === String(pin_())) { sp.deleteProperty('try'); return true; }
  st.n = (st.n || 0) + 1;
  if (st.n >= TRY_MAX) { st.hold = t + TRY_HOLD; st.n = 0; st.first = t; }
  sp.setProperty('try', JSON.stringify(st));
  return false;
}
function gToken_(p) {
  var t = String(p.idtoken || '');
  if (!t) return { ok: false, error: '토큰이 없습니다' };
  try {
    var r = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(t), { muteHttpExceptions: true });
    if (r.getResponseCode() !== 200) return { ok: false, error: '구글이 이 토큰을 모릅니다' };
    var d = JSON.parse(r.getContentText());
    var want = PropertiesService.getScriptProperties().getProperty('clientid') || CLIENT_ID;
    if (want && d.aud !== want) return { ok: false, error: '다른 앱에서 발급된 토큰입니다' };
    if (d.email_verified === 'false' || d.email_verified === false) return { ok: false, error: '확인되지 않은 계정입니다' };
    return { ok: true, email: d.email || '', allowed: allowed_(d.email), ver: VER };
  } catch (err) {
    var m = String(err);
    if (m.indexOf('script.external_request') >= 0 || m.indexOf('UrlFetchApp') >= 0)
      return { ok: false, error: '구글에 물어볼 권한이 없습니다. 편집기에서 setup 을 한 번 실행해 허용한 뒤, 배포 관리 → 편집 → 새 버전으로 다시 배포해 주세요.' };
    return { ok: false, error: m };
  }
}

/** 잠겼을 때(비밀번호 분실·여러 번 틀림) — 막힘을 풀고, SETUP_PIN 이 있으면 비밀번호도 그 값으로 */
function 설정초기화() {
  var sp = PropertiesService.getScriptProperties();
  sp.deleteProperty('who'); sp.deleteProperty('try');
  if (SETUP_PIN) sp.setProperty('pin', String(SETUP_PIN).trim());
  Logger.log('막힘을 풀고 계정을 ' + DEFAULT_WHO.join(', ') + ' 로 되돌렸습니다.' + (SETUP_PIN ? ' 비밀번호를 SETUP_PIN 값으로 바꿨습니다.' : ' 비밀번호를 바꾸려면 SETUP_PIN 을 넣고 다시 실행하세요.'));
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
function buildPolicies_() {
  return { ok: true, rows: readAll_('policy', 400) };
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
