#!/usr/bin/env node
/**
 * US CSS Weekly Report Generator — 11-person conversion CS team
 *
 * Generates a 4-section HTML report covering Live Chat, Phone, Email, Outbound.
 * Week cycle: Friday ~ Thursday (Beijing Time / MYT UTC+8).
 *
 * Usage:
 *   DATA_COOKIE="uIdToken=...; uIdToken.sig=..." \
 *   USCM_COOKIE="EGG_SESS=...; csrfToken=TOKEN; staff_id=7328; staff_id.sig=..." \
 *   USCM_CSRF="TOKEN" \
 *   node run.js [options]
 *
 * --week-start  YYYY-MM-DD  Friday start of week in BT (default: last completed Fri-Thu)
 * --data-start  YYYY-MM-DD  Override start date for LC/Phone/Email channels only
 *                           (useful for short weeks; does not affect report title)
 * --ob-start    YYYY-MM-DD  Outbound window start date (default: week-start)
 * --ob-end      YYYY-MM-DD  Outbound window end date   (default: weekEnd + 1 day)
 * --out         /path/file  Output path (default: %USERPROFILE%/weekly_report_{YYYY-MM-DD}.html)
 * --discover                Print field lists for all BI cards, then exit
 *
 * Phone Util (全渠道工时利用率) always uses last 2 days of the BT week (weekEnd-1 ~ weekEnd).
 * This matches the Guandata page filter and avoids stale all-time aggregates.
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ─────────────────────────────────────────────────────────────────
// CLI ARGS
// ─────────────────────────────────────────────────────────────────
const args        = process.argv.slice(2);
const DISCOVER    = args.includes('--discover');
const weekStartArg = args.includes('--week-start') ? args[args.indexOf('--week-start') + 1] : null;
const weekEndArg   = args.includes('--week-end')   ? args[args.indexOf('--week-end')   + 1] : null;
const obStartArg   = args.includes('--ob-start')   ? args[args.indexOf('--ob-start')   + 1] : null;
const obEndArg     = args.includes('--ob-end')     ? args[args.indexOf('--ob-end')     + 1] : null;
const dataStartArg = args.includes('--data-start') ? args[args.indexOf('--data-start') + 1] : null;
const outArg      = args.includes('--out')  ? args[args.indexOf('--out')  + 1] : null;

// ─────────────────────────────────────────────────────────────────
// ENV / AUTH
// ─────────────────────────────────────────────────────────────────
const DATA_COOKIE = process.env.DATA_COOKIE || '';
const USCM_COOKIE = process.env.USCM_COOKIE || '';
const USCM_CSRF   = process.env.USCM_CSRF   || '';

if (!DATA_COOKIE) { console.error('Missing DATA_COOKIE (uIdToken)'); process.exit(1); }
if (!DISCOVER) {
  if (!USCM_COOKIE) { console.error('Missing USCM_COOKIE'); process.exit(1); }
  if (!USCM_CSRF)   { console.error('Missing USCM_CSRF');   process.exit(1); }
}

// ─────────────────────────────────────────────────────────────────
// TEAM
// ─────────────────────────────────────────────────────────────────
const TEAM_ORDER = [
  'jacelynlim', 'terrychen', 'muhamadfaisal', 'calventan', 'azamuddin',
  'jeanliew', 'whitneylee', 'alvinsim', 'zaydentan', 'vincentyew',
  'wilsonwong', 'zyonnleong',
];
const CONVERSION_TEAM = new Set(TEAM_ORDER);
const TEAM_NAME = 'conversion CS team';
const LC_SKILL_VALUES = ['inc conversion (en)', 'inc conversion (cn)', 'inc英文（转化）', 'inc中文（转化）'];

// ─────────────────────────────────────────────────────────────────
// CARD / FIELD IDs
// ─────────────────────────────────────────────────────────────────
const CARDS = {
  LC_QUEUE:  'n897ad21677424c66af5aad8',
  LC_UTIL:   'u6b720a2a07f246b8ba5ed1c',
  PHONE:     'p387a9f31ddc842f89a058eb',
  EMAIL:     'j4e69d8b9111b4f0a86bfb93',
  EMAIL_SAT: 'db4225f75c16b49a0b6ef227',
  SLA:       'i962341c6f44c422f8eb998e',
};
const PHONE_UTIL_CARD = 'g2f6209e865c343cc9015a26';

const CARD_VPARAMS = {
  [CARDS.LC_QUEUE]: 'TFUsDZAqXcxCwqCzQlvZIQRT',
  [CARDS.LC_UTIL]:  'SYRdxWeqRlzviTWngneskcEk',
  [CARDS.PHONE]:    'LoZeFSbcPCYrMOEKfCEenGqH',
  [CARDS.EMAIL]:    'rwBQAsirGzsCMpndPwUVKhzL',
  [CARDS.SLA]:      'ZedMDVjfQRBbjcfVycpPIPMU',
  // PHONE_UTIL_CARD: auto-resolved via GET /api/card/{id}
};

const F = {
  // ── Live Chat Queue (n897ad21677424c66af5aad8) ──────────────
  LC_DS_ID:        'nf8f5724ebd214f34acee5b9',
  LC_DATE:         'mc52e5dd1696f423fb044d75',
  LC_DATE_SRC:     'ca5946493505349b2affa651',
  LC_AGENT:        'h72cb4ce7e104450f91d1e5e',
  LC_SKILL:        'u0e8c717ad0c84c788d304e4',
  LC_TICKETS:      'x50bcef02b3094ef5a4ca0ea',
  LC_SATISFACTION: 'sb3b0e1bd578a4e4988755db',
  LC_FCR:          'c6b9180b9f9124ba188422d1',
  LC_AVG_HANDLE:   'w7343a0c716d74713a3a2405',
  LC_WAIT_LT10S:   'g31afcde8d37f4d89ad6a431',
  LC_WAIT_10_30S:  'n3d8d83a692774ce183d115d',
  LC_NEG_COUNT:    'o8de31b7e41984a26820ac0f',  // 不满意的工单数
  LC_GROUP:        'p7f10f681db884d6c93f61fb',  // 接待客服组
  LC_GROUP_KEY:    'HrvYVyljfylnAyqbcMtFOyUC',  // slot key from page if9006e90be5d47c2a32b943

  // ── Live Chat Utilization (u6b720a2a07f246b8ba5ed1c) ────────
  UTIL_DS_ID:      'uf6c3c53584b241159e036d0',
  UTIL_DATE:       'n8416996cadd04d679b47a7b',
  UTIL_DATE_SRC:   'v05ceb66a37ef4981954bd3a',
  UTIL_AGENT:      'gbb695246ac7e4225bdcb196',
  UTIL_AVG_RATE:   'jbc122fe25c7345faa03e604',

  // ── Phone (p387a9f31ddc842f89a058eb) ────────────────────────
  PH_DS_ID:        'i3c6fe114d95f4ccc880a844',
  PH_DATE:         'qfae26c41f2964547871e5ba',
  PH_DATE_SRC:     'ieacb98abc3fc4de8ae08f34',
  PH_AGENT:        'p7d3c93d1eb174d4f96bc76e',
  PH_TEAM:         'ff8cb357f0deb43d0859a12d',
  PH_TEAM_SRC:     'r997dac1f3ce444979ac5c33',
  PH_INBOUND:      'p2ce6a8b8539841eba1f84ba',
  PH_INBOUND_ANS:  'p2433451518d946fa8d225eb',
  PH_ANS_RATE:     'k84d8e5b7de3f4517bc1a6fa',
  PH_ANS_20S:      'r40befee07d7e40cc8e5c7e1',
  PH_AVG_DURATION: 'oeea9eb407aac479e800b2db',
  PH_SATISFACTION: 'p707c367d6d764d11ad80ba8',
  PH_FCR:          'vda0f4bd895494a3f98f3eea',
  PH_NEG_COUNT:    'fd23bae0f599e436d94fb740',  // 不满意评价数

  // ── Phone Utilization Card (g2f6209e865c343cc9015a26) ───────
  PU_DATE:         'f9725c5b9d74f4472a874cba',  // 统计时间_日
  PU_AGENT:        'kc46dd442419c4278bdd416b',  // 英文名
  PU_UTIL:         'wc5a3079cbe6d43b5ad0d6c8',  // 工时利用率
  PU_TEAM:         'w56b8a86990244f84b00a677',  // 客服组名称

  // ── Email (j4e69d8b9111b4f0a86bfb93) ─────────────────────────
  EM_DS_ID:        'j4dbefb8670a149afbd8a960',
  EM_DATE:         'ibf197b7482b3471a9d30074',
  EM_DATE_KEY:     'kLBKZbzGDhkvhCPMHpkaRSOH',
  EM_MAIL_FDID:    'g678165f34aa0418b89dbb92',
  EM_MAIL_SRC:     'o9e26b4da81cf441cac822d2',
  EM_AGENT:        'sd76cc38f77ca4c1eb7bcf76',
  EM_USER_EMAILS:  'xa5915843201d46f88ae30c1',
  EM_REPLIED:      'kb139048426f1492ea0c428f',
  EM_SLA_30MIN:    'qe5c68f1d93d54660a277994',
  EM_AVG_REPLY:    'v801bc3c2e3304ae297fd0c6',

  // ── Email Reception / Satisfaction (db4225f75c16b49a0b6ef227) ─
  ESA_DS_ID:       'w605094686a92446b9da361b',
  ESA_DATE:        'f14bd7ff447884b0b8a514e2',
  ESA_DATE_SRC:    'x25b867e4d1904be0a4a5f7b',
  ESA_MAIL:        'o9c632f218e014be89408468',
  ESA_MAIL_SRC:    'mdb097198970946ec8f9a1eb',
  ESA_AGENT:       'n79073e09102b4b43aad3ac8',
  ESA_SAT:         'l37591ccde2ab440090f69e8',
  ESA_AVG_REPLY:   'tebe9d2ac64c84159bb482da',
  ESA_30MIN_REPLY: 're00ef8cec8b345adb7a34d0',
  ESA_NEG_COUNT:   'n24b6cd8fdd154e0788b52b1',  // unstisfyed_order_count

  // ── SLA Report (i962341c6f44c422f8eb998e) ────────────────────
  SLA_DS_ID:       'd2174168a8dea45f4888422b',
  SLA_DATE:        'u12f2f9a7df6a47ed8314eb1',
  SLA_DATE_SRC:    'h0e923271e46f410c9590761',
  SLA_GROUP:       'lb96dba1dbe1d46b1960137d',
  SLA_GROUP_SRC:   'i86fbbd22171c40c38de2429',
  SLA_RATE:        'cc8baa4eed88946dea404893',
  SLA_AGENT_NAME:  'l4503bf9ce4e34b7ca9badae',
};

// ─────────────────────────────────────────────────────────────────
// DATE HELPERS
// ─────────────────────────────────────────────────────────────────
function fmtDate(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}

function toYYYYMMDD(dateStr) { return dateStr.replace(/-/g, ''); }

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m-1, d + n));
  return fmtDate(dt);
}

function getWeekRange() {
  if (weekStartArg) {
    return { start: weekStartArg, end: weekEndArg || addDays(weekStartArg, 6) };
  }
  // Auto: find last completed Fri-Thu week in Beijing Time (UTC+8)
  const now = new Date();
  const bjNow = new Date(now.getTime() + 8 * 3600000);
  const bjYear = bjNow.getUTCFullYear();
  const bjMonth = bjNow.getUTCMonth();
  const bjDate = bjNow.getUTCDate();
  const bjDay  = bjNow.getUTCDay(); // 0=Sun,1=Mon,...,4=Thu,5=Fri,6=Sat
  // Days back to last Thursday: 0→3, 1→4, 2→5, 3→6, 4→0||7, 5→1, 6→2
  const daysBack = ((bjDay - 4 + 7) % 7) || 7;
  const lastThu  = new Date(Date.UTC(bjYear, bjMonth, bjDate - daysBack));
  const lastFri  = new Date(Date.UTC(bjYear, bjMonth, bjDate - daysBack - 6));
  return { start: fmtDate(lastFri), end: fmtDate(lastThu) };
}

// Unix timestamp for a BT (UTC+8) date + hour
function toUnixBT(dateStr, hour) {
  const [y, m, d] = dateStr.split('-');
  return Math.floor(new Date(`${y}-${m}-${d}T${String(hour).padStart(2,'0')}:00:00Z`).getTime() / 1000) - 8 * 3600;
}

function monthStart(dateStr) {
  return dateStr.slice(0, 7) + '-01';
}

// ─────────────────────────────────────────────────────────────────
// HTTP HELPERS
// ─────────────────────────────────────────────────────────────────
function httpRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        try { resolve({ status: res.statusCode, body: JSON.parse(raw), raw }); }
        catch { resolve({ status: res.statusCode, body: raw, raw }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const vParamCache = {};

function findVParam(obj, depth) {
  if (depth > 4 || !obj || typeof obj !== 'object') return null;
  for (const k of ['version', 'hash', 'v', 'vid', 'configHash']) {
    if (typeof obj[k] === 'string' && /^[a-zA-Z0-9]{20,30}$/.test(obj[k])) return obj[k];
  }
  for (const val of Object.values(obj)) {
    const found = findVParam(val, depth + 1);
    if (found) return found;
  }
  return null;
}

async function guandataGet(urlPath) {
  const res = await httpRequest({
    hostname: 'us.data.futuoa.com', path: urlPath, method: 'GET',
    headers: {
      'raw-backend-response': 'TRUE',
      'user-id': 'aXJpc2Rpbmc=', 'x-dom-id': 'Z3VhbmJp',
      'Cookie': DATA_COOKIE,
    },
  });
  if (res.status !== 200) throw new Error(`GET ${urlPath}: HTTP ${res.status}`);
  return res.body;
}

async function resolveVParam(cardId) {
  if (CARD_VPARAMS[cardId]) return CARD_VPARAMS[cardId];
  if (vParamCache[cardId]) return vParamCache[cardId];
  try {
    const cfg = await guandataGet(`/api/card/${cardId}`);
    const candidate = findVParam(cfg, 0);
    if (candidate) { vParamCache[cardId] = candidate; return candidate; }
  } catch {}
  return 'kQdbjGiERwJqhUiwlPPIjNPc';
}

async function guandataPost(cardId, bodyObj) {
  const v = await resolveVParam(cardId);
  const bodyStr = JSON.stringify(bodyObj);
  const res = await httpRequest({
    hostname: 'us.data.futuoa.com',
    path: `/api/card/${cardId}/data?v=${v}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'raw-backend-response': 'TRUE',
      'user-id': 'aXJpc2Rpbmc=', 'x-dom-id': 'Z3VhbmJp',
      'Cookie': DATA_COOKIE,
      'Content-Length': Buffer.byteLength(bodyStr),
    },
  }, bodyStr);
  if (res.status !== 200) throw new Error(`Card ${cardId}: HTTP ${res.status} — ${res.raw.slice(0,200)}`);
  return res.body;
}

async function uscmGet(urlPath, params) {
  const qs = new URLSearchParams(params).toString();
  const res = await httpRequest({
    hostname: 'uscm.futuoa.com', path: `${urlPath}?${qs}`, method: 'GET',
    headers: {
      'futu-csrf-token': USCM_CSRF, 'x-csrf-token': USCM_CSRF,
      'x-requested-with': 'XMLHttpRequest',
      'Cookie': USCM_COOKIE,
    },
  });
  if (res.status !== 200) throw new Error(`uscm ${urlPath}: HTTP ${res.status}`);
  const body = res.body;
  const errCode = body?.code ?? body?.retcode;
  const errMsg  = body?.message ?? body?.retmsg ?? body?.msg ?? '';
  if (errCode && errCode !== 0) {
    if (errMsg.includes('未登录') || errMsg.includes('过期') || errCode === 140001000)
      throw new Error(`USCM_AUTH_EXPIRED: ${errMsg}`);
    throw new Error(`uscm error ${errCode}: ${errMsg}`);
  }
  return body;
}

// ─────────────────────────────────────────────────────────────────
// QUERY BUILDERS
// ─────────────────────────────────────────────────────────────────
const COL_DEFAULT = [{ name: '度量名', metaType: 'MPH', key: 'aWxMeJMiFiCjdaGrpBLNOyjG', nameTranslated: '度量名', alias: '度量名' }];

function randId() {
  const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({length: 24}, () => c[Math.floor(Math.random() * c.length)]).join('');
}

function mkMetric(fdId, name, extra = {}) {
  return { fdId, name, fdType: 'DOUBLE', metaType: 'METRIC', isAggregated: true,
    calculationType: 'aggregation', level: 'dataset', key: fdId, ...extra };
}

function mkDim(fdId, name, fdType = 'STRING', extra = {}) {
  return { fdId, key: fdId, name, fdType, metaType: 'DIM',
    isAggregated: false, calculationType: 'normal', level: 'dataset', ...extra };
}

// Date range filter (BT): filterType BT with [start, end]
function mkDateFilter(fdId, start, end, dsId, cdId, sourceCdId) {
  const f = { name: 'date', fdId, key: fdId, fdType: 'STRING',
    filterType: 'BT', originFilterType: 'BT',
    filterValue: [start, end], displayValue: [start, end] };
  if (dsId)       f.dsId = dsId;
  if (cdId)       f.cdId = cdId;
  if (sourceCdId) f.sourceCdId = sourceCdId;
  return f;
}

function mkTeamFilter(fdId, dsId, cdId, sourceCdId) {
  const f = { name: '客服组', fdId, key: fdId, fdType: 'STRING',
    filterType: 'IN', filterValue: [TEAM_NAME], level: 'dataset', filterLevel: 'DETAIL' };
  if (dsId)       f.dsId = dsId;
  if (cdId)       f.cdId = cdId;
  if (sourceCdId) f.sourceCdId = sourceCdId;
  return f;
}

function mkSkillZoneFilter(fdId, values) {
  return { name: '实际接待技能', fdId, key: fdId, fdType: 'STRING', metaType: 'DIM',
    isAggregated: false, calculationType: 'normal', level: 'dataset',
    filterType: 'IN', filterValue: values, filterLevel: 'DETAIL' };
}

function buildBody(row, metrics, filters, zoneFilters = [], limit = 500, name = '', col = null) {
  const column = col || COL_DEFAULT;
  const zoneData = { row, column, metric: metrics, sorting: [] };
  if (zoneFilters.length) zoneData.filters = zoneFilters;
  return {
    offset: 0, limit, filters, zoneFilter: { zoneData },
    treeFilters: [], dynamicParams: [], dynamicFieldFilters: [],
    combinationFilters: [], layerTreeFilters: [],
    headerSortings: null, rowExpand: null, sorting: [],
    name, taskRequestId: randId(),
  };
}

// ─────────────────────────────────────────────────────────────────
// RESPONSE PARSERS
// ─────────────────────────────────────────────────────────────────
function teamValues(resp) {
  const rows = resp?.response?.chartMain?.data || [];
  if (!rows.length) return [];
  return rows[0].map(c => c?.v ?? null);
}

function agentRows(resp) {
  const data    = resp?.response?.chartMain?.data    || [];
  const rowVals = resp?.response?.chartMain?.row?.values || [];
  return data.map((row, i) => ({
    name: rowVals[i]?.[0]?.title ?? rowVals[i]?.[0]?.dvt ?? '',
    vals: row.map(c => c?.v ?? null),
  }));
}

// ─────────────────────────────────────────────────────────────────
// FORMAT HELPERS
// ─────────────────────────────────────────────────────────────────
function pct(v) {
  if (v == null) return '-';
  return (parseFloat(v) * 100).toFixed(1) + '%';
}
function num(v, dec = 0) {
  if (v == null) return '-';
  const n = parseFloat(v);
  if (isNaN(n)) return '-';
  return dec > 0 ? n.toFixed(dec) : Math.round(n);
}
function toInt(v) { return typeof v === 'number' ? v : (parseInt(v) || 0); }
function mins(v) {
  if (v == null) return '-';
  return num(v, 1) + 'm';
}
function secs(v) {
  if (v == null) return '-';
  const s = Math.round(v);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

// ─────────────────────────────────────────────────────────────────
// DISCOVER MODE
// ─────────────────────────────────────────────────────────────────
async function discoverCard(cardId, label) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`CARD: ${label} (${cardId})`);
  console.log('='.repeat(60));
  const cfg = await guandataGet(`/api/card/${cardId}`);
  const ds = cfg?.data?.dataSetInfo || cfg?.dataSetInfo || {};
  const fields = ds?.fieldList || ds?.fields || [];
  if (!fields.length) {
    const raw = JSON.stringify(cfg, null, 2);
    const matches = [...raw.matchAll(/"fdId"\s*:\s*"([^"]+)"[^}]*"name"\s*:\s*"([^"]+)"/g)];
    if (matches.length) matches.forEach(m => console.log(`  ${m[1]}  ${m[2]}`));
    else console.log(raw.slice(0, 2000));
    return;
  }
  fields.forEach(f => console.log(`  ${f.fdId}  ${f.name}  [${f.fdType || '?'}]`));
}

async function runDiscover() {
  const allCards = { ...CARDS, PHONE_UTIL: PHONE_UTIL_CARD };
  for (const [label, id] of Object.entries(allCards)) {
    try { await discoverCard(id, label); }
    catch (e) { console.error(`  ERROR: ${e.message}`); }
  }
}

// ─────────────────────────────────────────────────────────────────
// BI CARD METRICS (exact keys from browser cURL of daily report)
// ─────────────────────────────────────────────────────────────────

// ── Live Chat Queue ───────────────────────────────────────────────
const LC_METRICS = [
  { fdId: F.LC_TICKETS,      name: '工单总数',        fdType: 'DOUBLE', metaType: 'METRIC', isAggregated: true, calculationType: 'aggregation', key: 'uSnzSWmrcKEACbnkFiruihTG', level: 'dataset', formula: 'count(distinct [工单号])' },
  { fdId: F.LC_AVG_HANDLE,   name: '平均处理时长(分钟)', fdType: 'DOUBLE', metaType: 'METRIC', isAggregated: true, calculationType: 'aggregation', key: 'FTpDNwLIbnUnBEUNekqockre', level: 'dataset', formula: 'sum([工单处理时长]) / count(distinct [工单号])' },
  { fdId: F.LC_SATISFACTION, name: '满意度',          fdType: 'DOUBLE', metaType: 'METRIC', isAggregated: true, calculationType: 'aggregation', key: 'fYmoBOBuySUEyprwTzYIcBuf', formula: '([有满意度评价的工单数]-[不满意的工单数])/[有满意度评价的工单数]' },
  { fdId: F.LC_WAIT_LT10S,   name: '等待<10s',       fdType: 'DOUBLE', metaType: 'METRIC', isAggregated: true, calculationType: 'aggregation', key: 'GRoTaWulFUwFhMjyIFAzTNuX', level: 'dataset', formula: 'sum(case when [排队时长] <10 then 1 else 0 end)' },
  { fdId: F.LC_WAIT_10_30S,  name: '等待10-30s',     fdType: 'DOUBLE', metaType: 'METRIC', isAggregated: true, calculationType: 'aggregation', key: 'cUFIdczQJkPXSqHaGzsrHUJm', level: 'dataset', formula: 'sum(case when [排队时长] >= 10 and [排队时长] < 30 then 1 else 0 end)' },
  { fdId: F.LC_FCR,          name: '一次解决率',      fdType: 'DOUBLE', metaType: 'METRIC', isAggregated: true, calculationType: 'aggregation', key: 'kttbSFAuVLufGtbItCijyWfh', level: 'dataset', formula: 'sum(case when [是否一次解决] = 1 then 1 else 0 end) / count(distinct [工单号])' },
  { fdId: F.LC_NEG_COUNT,   name: '不满意工单数',    fdType: 'DOUBLE', metaType: 'METRIC', isAggregated: true, calculationType: 'aggregation', key: 'lcNegCount001', level: 'dataset', formula: '[不满意的工单数]' },
];
// indices: 0=tickets, 1=avgHandle, 2=satisfaction, 3=waitLt10, 4=wait1030, 5=fcr, 6=negCount

const LC_AGENT_DIM = {
  fdId: F.LC_AGENT, name: '接待客服名字-英', fdType: 'STRING', metaType: 'DIM',
  isAggregated: false, calculationType: 'normal', key: 'ixmnrrBevwuFxxsLStkcEqIv',
  level: 'dataset', nameTranslated: '接待客服名字-英', alias: '接待客服名字-英', zoneId: 'row',
};

// ── LC Utilization ────────────────────────────────────────────────
const UTIL_COL = [{ name: '度量名', metaType: 'MPH', key: 'vlNIWVyinehsaEqmJfRCDELe', nameTranslated: '度量名', alias: '度量名' }];
const UTIL_METRICS = [
  { fdId: F.UTIL_AVG_RATE, name: '平均工时利用率', alias: '在线工时利用率', fdType: 'DOUBLE', metaType: 'METRIC',
    isAggregated: true, calculationType: 'aggregation', level: 'dataset',
    formula: '(sum([进线总时长-秒])+sum([仅转接时长-秒]))/sum([签入时长-秒])',
    key: 'ibffrLdxrVFLtKAiZtTxvSQq' },
];
const UTIL_AGENT_DIM = {
  fdId: F.UTIL_AGENT, name: '客服飞书姓名', fdType: 'STRING', metaType: 'DIM',
  isAggregated: false, calculationType: 'normal',
  formula: '[客服英文名字]（[客服名字]）',
  key: 'TrgbQJmmbOViDfZrRlyiHZdk', nameTranslated: '客服飞书姓名', alias: '客服飞书姓名',
};

// ── Phone ─────────────────────────────────────────────────────────
const PH_COL = [{ name: 'Metric Name', metaType: 'MPH', key: 'mLXLaiHOLIjNBXSnfhTWjCLH', nameTranslated: 'Metric Name', alias: 'Metric Name' }];
const PH_METRICS = [
  { fdId: F.PH_INBOUND,      name: '呼入次数',        fdType: 'DOUBLE', metaType: 'METRIC', isAggregated: true, calculationType: 'aggregation', key: 'PwgzucMKxoMepllEapqRdkPf', level: 'dataset', formula: 'COUNT(DISTINCT(IF([通话类型]=2,[Call ID],null)))' },
  { fdId: F.PH_INBOUND_ANS,  name: '呼入接通次数',    fdType: 'DOUBLE', metaType: 'METRIC', isAggregated: true, calculationType: 'aggregation', key: 'OkeTTQouVpmhfpHwRrUkFPcs', level: 'dataset', formula: 'COUNT(DISTINCT(IF([通话类型]=2 and [通话应答时间]!=0,[Call ID],null)))' },
  { fdId: F.PH_ANS_RATE,     name: '接通率',          fdType: 'DOUBLE', metaType: 'METRIC', isAggregated: true, calculationType: 'aggregation', key: 'LQmMlDGZOkFCvQGILoXaKIJH', formula: 'IF([呼入次数]=0,0,[呼入接通次数]/[呼入次数])' },
  { fdId: F.PH_ANS_20S,      name: '20秒接通率',      fdType: 'DOUBLE', metaType: 'METRIC', isAggregated: true, calculationType: 'aggregation', key: 'AWKYHAkGNBfQuZWyiWQhuvHF', formula: 'IF([呼入接通次数]=0,0,[20秒接通次数]/[呼入接通次数])' },
  { fdId: F.PH_AVG_DURATION, name: '平均通话时长(秒)', fdType: 'DOUBLE', metaType: 'METRIC', isAggregated: true, calculationType: 'aggregation', key: 'fTJfYofoWoUXqegDzMnupyxV', formula: 'if([通话接通次数]=0,0,[通话时长]/[通话接通次数])' },
  { fdId: F.PH_SATISFACTION, name: '满意度',          fdType: 'DOUBLE', metaType: 'METRIC', isAggregated: true, calculationType: 'aggregation', key: 'sEVUFmGKrhPwTPexENVuFhUg', formula: 'if([参评工单数]=0,0,[满意评价数]/[参评工单数])' },
  { fdId: F.PH_FCR, name: '一次性解决率', alias: 'First Contact Resolution Rate', fdType: 'DOUBLE', metaType: 'METRIC', isAggregated: true, calculationType: 'aggregation', formula: 'if([工单总数]=0,0,[一次性解决工单数]/[工单总数])', key: 'DRjiDZAAmfbAFPvHVijPDuXn' },  // index 6
  { fdId: F.PH_NEG_COUNT, name: '不满意评价数', fdType: 'DOUBLE', metaType: 'METRIC', isAggregated: true, calculationType: 'aggregation', key: 'phNegCount001', level: 'dataset', formula: 'SUM([不满意评价数])' },  // index 7
];
// indices: 0=inbound, 1=inboundAns, 2=ansRate, 3=ans20s, 4=avgDuration, 5=satisfaction, 6=fcr, 7=negCount

const PH_AGENT_DIM = {
  fdId: F.PH_AGENT, name: '工单当前处理人', alias: 'Agent', fdType: 'STRING', metaType: 'DIM',
  isAggregated: false, calculationType: 'normal', key: 'KRMnUVGvnqVbdEffKhpGiRys',
  level: 'dataset', nameTranslated: 'Agent', zoneId: 'row',
};

// ── Email ─────────────────────────────────────────────────────────
const EM_COL = [{ name: '度量名', metaType: 'MPH', key: 'VmZwSehqdXATpitHKQGYKjBW', nameTranslated: '度量名', alias: '度量名' }];
const EM_METRICS = [
  { fdId: F.EM_USER_EMAILS, name: '用户邮件咨询量', fdType: 'DOUBLE', metaType: 'METRIC', isAggregated: true, calculationType: 'aggregation', level: 'dataset', formula: 'COUNT([mail_id])', key: 'dKUBPzQoBJFWYRXZczXIpTKc' },
  { fdId: F.EM_REPLIED,     name: '已回复邮件量',   fdType: 'DOUBLE', metaType: 'METRIC', isAggregated: true, calculationType: 'aggregation', level: 'dataset', formula: 'SUM([是否已回复])',  key: 'KCqWmysCPfcXOvuQPIssAdjh' },
  { fdId: F.EM_SLA_30MIN,   name: '30min回复率',   fdType: 'DOUBLE', metaType: 'METRIC', isAggregated: true, calculationType: 'aggregation',                                               key: 'OEiGvisdqsIwaKkFwiMUIDEk' },
  { fdId: F.EM_AVG_REPLY,   name: '邮件平均回复时长', fdType: 'DOUBLE', metaType: 'METRIC', isAggregated: true, calculationType: 'aggregation',                                             key: 'v801bc3c2e3304ae297fd0c6' },
];
// indices: 0=userEmails, 1=replied, 2=sla30min

const EM_AGENT_DIM = {
  fdId: F.EM_AGENT, name: 'reply_sid_nick', fdType: 'STRING', metaType: 'DIM',
  isAggregated: false, calculationType: 'normal',
  key: 'YfzfXuShhSiMJXDQASvgDOSB', nameTranslated: 'reply_sid_nick', alias: 'reply_sid_nick',
};

// ── Email Satisfaction (db4225f75c16b49a0b6ef227) ────────────────
const ESA_COL = [{ name: 'Metric Name', metaType: 'MPH', key: 'mLXLaiHOLIjNBXSnfhTWjCLH', nameTranslated: 'Metric Name' }];
const ESA_METRICS = [
  { fdId: F.ESA_SAT, name: '满意度', fdType: 'DOUBLE', metaType: 'METRIC',
    isAggregated: true, calculationType: 'aggregation', key: 'ewuRsxclTDUsdTbnNmZLOlZV', dsId: F.ESA_DS_ID },
  { fdId: F.ESA_AVG_REPLY, name: '邮件平均回复时长', alias: 'Avg Response Time (min)', fdType: 'DOUBLE', metaType: 'METRIC',
    isAggregated: true, calculationType: 'aggregation',
    formula: 'round(IF(SUM([replied_user_email_count])=0,0,SUM([replied_user_cost_total_time])/SUM([replied_user_email_count]/60)),2)',
    key: 'PRGlWMRwhRTNgclzWeLRqNas', dsId: F.ESA_DS_ID },
  { fdId: F.ESA_30MIN_REPLY, name: '30min回复率', alias: '30min Reply Rate', fdType: 'DOUBLE', metaType: 'METRIC',
    isAggregated: true, calculationType: 'aggregation',
    formula: 'round(IF(SUM([replied_user_email_count])=0,0,SUM([reply_time_lt_30_count])/SUM([replied_user_email_count])),2)',
    key: 'ZJtQrjvYMfNPcEisyPuacvkv', dsId: F.ESA_DS_ID },
  { fdId: F.ESA_NEG_COUNT, name: 'unstisfyed_order_count', fdType: 'DOUBLE', metaType: 'METRIC',
    isAggregated: true, calculationType: 'aggregation', key: 'esaNegCount001', dsId: F.ESA_DS_ID },
];
// indices: 0=satisfaction, 1=avgRespTime, 2=reply30min, 3=negCount
const ESA_AGENT_DIM = {
  fdId: F.ESA_AGENT, name: 'staff_nick', fdType: 'STRING', metaType: 'DIM',
  isAggregated: false, calculationType: 'normal', key: 'utlHrocEyaXplhewOQjPIXzi',
  level: 'dataset', dsId: F.ESA_DS_ID,
};

// ── SLA ───────────────────────────────────────────────────────────
const SLA_COL = [{ name: '度量名', metaType: 'MPH', key: 'FnxPGCkCZRyXHnArJZKFOXqm' }];
const SLA_METRICS = [
  { fdId: F.SLA_RATE, name: 'SLA总体达标率', fdType: 'DOUBLE', metaType: 'METRIC',
    formula: '[总体达标工单数]/[总工单数]', isAggregated: true,
    calculationType: 'aggregation', key: 'FsbIuFAhnTmpURgSYvbTzPJz' },
];
const SLA_GROUP_DIM = {
  fdId: F.SLA_GROUP, name: '客服组', alias: 'Group', fdType: 'STRING', metaType: 'DIM',
  isAggregated: false, calculationType: 'normal',
  key: 'KvalRvwUsqCbZyitvByOcYYc', level: 'dataset', nameTranslated: 'Group',
};

// ─────────────────────────────────────────────────────────────────
// DATA FETCHERS
// ─────────────────────────────────────────────────────────────────

// ── Live Chat ─────────────────────────────────────────────────────
async function fetchLiveChatQueue(start, end) {
  const topFilters = [mkDateFilter(F.LC_DATE, start, end, F.LC_DS_ID, CARDS.LC_QUEUE, F.LC_DATE_SRC)];

  // Use slot key (not fdId) so the API returns proper group names
  const LC_GROUP_DIM = {
    fdId: F.LC_GROUP, key: F.LC_GROUP_KEY, name: '接待客服组', fdType: 'STRING', metaType: 'DIM',
    isAggregated: false, calculationType: 'normal', level: 'dataset', nameTranslated: '接待客服组',
  };

  const [groupResp, agentResp] = await Promise.all([
    guandataPost(CARDS.LC_QUEUE, buildBody([LC_GROUP_DIM], LC_METRICS, topFilters, [], 500, '在线咨询数据')),
    guandataPost(CARDS.LC_QUEUE, buildBody([LC_AGENT_DIM], LC_METRICS, topFilters, [], 500, '在线咨询数据')),
  ]);

  // Extract 转化客服组 row for correct team aggregate (skill-zone filter returns all 16 groups)
  const allGroups = agentRows(groupResp);
  const teamRow = allGroups.find(r => r.name === '转化客服组') || { vals: Array(LC_METRICS.length).fill(null) };
  const [tickets, avgHandle, satisfaction, waitLt10, wait1030, fcr] = teamRow.vals;
  const thirtySecRate = (toInt(tickets) > 0) ? ((toInt(waitLt10) + toInt(wait1030)) / toInt(tickets)) : null;

  const agents = agentRows(agentResp)
    .filter(({ name }) => CONVERSION_TEAM.has(name))
    .map(({ name, vals }) => {
      const t = toInt(vals[0]);
      const lt10 = toInt(vals[3]);
      const b1030 = toInt(vals[4]);
      return {
        name,
        tickets:       num(vals[0]),
        avgHandle:     mins(vals[1]),
        satisfaction:  pct(vals[2]),
        thirtySecRate: pct(t > 0 ? (lt10 + b1030) / t : null),
        fcr:           pct(vals[5]),
        negCount:      toInt(vals[6]),
      };
    });

  return {
    team: {
      tickets:       num(tickets),
      avgHandle:     mins(avgHandle),
      satisfaction:  pct(satisfaction),
      fcr:           pct(fcr),
      thirtySecRate: pct(thirtySecRate),
    },
    agents,
  };
}

async function fetchLiveChatUtil(start, end) {
  const filters = [mkDateFilter(F.UTIL_DATE, start, end, F.UTIL_DS_ID, CARDS.LC_UTIL, F.UTIL_DATE_SRC)];
  const resp = await guandataPost(CARDS.LC_UTIL,
    buildBody([UTIL_AGENT_DIM], UTIL_METRICS, filters, [], 200, '报表', UTIL_COL));

  const rawAgents = agentRows(resp)
    .map(({ name, vals }) => ({
      name: name.split('（')[0].trim(),
      rawUtil: vals[0] != null ? parseFloat(vals[0]) : null,
    }))
    .filter(a => CONVERSION_TEAM.has(a.name));

  const validRates = rawAgents.filter(a => a.rawUtil != null).map(a => a.rawUtil);
  const teamUtilRate = validRates.length ? validRates.reduce((s, v) => s + v, 0) / validRates.length : null;

  return {
    team: { utilRate: pct(teamUtilRate) },
    agents: rawAgents.map(a => ({ name: a.name, utilRate: pct(a.rawUtil) })),
  };
}

// ── Phone ─────────────────────────────────────────────────────────
async function fetchPhone(start, end) {
  const filters = [
    mkDateFilter(F.PH_DATE, start, end, F.PH_DS_ID, CARDS.PHONE, F.PH_DATE_SRC),
    mkTeamFilter(F.PH_TEAM, F.PH_DS_ID, CARDS.PHONE, F.PH_TEAM_SRC),
  ];

  const [teamResp, agentResp] = await Promise.all([
    guandataPost(CARDS.PHONE, buildBody([], PH_METRICS, filters, [], 200, '报表', PH_COL)),
    guandataPost(CARDS.PHONE, buildBody([PH_AGENT_DIM], PH_METRICS, filters, [], 200, '报表', PH_COL)),
  ]);

  const tv = teamValues(teamResp);
  const [inbound, , ansRate, ans20s, avgDuration, satisfaction, fcr] = tv;

  const agents = agentRows(agentResp)
    .filter(({ name }) => CONVERSION_TEAM.has(name))
    .map(({ name, vals }) => ({
      name,
      inbound:      num(vals[0]),
      ans20s:       pct(vals[3]),
      avgDuration:  secs(vals[4]),
      satisfaction: pct(vals[5]),
      fcr:          pct(vals[6]),
      negCount:     toInt(vals[7]),
    }));

  return {
    team: {
      inbound:      num(inbound),
      ansRate:      pct(ansRate),
      ans20s:       pct(ans20s),
      avgDuration:  secs(avgDuration),
      satisfaction: pct(satisfaction),
      fcr:          pct(fcr),
    },
    agents,
  };
}

async function fetchPhoneUtil(start, end) {
  try {
    const PU_DS_ID = 'q5cbae6492b1c4aa483fe773';
    // PIVOT_TABLE card: slot keys from zoneData config (not fdIds)
    const agentDim = {
      fdId: 'kc46dd442419c4278bdd416b', key: 'BlhsmrCGDvAJpjsglVmaYSIk',
      name: '英文名', fdType: 'STRING', metaType: 'DIM',
      isAggregated: false, calculationType: 'normal', level: 'dataset',
    };
    // Must send all 8 card metrics with exact keys — server ignores partial lists
    const allMetrics = [
      { fdId: 'h92645d48774848ba9e5d6a7', key: 'MRbXWHFIDaJSCtVmqwowrXjh', name: '进线和转接时长(时)',   fdType: 'DOUBLE', metaType: 'METRIC', formula: '[进线和转接时长]/3600',   isAggregated: false, calculationType: 'normal' },
      { fdId: 's44ebedaf28034bd1afaeada', key: 'yKvLKUnQYCCgOtYZPwseHrJP', name: '仅转接时长(时)',       fdType: 'DOUBLE', metaType: 'METRIC', formula: '[仅转接时长]/3600',       isAggregated: false, calculationType: 'normal' },
      { fdId: 'v8698414f285f425d9e1fe10', key: 'IlztTXYTzjDnJhybqCEAOrfK', name: '不接待时长(时)',       fdType: 'DOUBLE', metaType: 'METRIC', formula: '[不接待时长]/3600',       isAggregated: false, calculationType: 'normal' },
      { fdId: 'wc5a3079cbe6d43b5ad0d6c8', key: 'xaWstyJjqMWebFYbAXQsbWbM', name: '工时利用率',         fdType: 'DOUBLE', metaType: 'METRIC', formula: 'if(sum([签入时长])=0,0,1-SUM([不接待时长])/sum([签入时长]))', isAggregated: true, calculationType: 'aggregation' },
      { fdId: 'jcd602fc69d45470492f3d0d', key: 'GqrSiAhyPDkIkoMppUDMMjdb', name: '全渠道签入时长（时）', fdType: 'DOUBLE', metaType: 'METRIC', formula: '[全渠道签入时长]/3600',   isAggregated: false, calculationType: 'normal' },
      { fdId: 'j20f4fbcfd5334b83b3f3117', key: 'lKGUtSYhahFQUOUqZGpIVRAm', name: '全渠道工作时长（时）', fdType: 'DOUBLE', metaType: 'METRIC', formula: '[全渠道工作时长]/3600',   isAggregated: false, calculationType: 'normal' },
      { fdId: 'd070935103caa4f899b19240', key: 'xUaUKUxmQmxjloWaheIEWMsm', name: '全渠道工时利用率',   fdType: 'DOUBLE', metaType: 'METRIC', formula: 'if(sum([全渠道签入时长])=0,0,1-SUM([全渠道不接待时长])/sum([全渠道签入时长]))', isAggregated: true, calculationType: 'aggregation' },
      { fdId: 'kfeba449c700e49388894a09', key: 'JyoYsJljEEtwDsxuSevgJFex', name: '整理中时长(时)',       fdType: 'DOUBLE', metaType: 'METRIC', formula: '[整理中时间]/3600',       isAggregated: false, calculationType: 'normal' },
    ];
    const puColumn = [{ name: 'Metric Name', metaType: 'MPH', key: 'KLoHadLxurcpAiddIPfIuAvv', nameTranslated: 'Metric Name' }];
    // Use last 2 days of the BT week (e.g. 7.1-7.2 for week ending 7.2) — full-week filter returns stale all-time data
    // Force UTC parsing to avoid UTC+8 timezone shift turning Jul 2 → Jun 30 via toISOString()
    const d = new Date(end + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 1);
    const penultimate = d.toISOString().slice(0, 10);
    // PU_DATE key in zoneData is 'xSEmvURRZAlqRZGvRZKHQptk', NOT the fdId — must use correct key or filter is ignored
    const filters = [
      { name: 'date', fdId: F.PU_DATE, key: 'xSEmvURRZAlqRZGvRZKHQptk',
        fdType: 'STRING', filterType: 'BT', originFilterType: 'BT',
        filterValue: [penultimate, end], displayValue: [penultimate, end],
        dsId: PU_DS_ID, cdId: PHONE_UTIL_CARD },
    ];
    const resp = await guandataPost(PHONE_UTIL_CARD,
      buildBody([agentDim], allMetrics, filters, [], 200, '', puColumn));
    const allRows = agentRows(resp);
    // vals[3]=工时利用率, vals[6]=全渠道工时利用率
    const rows = allRows
      .filter(({ name }) => CONVERSION_TEAM.has(name))
      .map(({ name, vals }) => ({ name, omniUtil: pct(vals[6]) }));
    return rows;
  } catch (e) {
    console.warn(`[WARN] Phone util (${PHONE_UTIL_CARD}) failed: ${e.message}. Util will show as '-'.`);
    return [];
  }
}

// ── Email ─────────────────────────────────────────────────────────
async function fetchEmail(start, end) {
  const filters = [
    {
      name: 'account_mail', fdId: F.EM_MAIL_FDID, key: F.EM_MAIL_FDID, fdType: 'STRING',
      filterType: 'IN', filterValue: ['ca@us.moomoo.com', 'cs@us.moomoo.com', 'pcs@us.moomoo.com', 'support@moomoocrypto.com'],
      dsId: F.EM_DS_ID, cdId: CARDS.EMAIL, sourceCdId: F.EM_MAIL_SRC,
    },
    {
      name: 'consult_time_date', fdId: F.EM_DATE, key: F.EM_DATE_KEY, fdType: 'STRING',
      filterType: 'BT', filterValue: [start, end], displayValue: [start, end],
      dsId: F.EM_DS_ID, cdId: CARDS.EMAIL,
    },
    {
      name: 'reply_sid_nick', fdId: F.EM_AGENT, key: F.EM_AGENT, fdType: 'STRING',
      filterType: 'IN', filterValue: [...CONVERSION_TEAM],
      dsId: F.EM_DS_ID, cdId: CARDS.EMAIL,
    },
  ];

  const [teamResp, agentResp] = await Promise.all([
    guandataPost(CARDS.EMAIL, buildBody([], EM_METRICS, filters, [], 200, '报表', EM_COL)),
    guandataPost(CARDS.EMAIL, buildBody([EM_AGENT_DIM], EM_METRICS, filters, [], 200, '报表', EM_COL)),
  ]);

  const tv = teamValues(teamResp);
  // 0=userEmails, 1=replied, 2=sla30min, 3=avgRespTime

  return {
    team: { userEmails: num(tv[0]), replied: num(tv[1]), sla30min: pct(tv[2]), avgRespTime: mins(tv[3]) },
    agents: agentRows(agentResp)
      .filter(({ name }) => CONVERSION_TEAM.has(name))
      .map(({ name, vals }) => ({ name, tickets: num(vals[1]), slaRate: pct(vals[2]), avgRespTime: mins(vals[3]) })),
  };
}

async function fetchEmailSat(start, end) {
  const filters = [
    {
      name: 'statis_date', fdId: F.ESA_DATE, key: 'OTQPRuVPUnEKcjOCXZIsZlNZ',
      fdType: 'STRING', filterType: 'BT', originFilterType: 'BT',
      filterValue: [start, end], displayValue: [start, end],
      dsId: F.ESA_DS_ID, cdId: CARDS.EMAIL_SAT, sourceCdId: F.ESA_DATE_SRC,
    },
  ];
  const [teamResp, agentResp] = await Promise.all([
    guandataPost(CARDS.EMAIL_SAT, buildBody([], ESA_METRICS, filters, [], 200, '报表', ESA_COL)),
    guandataPost(CARDS.EMAIL_SAT, buildBody([ESA_AGENT_DIM], ESA_METRICS, filters, [], 200, '报表', ESA_COL)),
  ]);
  const tv = teamValues(teamResp);
  return {
    team: { satisfaction: pct(tv[0]), avgRespTime: mins(tv[1]), reply30min: pct(tv[2]) },
    agents: agentRows(agentResp)
      .filter(({ name }) => CONVERSION_TEAM.has(name))
      .map(({ name, vals }) => ({ name, satisfaction: pct(vals[0]), avgRespTime: mins(vals[1]), reply30min: pct(vals[2]), negCount: toInt(vals[3]) })),
  };
}

async function fetchSLA(start, end) {
  const dateFilter = {
    name: '工单创建日期', fdId: F.SLA_DATE, dsId: F.SLA_DS_ID, cdId: CARDS.SLA,
    fdType: 'STRING', filterType: 'BT', originFilterType: 'BT',
    sourceCdId: F.SLA_DATE_SRC, filterValue: [start, end], displayValue: [start, end],
  };
  const groupFilter = {
    name: '客服组', fdId: F.SLA_GROUP, dsId: F.SLA_DS_ID, cdId: CARDS.SLA,
    fdType: 'STRING', filterType: 'IN', filterValue: [TEAM_NAME],
    sourceCdId: F.SLA_GROUP_SRC, level: 'dataset', filterLevel: 'DETAIL',
  };
  const SLA_AGENT_DIM = {
    fdId: F.SLA_AGENT_NAME, name: '客服姓名', fdType: 'STRING', metaType: 'DIM',
    isAggregated: false, calculationType: 'normal', key: 'slaAgentKey001', level: 'dataset',
  };
  const [teamResp, agentResp] = await Promise.all([
    guandataPost(CARDS.SLA, buildBody([SLA_GROUP_DIM], SLA_METRICS, [dateFilter], [], 200, 'SLA Report', SLA_COL)),
    guandataPost(CARDS.SLA, buildBody([SLA_AGENT_DIM], SLA_METRICS, [dateFilter, groupFilter], [], 200, 'SLA Report', SLA_COL)),
  ]);
  const teamRows = agentRows(teamResp);
  const csRow = teamRows.find(r => r.name === TEAM_NAME);
  const agentSlaRows = agentRows(agentResp);
  return {
    overallSLA: csRow ? pct(csRow.vals[0]) : '-',
    agents: agentSlaRows.map(({ name, vals }) => ({ name, slaRate: pct(vals[0]) })),
  };
}

// ── Outbound ──────────────────────────────────────────────────────
async function fetchOutbound(start, end) {
  // Leads window: (--ob-start || start) 19:00 BT → (--ob-end || end+1day) 16:00 BT
  const obStartDate = obStartArg || start;
  const start_at = toUnixBT(obStartDate, 19);
  const obEndDate = obEndArg || (() => {
    const d = new Date(end + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10);
  })();
  const end_at = toUnixBT(obEndDate, 16);

  const startD0 = toYYYYMMDD(start);
  const endD0   = toYYYYMMDD(end);
  const pcStart = obStartArg ? toYYYYMMDD(obStartArg) : startD0;
  const mStart  = obStartArg ? toYYYYMMDD(obStartArg) : toYYYYMMDD(monthStart(end));

  const [leadsResp, weekTeamResp, weekStaffResp, monthTeamResp, monthStaffResp] = await Promise.all([
    uscmGet('/api/am/us/statistics/marketing-details', { start_at: String(start_at), end_at: String(end_at) }),
    uscmGet('/api/am/us/overseas-performance/total-stats', { start_date: pcStart, end_date: endD0, area: 'US' }),
    uscmGet('/api/am/us/overseas-performance/staff-stats',  { start_date: pcStart, end_date: endD0, area: 'US', role: '1' }),
    mStart !== pcStart
      ? uscmGet('/api/am/us/overseas-performance/total-stats', { start_date: mStart, end_date: endD0, area: 'US' })
      : null,
    mStart !== pcStart
      ? uscmGet('/api/am/us/overseas-performance/staff-stats',  { start_date: mStart, end_date: endD0, area: 'US', role: '1' })
      : null,
  ]);

  // Parse leads — aggregate per staff
  const leadsArr = leadsResp?.data || [];
  const staffIdMap = new Map();
  const byStaff   = new Map();
  for (const row of leadsArr) {
    if (row.staff_id) staffIdMap.set(row.staff_id, { staff_name: row.staff_name, display_name: row.display_name || row.staff_name });
    if (!CONVERSION_TEAM.has(row.staff_name)) continue;
    if (!byStaff.has(row.staff_name)) {
      byStaff.set(row.staff_name, { name: row.display_name || row.staff_name,
        leadsAssigned: 0, followCount: 0, effectiveFollow: 0, weeklyPC: 0, monthlyPC: 0 });
    }
    const s = byStaff.get(row.staff_name);
    s.leadsAssigned    += row.clue_distributed      || 0;
    s.followCount      += row.clue_followed         || 0;
    s.effectiveFollow  += row.clue_effective_called || 0;
  }

  // Weekly PC per staff — sum all days
  for (const row of (weekStaffResp?.data?.list || [])) {
    if (!row.staff_id) continue;
    const info = staffIdMap.get(row.staff_id);
    if (!info || !CONVERSION_TEAM.has(info.staff_name)) continue;
    if (!byStaff.has(info.staff_name)) {
      byStaff.set(info.staff_name, { name: info.display_name, leadsAssigned: 0, followCount: 0, effectiveFollow: 0, weeklyPC: 0, monthlyPC: 0 });
    }
    byStaff.get(info.staff_name).weeklyPC += row.total_pc || 0;
  }

  // Monthly PC per staff — sum all days
  const monthStaffList = (monthStaffResp ?? weekStaffResp)?.data?.list || [];
  for (const row of monthStaffList) {
    if (!row.staff_id) continue;
    const info = staffIdMap.get(row.staff_id);
    if (!info || !CONVERSION_TEAM.has(info.staff_name)) continue;
    if (!byStaff.has(info.staff_name)) {
      byStaff.set(info.staff_name, { name: info.display_name, leadsAssigned: 0, followCount: 0, effectiveFollow: 0, weeklyPC: 0, monthlyPC: 0 });
    }
    byStaff.get(info.staff_name).monthlyPC += row.total_pc || 0;
  }

  const agents = TEAM_ORDER
    .filter(n => byStaff.has(n))
    .map(n => {
      const s = byStaff.get(n);
      return {
        name:           n,
        leadsAssigned:  num(s.leadsAssigned),
        followCount:    num(s.followCount),
        effectiveFollow:num(s.effectiveFollow),
        weeklyPC:       num(s.weeklyPC),
        monthlyPC:      num(s.monthlyPC),
      };
    });

  // Team PC = sum of conversion team members only (not all US staff)
  const weeklyPC  = agents.reduce((sum, a) => sum + (parseInt(a.weeklyPC)  || 0), 0);
  const monthlyPC = agents.reduce((sum, a) => sum + (parseInt(a.monthlyPC) || 0), 0);

  return {
    team: { weeklyPC: num(weeklyPC), monthlyPC: num(monthlyPC) },
    agents,
  };
}

// ─────────────────────────────────────────────────────────────────
// HTML GENERATION
// ─────────────────────────────────────────────────────────────────
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function th(...cols) { return '<tr>' + cols.map(c => `<th>${c}</th>`).join('') + '</tr>'; }
function tr(...cells) {
  return '<tr>' + cells.map(c => {
    if (c && typeof c === 'object' && 'html' in c) return `<td>${c.html}</td>`;
    return `<td>${esc(String(c))}</td>`;
  }).join('') + '</tr>';
}
function trB(...cells) {
  return '<tr class="team-row">' + cells.map(c => {
    const inner = typeof c === 'string' && c.startsWith('<') ? c : `<strong>${esc(c)}</strong>`;
    return `<td>${inner}</td>`;
  }).join('') + '</tr>';
}
function ansCell(label, val, dotHtml = '', target = '') {
  const tgt = target ? `<span class="tgt">≥${target}</span>` : '';
  return `<strong>${esc(String(val))}</strong>${dotHtml}<span class="lbl">${esc(label)}</span>${tgt}`;
}
function dot(pctStr, threshold) {
  if (!pctStr || pctStr === '-') return '';
  const v = parseFloat(pctStr);
  if (isNaN(v)) return '';
  return `<span class="dot ${v >= threshold ? 'dot-green' : 'dot-red'}"></span>`;
}
function kpiCell(val, threshold) {
  if (!val || val === '-') return val || '-';
  const v = parseFloat(val);
  if (isNaN(v) || v === 0) return val;   // 0% skip judgment
  if (v >= threshold) return val;         // pass: no indicator
  return { html: `${esc(String(val))}<span class="dot dot-red"></span>` };
}
function b(zh, en) { return `${zh}<br><span class="en">${en}</span>`; }
function tbl(header, rows, emptyMsg = '暂无数据', colgroup = '', cls = '') {
  const body = rows.length ? rows.join('') : `<tr><td colspan="20" class="empty">${emptyMsg}</td></tr>`;
  const clsAttr = cls ? ` class="${cls}"` : '';
  return `<table${clsAttr}>${colgroup}<thead>${header}</thead><tbody>${body}</tbody></table>`;
}
function sect(id, titleZh, titleEn, content) {
  return `<div class="section" id="${id}"><h2><span class="sect-num">${id}</span>${titleZh} <span class="en">${titleEn}</span></h2>${content}</div>`;
}

function generateHTML(data, weekStart, weekEnd) {
  const { lc, util, phone, phoneUtil, email, emailSat, sla, outbound } = data;

  // Build lookup maps
  const utilMap    = {};  (util.agents    || []).forEach(a => { utilMap[a.name]    = a; });
  const lcMap      = {};  (lc.agents      || []).forEach(a => { lcMap[a.name]      = a; });
  const phoneMap   = {};  (phone.agents   || []).forEach(a => { phoneMap[a.name]   = a; });
  const puMap      = {};  (phoneUtil      || []).forEach(a => { puMap[a.name]      = a; });
  const emailMap   = {};  (email.agents   || []).forEach(a => { emailMap[a.name]   = a; });
  const emailSatMap= {};  (emailSat.agents|| []).forEach(a => { emailSatMap[a.name]= a; });
  const obMap      = {};  (outbound.agents|| []).forEach(a => { obMap[a.name]      = a; });
  const slaAgentMap= {};  (sla.agents     || []).forEach(a => { slaAgentMap[a.name]= a; });

  // ── Section I.A: Channel Team Summary ──────────────────────────
  const obTotalFollow    = outbound.agents.reduce((s,a) => s + (parseInt(a.followCount)    || 0), 0);
  const obTotalEffective = outbound.agents.reduce((s,a) => s + (parseInt(a.effectiveFollow) || 0), 0);
  const obEffectiveRate  = obTotalFollow > 0 ? (obTotalEffective / obTotalFollow * 100).toFixed(1) + '%' : '-';

  const teamColgroup = '<colgroup>'
    + '<col style="width:13%">'   // 渠道
    + '<col style="width:8%">'    // 工单量
    + '<col style="width:20%">'   // 接通率
    + '<col style="width:20%">'   // 满意度
    + '<col style="width:20%">'   // FCR
    + '<col style="width:19%">'   // 平均处理时长
    + '</colgroup>';
  const teamSummaryTable = tbl(
    th(b('渠道','Channel'), b('工单量','Volume'), b('接通率','Answer Rate'), b('满意度','CSAT'), b('一次性解决率','FCR'), b('平均处理时长','Avg Handle')),
    [
      trB('在线 Live Chat',
        lc.team.tickets,
        ansCell('30s接通', lc.team.thirtySecRate, dot(lc.team.thirtySecRate, 90), '90%'),
        `<strong>${esc(lc.team.satisfaction)}</strong>${dot(lc.team.satisfaction, 84)}<span class="tgt">≥84%</span>`,
        `<strong>${esc(lc.team.fcr)}</strong>${dot(lc.team.fcr, 95)}<span class="tgt">≥95%</span>`,
        lc.team.avgHandle),
      trB('电话 Phone',
        phone.team.inbound,
        ansCell('20s接通', phone.team.ans20s, dot(phone.team.ans20s, 95), '95%'),
        `<strong>${esc(phone.team.satisfaction)}</strong>${dot(phone.team.satisfaction, 84)}<span class="tgt">≥84%</span>`,
        `<strong>${esc(phone.team.fcr)}</strong>${dot(phone.team.fcr, 95)}<span class="tgt">≥95%</span>`,
        phone.team.avgDuration),
      trB('邮件 Email',
        email.team.replied,
        ansCell('Overall SLA', sla.overallSLA, dot(sla.overallSLA, 90), '90%'),
        `<strong>${esc(emailSat.team.satisfaction)}</strong>${dot(emailSat.team.satisfaction, 84)}<span class="tgt">≥84%</span>`,
        '-',
        '-'),
      trB('外呼 Outbound',
        obTotalFollow,
        ansCell('有效跟进率', obEffectiveRate),
        `<span style="color:#1456F0;font-weight:600">Weekly PC ${outbound.team.weeklyPC}</span>`,
        `<span style="color:#1456F0;font-weight:600">Monthly PC ${outbound.team.monthlyPC}</span>`,
        '-'),
    ],
    '暂无数据',
    teamColgroup,
    'team-summary'
  );

  // ── Section I.B: Individual Summary ────────────────────────────
  const agentSummaryRows = TEAM_ORDER.map(name => {
    const lcData = lcMap[name]       || {};
    const phData = phoneMap[name]    || {};
    const emSat  = emailSatMap[name] || {};
    const ob     = obMap[name]       || {};
    const pu     = puMap[name]       || {};
    const lcTix  = toInt(lcData.tickets);
    const phTix  = toInt(phData.inbound);
    const emTix  = toInt((emailMap[name] || {}).tickets);
    const total  = lcTix + phTix + emTix;
    const lcSatN = parseFloat(lcData.satisfaction) || 0;
    const phSatN = parseFloat(phData.satisfaction) || 0;
    const emSatN = parseFloat(emSat.satisfaction)  || 0;
    const combinedCsat = total > 0
      ? ((lcTix * lcSatN + phTix * phSatN + emTix * emSatN) / total).toFixed(1) + '%'
      : '-';
    return { name, total, row: tr(
      name,
      total || '-',
      combinedCsat,
      pu.omniUtil || '-',
      (ob.weeklyPC  != null && ob.weeklyPC  !== '-') ? ob.weeklyPC  : 0,
      (ob.monthlyPC != null && ob.monthlyPC !== '-') ? ob.monthlyPC : 0,
    )};
  }).sort((a, b) => b.total - a.total).map(x => x.row);

  const individualSummaryTable = tbl(
    th(b('客服','Agent'), b('总工单','Total Tickets'), b('满意度','CSAT'), b('全渠道利用率','Omni Util'), b('周PC','Weekly PC'), b('月PC','Monthly PC')),
    agentSummaryRows
  );

  // ── Section II.A: Live Chat Individual ─────────────────────────
  const lcIndRows = TEAM_ORDER
    .filter(name => lcMap[name])
    .map(name => {
      const lca = lcMap[name] || {};
      return tr(name, lca.tickets || '-',
        kpiCell(lca.thirtySecRate, 90),
        kpiCell(lca.satisfaction, 84),
        kpiCell(lca.fcr, 95),
        lca.avgHandle || '-');
    });
  const lcIndTable = tbl(
    th(b('客服','Agent'), b('工单','Tickets'), b('30s接通','30s Rate'), b('满意度','CSAT'), b('一次性解决率','FCR'), b('平均处理时长','Avg Handle')),
    lcIndRows
  );

  // ── Section II.B: Phone Individual ─────────────────────────────
  const phIndRows = TEAM_ORDER
    .filter(name => phoneMap[name])
    .map(name => {
      const ph = phoneMap[name] || {};
      return tr(name, ph.inbound || '-',
        kpiCell(ph.ans20s, 95),
        ph.avgDuration || '-',
        kpiCell(ph.satisfaction, 84),
        kpiCell(ph.fcr, 95));
    });
  const phIndTable = tbl(
    th(b('客服','Agent'), b('呼入','Inbound'), b('20s接通','20s Rate'), b('通话时长','Call Dur.'), b('满意度','CSAT'), b('一次性解决率','FCR')),
    phIndRows
  );

  // ── Section II.C: Email Individual ─────────────────────────────
  const emIndRows = TEAM_ORDER
    .filter(name => emailMap[name])
    .map(name => {
      const em  = emailMap[name]    || {};
      const esa = emailSatMap[name] || {};
      return tr(name, em.tickets || '-',
        kpiCell(em.slaRate, 90),
        esa.satisfaction || '-');
    });
  const emIndTable = tbl(
    th(b('客服','Agent'), b('工单','Tickets'), b('SLA达标','SLA Rate'), b('满意度','CSAT')),
    emIndRows
  );

  // ── Section II.D: Outbound Individual ──────────────────────────
  const obIndRows = TEAM_ORDER
    .filter(name => obMap[name])
    .map(name => {
      const ob = obMap[name] || {};
      return { eff: toInt(ob.effectiveFollow), row: tr(name, ob.leadsAssigned || '-', ob.followCount || '-', ob.effectiveFollow || '-',
        (ob.weeklyPC != null && ob.weeklyPC !== '-') ? ob.weeklyPC : 0) };
    })
    .sort((a, b) => b.eff - a.eff)
    .map(x => x.row);
  const obIndTable = tbl(
    th(b('客服','Agent'), b('分配Leads','Leads Assigned'), b('跟进量','Follow-up'), b('有效跟进','Eff. Follow'), b('周PC','Weekly PC')),
    obIndRows
  );

  // ── Section II.E: Performance Analysis ────────────────────────
  const analysisItems = [];
  const metricChecks = [
    { label: '在线 30s接通率', val: lc.team.thirtySecRate,    target: 90, type: '异常' },
    { label: '在线满意度',     val: lc.team.satisfaction,     target: 84, type: '异常' },
    { label: '在线 FCR',       val: lc.team.fcr,              target: 95, type: '待提升' },
    { label: '电话 20s接通率', val: phone.team.ans20s,        target: 95, type: '异常' },
    { label: '电话满意度',     val: phone.team.satisfaction,  target: 84, type: '异常' },
    { label: '电话 FCR',       val: phone.team.fcr,           target: 95, type: '待提升' },
    { label: '团队 Overall SLA', val: sla.overallSLA,         target: 90, type: '异常' },
  ];
  for (const { label, val, target, type } of metricChecks) {
    const n = parseFloat(val);
    if (!isNaN(n) && val !== '-' && n < target) {
      analysisItems.push({ type, text: `${label} <strong>${val}</strong>，低于目标 ≥${target}%` });
    }
  }
  // Per-agent low email SLA
  const lowEmailSla = TEAM_ORDER
    .filter(name => toInt((emailMap[name]||{}).tickets) > 0 && parseFloat((emailMap[name]||{}).slaRate) < 90)
    .map(name => `${name}(${(emailMap[name]||{}).slaRate||'-'})`);
  if (lowEmailSla.length > 0)
    analysisItems.push({ type: '待提升', text: `邮件 SLA 未达 90%：${lowEmailSla.join('、')}` });
  // Per-agent low combined CSAT
  const lowCsatAgents = [];
  for (const name of TEAM_ORDER) {
    const lcD = lcMap[name]||{}, phD = phoneMap[name]||{}, emD = emailSatMap[name]||{};
    const lcT = toInt(lcD.tickets), phT = toInt(phD.inbound), emT = toInt((emailMap[name]||{}).tickets);
    const tot = lcT + phT + emT;
    if (tot === 0) continue;
    const w = (lcT*(parseFloat(lcD.satisfaction)||0) + phT*(parseFloat(phD.satisfaction)||0) + emT*(parseFloat(emD.satisfaction)||0)) / tot;
    if (w < 84) lowCsatAgents.push(`${name}(${w.toFixed(1)}%)`);
  }
  if (lowCsatAgents.length > 0)
    analysisItems.push({ type: '待提升', text: `综合满意度低于 84%：${lowCsatAgents.join('、')}` });
  // Zero weekly PC agents (who have outbound record)
  const zeroPcAgents = TEAM_ORDER.filter(name => {
    const ob = obMap[name];
    return ob && (ob.weeklyPC === 0 || ob.weeklyPC === '0' || !ob.weeklyPC);
  });
  if (zeroPcAgents.length > 0)
    analysisItems.push({ type: '待提升', text: `本周 PC 为 0：${zeroPcAgents.join('、')}` });

  const analysisHtml = analysisItems.length === 0
    ? '<p style="color:#22c55e;font-size:13px;font-weight:500">本周各项指标均达标，团队表现良好。</p>'
    : analysisItems.map(({ type, text }) => {
        const color = type === '异常' ? '#ef4444' : '#f59e0b';
        return `<div style="display:flex;gap:8px;align-items:flex-start;margin-bottom:10px">` +
          `<span style="background:${color};color:#fff;font-size:10px;font-weight:600;padding:2px 6px;border-radius:3px;white-space:nowrap;margin-top:2px">${type}</span>` +
          `<span style="font-size:13px;color:#333;line-height:1.6">${text}</span></div>`;
      }).join('');

  // ── Full HTML ──────────────────────────────────────────────────
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>US CSS Weekly Report — ${weekStart} ~ ${weekEnd}</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, "Segoe UI", Arial, sans-serif; background: #f5f7fa; color: #1a1a2e; padding: 24px; }
h1 { font-size: 22px; font-weight: 700; color: #1456F0; margin-bottom: 8px; border-bottom: 3px solid #1456F0; padding-bottom: 10px; }
.subtitle { font-size: 13px; color: #666; margin-bottom: 24px; }
h2 { font-size: 15px; font-weight: 700; color: #fff; margin-bottom: 14px; padding: 9px 16px;
     background: linear-gradient(135deg, #1456F0, #3d7ff5); border-radius: 8px; display: flex; align-items: center; gap: 8px; }
.sect-num { background: rgba(255,255,255,.25); border-radius: 4px; padding: 1px 7px; font-size: 13px; }
h3 { font-size: 12px; font-weight: 600; color: #1456F0; margin: 14px 0 6px; text-transform: uppercase; letter-spacing: .5px; }
.section { background: #fff; border-radius: 10px; padding: 20px; margin-bottom: 20px; box-shadow: 0 1px 4px rgba(0,0,0,.08); }
.cols2 { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
.cols-wide { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
.cols-wide > div { min-width: 0; overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
th { background: #eef2ff; color: #1456F0; text-align: left; padding: 7px 8px; border-bottom: 2px solid #c0d0f0; white-space: nowrap; }
td { padding: 6px 8px; border-bottom: 1px solid #eef0f5; white-space: nowrap; }
.team-summary { table-layout: fixed; }
.team-summary td { white-space: normal; overflow-wrap: break-word; vertical-align: middle; }
tr:hover td { background: #f8f9ff; }
.team-row td { font-weight: 600; background: #f0f4ff; }
td.empty { color: #aaa; text-align: center; }
.en { font-size: 11px; color: #999; font-weight: 400; }
.lbl { font-size: 11px; color: #aaa; font-weight: 400; margin-left: 3px; }
.editable-area { min-height: 120px; border: 1px solid #e0e4f0; border-radius: 6px; padding: 12px 14px;
                 font-size: 13px; color: #333; line-height: 1.7; outline: none;
                 background: #fafbff; }
.editable-area:focus { border-color: #1456F0; box-shadow: 0 0 0 2px rgba(20,86,240,.1); }
.editable-hint { font-size: 11px; color: #aaa; margin-bottom: 6px; }
.meta { font-size: 11px; color: #aaa; margin-top: 8px; }
.dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-left:4px; vertical-align:middle; }
.dot-green { background:#22c55e; }
.dot-red { background:#ef4444; }
.cell-fail { color:#ef4444; }
.tgt { font-size:10px; color:#bbb; font-weight:400; margin-left:4px; }
@media (max-width: 750px) { .cols2, .cols-wide { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<h1>US CSS Weekly Report</h1>
<p class="subtitle">${obStartArg ? obStartArg.slice(5) + ' ~ ' + weekEnd.slice(5) : weekStart + ' ~ ' + weekEnd} &nbsp;|&nbsp; Conversion CS Team (${TEAM_ORDER.length} agents)</p>

${sect('一', '业绩情况', 'Performance Overview', `
  <h3>Channel Team Summary</h3>
  ${teamSummaryTable}
  <h3 style="margin-top:18px">Individual Summary</h3>
  ${individualSummaryTable}
`)}

${sect('二', '个人业绩分析', 'Individual Breakdown', `
  <div class="cols-wide">
    <div>
      <h3>在线 Live Chat</h3>
      ${lcIndTable}
      <h3 style="margin-top:16px">电话 Phone</h3>
      ${phIndTable}
    </div>
    <div>
      <h3>邮件 Email</h3>
      ${emIndTable}
      <h3 style="margin-top:16px">外呼 Outbound</h3>
      <p class="meta">Leads window: ${weekStart} 19:00 BT → ${obEndArg || addDays(weekEnd, 1)} 16:00 BT</p>
      ${obIndTable}
    </div>
  </div>
  <h3 style="margin-top:18px">业绩分析 Performance Analysis</h3>
  <div style="margin-top:8px">${analysisHtml}</div>
`)}

${sect('三', '本周重点工作', "This Week's Highlights", `
  <p class="editable-hint">点击下方区域直接编辑 / Click to edit</p>
  <div class="editable-area" contenteditable="true" spellcheck="false">请填写本周重点工作...</div>
`)}

${sect('四', '下周安排', "Next Week's Plans", `
  <p class="editable-hint">点击下方区域直接编辑 / Click to edit</p>
  <div class="editable-area" contenteditable="true" spellcheck="false">请填写下周安排...</div>
`)}

<p class="meta">Generated: ${new Date().toISOString()} &nbsp;|&nbsp; Week: ${weekStart} ~ ${weekEnd}</p>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────
async function main() {
  if (DISCOVER) { await runDiscover(); return; }

  const { start, end } = getWeekRange();
  const dataStart = dataStartArg || start;
  console.log(`Generating weekly report: ${start} ~ ${end}${dataStart !== start ? ` (channel data from ${dataStart})` : ''}`);

  const [lcR, utilR, phoneR, puR, emailR, emailSatR, slaR, obR] = await Promise.allSettled([
    fetchLiveChatQueue(dataStart, end),
    fetchLiveChatUtil(dataStart, end),
    fetchPhone(dataStart, end),
    fetchPhoneUtil(start, end),
    fetchEmail(dataStart, end),
    fetchEmailSat(dataStart, end),
    fetchSLA(dataStart, end),
    fetchOutbound(start, end),
  ]);

  function unwrap(r, label, fallback) {
    if (r.status === 'fulfilled') return r.value;
    console.error(`[ERROR] ${label}: ${r.reason?.message || r.reason}`);
    return fallback;
  }

  const data = {
    lc:       unwrap(lcR,    '在线客服',   { team: {}, agents: [] }),
    util:     unwrap(utilR,  '工时利用率', { team: { utilRate: '-' }, agents: [] }),
    phone:    unwrap(phoneR, '电话',       { team: {}, agents: [] }),
    phoneUtil:unwrap(puR,    '电话利用率', []),
    email:    unwrap(emailR,    '邮件',       { team: {}, agents: [] }),
    emailSat: unwrap(emailSatR, '邮件满意度', { team: { satisfaction: '-' }, agents: [] }),
    sla:      unwrap(slaR,   'SLA',        { overallSLA: '-' }),
    outbound: unwrap(obR,    '外呼',       { team: { weeklyPC: '-', monthlyPC: '-' }, agents: [] }),
  };

  const html = generateHTML(data, start, end);
  const outFile = outArg || path.join(
    process.env.USERPROFILE || process.env.HOME || '.',
    `weekly_report_${start}.html`
  );
  fs.writeFileSync(outFile, html, 'utf8');
  console.log(`Report saved: ${outFile}`);
}

main().catch(e => { console.error(e); process.exit(1); });
