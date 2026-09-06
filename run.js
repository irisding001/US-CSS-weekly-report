#!/usr/bin/env node
/**
 * US CSS Weekly Report Generator — 12-person conversion CS team
 *
 * Generates a 5-section HTML report covering Live Chat, Phone, Email, Outbound, and CSAT Analysis.
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
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

// Auto-load .env from skill directory
try {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf-8').split('\n').forEach(line => {
    const eq = line.indexOf('=');
    if (eq > 0 && !line.startsWith('#')) {
      const k = line.slice(0, eq).trim();
      const v = line.slice(eq + 1).trim();
      if (k && !process.env[k]) process.env[k] = v;
    }
  });
} catch {}

// Fallback: load cookies from run_weekly_config.json (same source as us-css-sat)
try {
  const cfgPath = path.join(process.env.USERPROFILE || process.env.HOME || '', 'run_weekly_config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
  ['DATA_COOKIE', 'USCM_COOKIE', 'USCM_CSRF', 'WS_COOKIE'].forEach(k => {
    if (cfg[k] && !process.env[k]) process.env[k] = cfg[k];
  });
} catch {}

// ─────────────────────────────────────────────────────────────────
// CLI ARGS
// ─────────────────────────────────────────────────────────────────
const args           = process.argv.slice(2);
const DISCOVER       = args.includes('--discover');
const DISCOVER_PAGE  = args.includes('--discover-page') ? args[args.indexOf('--discover-page') + 1] : null;
const getArg         = f => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; };
const weekStartArg = getArg('--week-start');
const weekEndArg   = getArg('--week-end');
const obStartArg   = getArg('--ob-start');
const obEndArg     = getArg('--ob-end');
const dataStartArg = getArg('--data-start');
const outArg       = getArg('--out');
const lcPCArg      = getArg('--lc-pc');
const phonePCArg   = getArg('--phone-pc');
const emailPCArg   = getArg('--email-pc');
const lcCSATArg      = getArg('--lc-csat');
const phoneCSATArg   = getArg('--phone-csat');
const emailCSATArg   = getArg('--email-csat');
const agentConsultPCArg = getArg('--agent-consult-pc');
const agentConsultPCMap = {};
if (agentConsultPCArg) {
  for (const pair of agentConsultPCArg.split(',')) {
    const eq = pair.indexOf('=');
    if (eq > 0) agentConsultPCMap[pair.slice(0, eq).trim()] = parseInt(pair.slice(eq + 1).trim()) || 0;
  }
}
const agentMonthlyConsultPCArg = getArg('--agent-monthly-consult-pc');
const agentMonthlyConsultPCMap = {};
if (agentMonthlyConsultPCArg) {
  for (const pair of agentMonthlyConsultPCArg.split(',')) {
    const eq = pair.indexOf('=');
    if (eq > 0) agentMonthlyConsultPCMap[pair.slice(0, eq).trim()] = parseInt(pair.slice(eq + 1).trim()) || 0;
  }
}
const agentAttendanceArg = getArg('--agent-attendance');
const agentAttendanceMap = {};
if (agentAttendanceArg) {
  for (const pair of agentAttendanceArg.split(',')) {
    const eq = pair.indexOf('=');
    if (eq > 0) agentAttendanceMap[pair.slice(0, eq).trim()] = parseInt(pair.slice(eq + 1).trim()) || 0;
  }
}
const NO_HIGHLIGHTS = args.includes('--no-highlights');
const IS_MONTHLY    = args.includes('--monthly');
const prevLcTickets   = getArg('--prev-lc-tickets');
const prevLcCsat      = getArg('--prev-lc-csat');
const prevPhoneTickets= getArg('--prev-phone-tickets');
const prevPhoneCsat   = getArg('--prev-phone-csat');
const prevEmailTickets= getArg('--prev-email-tickets');
const prevEmailCsat   = getArg('--prev-email-csat');
const prevObPc        = getArg('--prev-ob-pc');
const prevWeeklyPc    = getArg('--prev-weekly-pc');
const monthlyPCKpi    = parseInt(getArg('--monthly-pc-kpi') || '80') || 80;

// ─────────────────────────────────────────────────────────────────
// ENV / AUTH
// ─────────────────────────────────────────────────────────────────
const DATA_COOKIE = process.env.DATA_COOKIE || '';
const USCM_COOKIE = process.env.USCM_COOKIE || '';
const USCM_CSRF   = process.env.USCM_CSRF   || '';
const WS_COOKIE   = process.env.WS_COOKIE   || '';  // us-workspace.futuoa.com session (optional)

// ─────────────────────────────────────────────────────────────────
// AUTO-REFRESH COOKIES  (launches setup_cookies.py when creds are missing)
// ─────────────────────────────────────────────────────────────────
async function autoRefreshAndRestart() {
  const { spawn, spawnSync } = require('child_process');
  const cfgFile  = path.join(process.env.USERPROFILE || process.env.HOME || '', 'run_weekly_config.json');
  const setupPy  = path.join(process.env.USERPROFILE || process.env.HOME || '', 'setup_cookies.py');
  if (!fs.existsSync(setupPy)) {
    console.error(`[AUTH] setup_cookies.py not found at ${setupPy}`);
    process.exit(1);
  }
  const oldMtime = fs.existsSync(cfgFile) ? fs.statSync(cfgFile).mtimeMs : 0;
  console.log('[AUTH] Cookie 缺失或过期，正在弹出 IOA 登录窗口...');
  spawn('cmd.exe', ['/c', 'start', '', 'py', setupPy], { detached: true, stdio: 'ignore' }).unref();
  console.log('[AUTH] 请在浏览器中完成三个站点的 IOA 登录，完成后脚本自动继续（最多 5 分钟）...');
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 300_000;
    const timer = setInterval(() => {
      if (fs.existsSync(cfgFile) && fs.statSync(cfgFile).mtimeMs > oldMtime) {
        clearInterval(timer);
        const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf-8'));
        if (cfg.DATA_COOKIE)  process.env.DATA_COOKIE  = cfg.DATA_COOKIE;
        if (cfg.USCM_COOKIE)  process.env.USCM_COOKIE  = cfg.USCM_COOKIE;
        if (cfg.USCM_CSRF)    process.env.USCM_CSRF    = cfg.USCM_CSRF;
        if (cfg.WS_COOKIE)    process.env.WS_COOKIE    = cfg.WS_COOKIE;
        console.log('[AUTH] Cookies 已更新，正在重启...');
        resolve();
      } else if (Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error('[AUTH] 等待超时（5分钟），请手动重跑脚本'));
      }
    }, 2000);
  });
  // Re-spawn with updated env so const bindings pick up new values
  const result = spawnSync(process.execPath, process.argv.slice(1), { stdio: 'inherit', env: process.env });
  process.exit(result.status ?? 0);
}

if (!DATA_COOKIE || (!DISCOVER && (!USCM_COOKIE || !USCM_CSRF))) {
  autoRefreshAndRestart().catch(e => { console.error(e.message); process.exit(1); });
}

// ─────────────────────────────────────────────────────────────────
// TEAM
// ─────────────────────────────────────────────────────────────────
const DATA_FLOOR = '2026-07-01';  // Business launch date — no data before this

const TEAM_ORDER = [
  'jacelynlim', 'terrychen', 'muhamadfaisal', 'calventan', 'azamuddin',
  'jeanliew', 'whitneylee', 'alvinsim', 'zaydentan', 'wilsonwong',
];
const CONVERSION_TEAM = new Set(TEAM_ORDER);

// Workspace (us-workspace.futuoa.com) staff uid → agent name
const WS_TEAM_MAP = {
  jacelynlim:    16510, terrychen:     14581, muhamadfaisal: 14810,
  calventan:     16136, azamuddin:     15515, jeanliew:      17203,
  whitneylee:    17204, alvinsim:      16424, zaydentan:     14675,
  wilsonwong:    14727,
};
const WS_TEAM_SIDS = new Set(Object.values(WS_TEAM_MAP));
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
  // All v params resolved dynamically via GET /api/card/{id}
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
  UTIL_OMNI_RATE:  'oe383d9a2c519465b8c5e379',

  // ── Phone (p387a9f31ddc842f89a058eb) ────────────────────────
  PH_DS_ID:        'i3c6fe114d95f4ccc880a844',
  PH_DATE:         'qfae26c41f2964547871e5ba',
  PH_DATE_SRC:     'ieacb98abc3fc4de8ae08f34',
  PH_AGENT:        'p7d3c93d1eb174d4f96bc76e',
  PH_TEAM:         'ceff618d9f16e48e3a44a1b7',  // 工单当前处理人飞书部门名字 (staff_department_name)
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

// ── QC Satisfaction (page n826723254b3b4ce18c58a15) ───────────────
const QC_SAT = {
  CDID_TEAM:  'o82a15ed4c8e94d6dac115d9',  // 自定义时间 (team by 券商)
  CDID_AGENT: 'h3643251e0f5f42f892c6e90',  // 自定义时间_分客服 (per-agent)
  DS_ID:      'f9b9dcb005fa346d3914d532',
  DATE_FDID:  'vf289aaac218f49b7b4fdb89',  // 日期
  METRIC: {
    fdId: 'xf10adad90f664127b632ad6', name: '满意度1', alias: '满意度',
    fdType: 'DOUBLE', metaType: 'METRIC', isAggregated: true, calculationType: 'aggregation',
    formula: 'COUNT(DISTINCT ([超赞和满意和一般工单])) / COUNT(DISTINCT ([评价工单号]))',
    key: 'taorUuhfqoBloSSjrpmdyAiy', level: 'dataset',
  },
  ROW_TEAM: {
    fdId: 'v31fa98af1fa44c928732368', name: '券商', fdType: 'STRING', metaType: 'DIM',
    isAggregated: false, calculationType: 'normal', key: 'CmlOOEbCSxwqupeUvcEylBzA', level: 'dataset',
  },
  ROW_AGENT: [
    { fdId: 'mdc52fde508ba48e69b0326f', name: '当前处理人组织架构', fdType: 'STRING', metaType: 'DIM',
      isAggregated: false, calculationType: 'normal', key: 'WmBGAyCugrRkjAdFSWGibUVC', level: 'dataset' },
    { fdId: 'e93526820dca944f6aa7af5e', name: '当前处理人英文名', fdType: 'STRING', metaType: 'DIM',
      isAggregated: false, calculationType: 'normal', key: 'ftbwxVSPahwBWovMvyGWoNqR', level: 'dataset' },
  ],
  COL: [{ name: '度量名', metaType: 'MPH', key: 'uQDyDbLBoUubSbymYRuMZjfj', nameTranslated: '度量名', alias: '度量名' }],
  CHANNEL_FILTER: {
    fdId: 'gfd03556d73ba4e24848a2cf', name: '来源渠道', fdType: 'STRING', metaType: 'DIM',
    isAggregated: false, calculationType: 'normal', baseFdType: 'STRING',
    filterType: 'IN', filterValue: ['在线', '电话', '邮件'],
    key: 'zaqepeMkAcLPKoOefCXcAavw', level: 'dataset',
  },
};

// ── QC Fault Counts (page a367cbbcbb28445a198c3518) ──────────────
const QC_FAULTS = {
  CDID:          'ndfe729d2affb4323a070459',
  DS_ID:         'ic06ff886844c4de6a191268',
  DATE_FDID:     'ef5d2727150b142299080061',
  AGENT_FDID:    'jee3d4bc275ed4a5cb8f7abc',
  AGENT_KEY:     'LyYTiKHlXjqFJHGogwBrEVMv',
  FATAL_FDID:    'm810be6ccbbbb486db0f2f99',
  FATAL_KEY:     'EKeLyOeZQfFZDQybevLNOTpP',
  NONFATAL_FDID: 'fa0669df08d964728b247041',
  NONFATAL_KEY:  'JDilqMDIQQMMYAXMbxJyvmlR',
};

// ── Consult PC (page a367cbbcbb28445a198c3518 / md4204d8939874f5b83b99d0) ──
const CONSULT_PC_CARD = {
  CDID:       'q675815b12e4246afa871c94',
  DS_ID:      'ic06ff886844c4de6a191268',
  DATE_FDID:  'ef5d2727150b142299080061',
  DATE_SRC:   'aabbf61e1b0d04975b0bee0a',
  REGION_FDID:'l08320afe361b46ed9294ac3', REGION_SRC: 'v2b5d7057116345b382d8227',
  ORG_FDID:   'f3920cbb150fc404ab03a427', ORG_SRC:    'cbaf52bc16be54f368b0e1d9',
  AGENT_FDID: 'k6e417652a5be4714ad8b8e7', AGENT_KEY:  'LyYTiKHlXjqFJHGogwBrEVMv',
  PC_FDID:    'u7dd6900b4faf4023831bcdb', PC_KEY:     'hHqhiTQbcPQTSNXPapyQxxMI',
  AE_FDID:    'c04a7710cb4594ff2b96b6a9', AE_KEY:     'dfxPaGekNijuqBRCWKwBbecS',
  TOT_FDID:   'l0166645dabc943d2a639077', TOT_KEY:    'CyGYIimnoTPQkZhGFjgnQxgp',
};

// ─────────────────────────────────────────────────────────────────
// DATE HELPERS
// ─────────────────────────────────────────────────────────────────
function fmtDate(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}

function toYYYYMMDD(dateStr) { return dateStr.replace(/-/g, ''); }

const _MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function weekLabel(s, e) {
  const [,sm,sd] = s.split('-').map(Number);
  const [,em,ed] = e.split('-').map(Number);
  return _MONTHS[sm-1]+' '+sd + '-' + (em!==sm?_MONTHS[em-1]+' ':'')+ed;
}

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
function prevDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
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

async function httpGetPlain(url) {
  const parsed = new URL(url);
  const res = await httpRequest({
    hostname: parsed.hostname,
    path: parsed.pathname + (parsed.search || ''),
    method: 'GET',
    headers: { 'User-Agent': 'US-CSS-Report-Bot/1.0', 'Accept': 'text/html' },
  });
  if (res.status !== 200) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.raw;
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

// ── Direct HTTPS request (uses saved DATA_COOKIE; works while cf_clearance is valid) ──
const DATA_PROXY_PORT = 8765;
let _directDisabled = false;

async function guandataDirectReq(urlPath, method, extraHeaders, body) {
  if (_directDisabled) throw new Error('direct disabled');
  const bodyBuf = body ? Buffer.from(body) : null;
  const hdrs = {
    'raw-backend-response': 'TRUE',
    'user-id': 'aXJpc2Rpbmc=', 'x-dom-id': 'Z3VhbmJp',
    'Cookie': DATA_COOKIE,
    ...extraHeaders,
  };
  if (bodyBuf) hdrs['Content-Length'] = String(bodyBuf.length);
  const res = await httpRequest({ hostname: 'us.data.futuoa.com', path: urlPath, method, headers: hdrs }, bodyBuf);
  if (res.status === 401 || res.status === 403 || res.status === 503 || (typeof res.body === 'string' && res.body.includes('challenge')) || res.body?.error?.status === 1017) {
    _directDisabled = true;
    throw new Error(`Direct blocked: HTTP ${res.status} — proxy required`);
  }
  return res;
}

// Proxy request to setup_cookies.py localhost:8765 — uses browser session to bypass 1018
function proxyRequest(urlPath, method, extraHeaders, body, retries = 4) {
  const headers = {
    'raw-backend-response': 'TRUE',
    'user-id': 'aXJpc2Rpbmc=', 'x-dom-id': 'Z3VhbmJp',
    ...extraHeaders,
  };
  if (body) headers['Content-Length'] = String(Buffer.byteLength(body));
  const attempt = (n) => new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port: DATA_PROXY_PORT, path: urlPath, method, headers },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString();
          try { resolve({ status: res.statusCode, body: JSON.parse(raw), raw }); }
          catch { resolve({ status: res.statusCode, body: raw, raw }); }
        });
      }
    );
    req.on('error', e => {
      if (n > 0) setTimeout(() => attempt(n - 1).then(resolve, reject), 300 * (retries - n + 1));
      else reject(e);
    });
    if (body) req.write(body);
    req.end();
  });
  return attempt(retries);
}

async function guandataReq(urlPath, method, extraHeaders, body) {
  try {
    return await guandataDirectReq(urlPath, method, extraHeaders, body);
  } catch (e) {
    if (!e.message.includes('direct disabled') && !e.message.includes('Direct blocked')) {
      _directDisabled = true;
      console.warn(`[WARN] Direct request failed (${e.message.slice(0,60)}), falling back to proxy`);
    }
    return proxyRequest(urlPath, method, extraHeaders, body);
  }
}

async function guandataGet(urlPath) {
  const res = await guandataReq(urlPath, 'GET', {}, null);
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
  const res = await guandataReq(
    `/api/card/${cardId}/data?v=${v}`, 'POST',
    { 'Content-Type': 'application/json' },
    bodyStr
  );
  if (res.status !== 200) throw new Error(`Card ${cardId}: HTTP ${res.status} — ${res.raw.slice(0,200)}`);
  const rows = res.body?.response?.chartMain?.data || [];
  if (!rows.length) console.warn(`[WARN] Card ${cardId} v=${v} returned empty data`);
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
  { fdId: F.UTIL_OMNI_RATE, name: '全渠道工时利用率', fdType: 'DOUBLE', metaType: 'METRIC',
    isAggregated: true, calculationType: 'aggregation',
    formula: 'if(sum([全渠道签入时长])=0,0,1-SUM([全渠道不接待时长])/sum([全渠道签入时长]))',
    key: 'qgiywcBTMRYILIWvAoOCxLqf' },
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
// Team-member filter for email sat card (ET timezone dataset — includes non-team agents otherwise)
function esaTeamFilter() {
  return {
    name: 'staff_nick', fdId: F.ESA_AGENT, key: 'utlHrocEyaXplhewOQjPIXzi',
    fdType: 'STRING', filterType: 'IN', filterValue: [...CONVERSION_TEAM],
    dsId: F.ESA_DS_ID, cdId: CARDS.EMAIL_SAT, level: 'dataset',
  };
}

// ── SLA ───────────────────────────────────────────────────────────
const SLA_COL = [{ name: '度量名', metaType: 'MPH', key: 'FnxPGCkCZRyXHnArJZKFOXqm' }];
const SLA_METRICS = [
  { fdId: F.SLA_RATE, name: 'SLA总体达标率', fdType: 'DOUBLE', metaType: 'METRIC',
    formula: '[总体达标工单数]/[总工单数]', isAggregated: true,
    calculationType: 'aggregation', key: 'FsbIuFAhnTmpURgSYvbTzPJz' },
];
// ─────────────────────────────────────────────────────────────────
// DATA FETCHERS
// ─────────────────────────────────────────────────────────────────

// ── Live Chat ─────────────────────────────────────────────────────
async function fetchLiveChatQueue(start, end) {
  const agentFilter = {
    name: '接待客服名字-英', fdId: F.LC_AGENT, key: F.LC_AGENT, fdType: 'STRING',
    filterType: 'IN', filterValue: [...CONVERSION_TEAM],
    dsId: F.LC_DS_ID, cdId: CARDS.LC_QUEUE,
  };
  const topFilters = [
    mkDateFilter(F.LC_DATE, start, end, F.LC_DS_ID, CARDS.LC_QUEUE, F.LC_DATE_SRC),
    agentFilter,
  ];

  const [teamResp, agentResp] = await Promise.all([
    guandataPost(CARDS.LC_QUEUE, buildBody([], LC_METRICS, topFilters, [], 500, '在线咨询数据')),
    guandataPost(CARDS.LC_QUEUE, buildBody([LC_AGENT_DIM], LC_METRICS, topFilters, [], 500, '在线咨询数据')),
  ]);

  const teamVals = teamValues(teamResp);
  const [tickets, avgHandle, satisfaction, waitLt10, wait1030, fcr] = teamVals;
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
      rawOmni: vals[1] != null ? parseFloat(vals[1]) : null,
    }))
    .filter(a => CONVERSION_TEAM.has(a.name));

  const validRates = rawAgents.filter(a => a.rawUtil != null).map(a => a.rawUtil);
  const teamUtilRate = validRates.length ? validRates.reduce((s, v) => s + v, 0) / validRates.length : null;
  const validOmni = rawAgents.filter(a => a.rawOmni != null).map(a => a.rawOmni);
  const teamOmniRate = validOmni.length ? validOmni.reduce((s, v) => s + v, 0) / validOmni.length : null;

  return {
    team: { utilRate: pct(teamUtilRate), omniUtil: pct(teamOmniRate) },
    agents: rawAgents.map(a => ({ name: a.name, utilRate: pct(a.rawUtil), omniUtil: pct(a.rawOmni) })),
  };
}

// ── Phone ─────────────────────────────────────────────────────────
async function fetchPhone(start, end) {
  const filters = [
    mkDateFilter(F.PH_DATE, start, end, F.PH_DS_ID, CARDS.PHONE, F.PH_DATE_SRC),
    { name: 'dept', fdId: F.PH_TEAM, key: F.PH_TEAM, fdType: 'STRING',
      filterType: 'IN', filterValue: ['US Conversion CS Team'],
      dsId: F.PH_DS_ID, cdId: CARDS.PHONE },
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

const PU_DS_ID = 'q5cbae6492b1c4aa483fe773';

async function fetchPhoneUtil(start, end) {
  try {
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
    // Use IN filter for all 7 days of the week — BT filter returns stale data, IN works correctly
    // Dept filter restricts to US Conversion CS Team so only team members appear
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(start + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + i);
      days.push(d.toISOString().slice(0, 10));
    }
    const PU_DEPT_ID = 'u645bb8720c51454294a1e9c';
    const filters = [
      { name: 'date', fdId: F.PU_DATE, key: 'xSEmvURRZAlqRZGvRZKHQptk',
        fdType: 'STRING', filterType: 'IN', originFilterType: 'IN',
        filterValue: days, displayValue: days,
        dsId: PU_DS_ID, cdId: PHONE_UTIL_CARD },
      { name: 'dept', fdId: PU_DEPT_ID, key: 'qeqVFXrwgFWnzKDGJTGVVeXg',
        fdType: 'STRING', filterType: 'IN', originFilterType: 'IN',
        filterValue: ['US Conversion CS Team'], displayValue: ['US Conversion CS Team'],
        dsId: PU_DS_ID, cdId: PHONE_UTIL_CARD },
    ];
    const resp = await guandataPost(PHONE_UTIL_CARD,
      buildBody([agentDim], allMetrics, filters, [], 200, '', puColumn));
    // Phone util card is a PIVOT_TABLE with 7 dim levels; agent name is at rowVals[i][6], not [0]
    const puData    = resp?.response?.chartMain?.data    || [];
    const puRowVals = resp?.response?.chartMain?.row?.values || [];
    const allRows = puData.map((row, i) => ({
      name: puRowVals[i]?.[6]?.title ?? puRowVals[i]?.[6]?.dvt ?? '',
      vals: row.map(c => c?.v ?? null),
    }));
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
  const dateFilter = {
    name: 'statis_date', fdId: F.ESA_DATE, key: 'OTQPRuVPUnEKcjOCXZIsZlNZ',
    fdType: 'STRING', filterType: 'BT', originFilterType: 'BT',
    filterValue: [start, end], displayValue: [start, end],
    dsId: F.ESA_DS_ID, cdId: CARDS.EMAIL_SAT, sourceCdId: F.ESA_DATE_SRC,
  };
  const teamFilters  = [dateFilter, esaTeamFilter()];
  const agentFilters = [dateFilter, esaTeamFilter()];
  const [teamResp, agentResp] = await Promise.all([
    guandataPost(CARDS.EMAIL_SAT, buildBody([], ESA_METRICS, teamFilters, [], 200, '报表', ESA_COL)),
    guandataPost(CARDS.EMAIL_SAT, buildBody([ESA_AGENT_DIM], ESA_METRICS, agentFilters, [], 200, '报表', ESA_COL)),
  ]);
  const tv = teamValues(teamResp);
  return {
    team: { satisfaction: pct(tv[0]), avgRespTime: mins(tv[1]), reply30min: pct(tv[2]) },
    agents: agentRows(agentResp)
      .filter(({ name }) => CONVERSION_TEAM.has(name))
      .map(({ name, vals }) => ({
        name,
        satisfaction: (vals[0] == null || vals[0] === 0) ? '-' : pct(vals[0]),
        avgRespTime: mins(vals[1]), reply30min: pct(vals[2]), negCount: toInt(vals[3]),
      })),
  };
}

async function fetchSLA(start, end) {
  const dateFilter = {
    name: '工单创建日期', fdId: F.SLA_DATE, dsId: F.SLA_DS_ID, cdId: CARDS.SLA,
    fdType: 'STRING', filterType: 'BT', originFilterType: 'BT',
    sourceCdId: F.SLA_DATE_SRC, filterValue: [start, end], displayValue: [start, end],
  };
  const agentFilter = {
    name: '客服姓名', fdId: F.SLA_AGENT_NAME, key: F.SLA_AGENT_NAME, fdType: 'STRING',
    filterType: 'IN', filterValue: [...CONVERSION_TEAM],
    dsId: F.SLA_DS_ID, cdId: CARDS.SLA, level: 'dataset', filterLevel: 'DETAIL',
  };
  const SLA_AGENT_DIM = {
    fdId: F.SLA_AGENT_NAME, name: '客服姓名', fdType: 'STRING', metaType: 'DIM',
    isAggregated: false, calculationType: 'normal', key: 'slaAgentKey001', level: 'dataset',
  };
  const [teamResp, agentResp] = await Promise.all([
    guandataPost(CARDS.SLA, buildBody([], SLA_METRICS, [dateFilter, agentFilter], [], 200, 'SLA Report', SLA_COL)),
    guandataPost(CARDS.SLA, buildBody([SLA_AGENT_DIM], SLA_METRICS, [dateFilter, agentFilter], [], 200, 'SLA Report', SLA_COL)),
  ]);
  const tv = teamValues(teamResp);
  return {
    overallSLA: pct(tv[0]),
    agents: agentRows(agentResp).map(({ name, vals }) => ({ name, slaRate: pct(vals[0]) })),
  };
}

// ── Outbound ──────────────────────────────────────────────────────
async function fetchOutbound(start, end) {
  // Calendar day window for follow/eff data: ob-start ~ ob-end (default: week start ~ week end)
  const obStartDate = obStartArg || start;
  const obEndDate   = obEndArg   || end;

  const startD0     = toYYYYMMDD(start);
  const endD0       = toYYYYMMDD(end);
  const obStartD0   = toYYYYMMDD(obStartDate);
  const obEndD0     = toYYYYMMDD(obEndDate);
  const effectivePcStart = obStartArg || (start < DATA_FLOOR ? DATA_FLOOR : start);
  const pcStart = toYYYYMMDD(effectivePcStart);
  const mStart  = obStartArg ? toYYYYMMDD(obStartArg) : toYYYYMMDD(monthStart(end));

  const [leadsResp, weekTeamResp, weekStaffResp, monthTeamResp, monthStaffResp, monthLeadsResp] = await Promise.all([
    // marketing-work: Calendar Day Follow-up and Conversion — call_num=TOCC, effective_follow_user_count=TEFV
    uscmGet('/api/visitor/overseas-statistics/marketing-work', { start_date: obStartD0, end_date: obEndD0 }),
    uscmGet('/api/am/us/overseas-performance/total-stats', { start_date: pcStart, end_date: endD0, area: 'US' }),
    uscmGet('/api/am/us/overseas-performance/staff-stats',  { start_date: pcStart, end_date: endD0, area: 'US', role: '1' }),
    mStart !== pcStart
      ? uscmGet('/api/am/us/overseas-performance/total-stats', { start_date: mStart, end_date: endD0, area: 'US' })
      : null,
    mStart !== pcStart
      ? uscmGet('/api/am/us/overseas-performance/staff-stats',  { start_date: mStart, end_date: endD0, area: 'US', role: '1' })
      : null,
    // Monthly effective follow-up count (for 月度有效転化率)
    mStart !== obStartD0
      ? uscmGet('/api/visitor/overseas-statistics/marketing-work', { start_date: mStart, end_date: obEndD0 })
      : null,
  ]);

  // Parse marketing-work — each agent has N sub-rows (by tag) + 1 aggregate row (max call_num)
  // Aggregate row: call_num == sum of all sub-rows (i.e. the row with the highest call_num per agent)
  const mwList = leadsResp?.data?.list || [];
  const mwByStaff = new Map(); // staff_name → { rows: [...] }
  for (const row of mwList) {
    if (!CONVERSION_TEAM.has(row.staff_name)) continue;
    if (!mwByStaff.has(row.staff_name)) mwByStaff.set(row.staff_name, []);
    mwByStaff.get(row.staff_name).push(row);
  }

  const staffIdMap = new Map();
  const byStaff   = new Map();
  for (const [staffName, rows] of mwByStaff) {
    // Aggregate row = the row with the highest call_num (equals sum of sub-rows)
    const aggRow = rows.reduce((best, r) => (r.call_num > best.call_num ? r : best), rows[0]);
    byStaff.set(staffName, {
      name:           aggRow.display_name || staffName,
      leadsAssigned:  aggRow.distribute_num                || 0,
      followCount:    aggRow.call_num                      || 0,
      effectiveFollow:aggRow.effective_follow_user_count   || 0,
      weeklyPC: 0, monthlyPC: 0, lcPC: 0, phonePC: 0, emailPC: 0,
    });
    if (aggRow.staff_id) staffIdMap.set(aggRow.staff_id, { staff_name: staffName, display_name: aggRow.display_name || staffName });
  }


  // Weekly PC per staff — sum all days
  let _staffKeysLogged = false;
  for (const row of (weekStaffResp?.data?.list || [])) {
    if (!row.staff_id) continue;
    if (!_staffKeysLogged) { console.log('[DEBUG] staff-stats fields:', Object.keys(row).join(', ')); _staffKeysLogged = true; }
    const info = staffIdMap.get(row.staff_id);
    if (!info || !CONVERSION_TEAM.has(info.staff_name)) continue;
    if (!byStaff.has(info.staff_name)) {
      byStaff.set(info.staff_name, { name: info.display_name, leadsAssigned: 0, followCount: 0, effectiveFollow: 0, weeklyPC: 0, monthlyPC: 0, lcPC: 0, phonePC: 0, emailPC: 0 });
    }
    const s2 = byStaff.get(info.staff_name);
    s2.weeklyPC += row.total_pc    || 0;
    s2.lcPC     += row.online_pc   || row.chat_pc  || 0;
    s2.phonePC  += row.phone_pc    || row.call_pc  || 0;
    s2.emailPC  += row.email_pc    || row.mail_pc  || 0;
  }

  // Monthly PC per staff — sum all days
  const monthStaffList = (monthStaffResp ?? weekStaffResp)?.data?.list || [];
  for (const row of monthStaffList) {
    if (!row.staff_id) continue;
    const info = staffIdMap.get(row.staff_id);
    if (!info || !CONVERSION_TEAM.has(info.staff_name)) continue;
    if (!byStaff.has(info.staff_name)) {
      byStaff.set(info.staff_name, { name: info.display_name, leadsAssigned: 0, followCount: 0, effectiveFollow: 0, weeklyPC: 0, monthlyPC: 0, monthlyConsultPC: 0, lcPC: 0, phonePC: 0, emailPC: 0 });
    }
    const s3 = byStaff.get(info.staff_name);
    s3.monthlyPC        += row.total_pc || 0;
    s3.monthlyConsultPC += (row.online_pc || row.chat_pc  || 0)
                        +  (row.phone_pc  || row.call_pc  || 0)
                        +  (row.email_pc  || row.mail_pc  || 0);
  }

  // Monthly effective follow-up — from monthly marketing-work call (for 月度有効転化率)
  const monthlyEffFollowMap = new Map();
  const mwMonthList = monthLeadsResp?.data?.list || leadsResp?.data?.list || [];
  const mwMonthByStaff = new Map();
  for (const row of mwMonthList) {
    if (!CONVERSION_TEAM.has(row.staff_name)) continue;
    if (!mwMonthByStaff.has(row.staff_name) || row.call_num > mwMonthByStaff.get(row.staff_name).call_num) {
      mwMonthByStaff.set(row.staff_name, row);
    }
  }
  const monthlyLeadsMap = new Map();
  for (const [name, row] of mwMonthByStaff) {
    monthlyEffFollowMap.set(name, row.effective_follow_user_count || 0);
    monthlyLeadsMap.set(name, row.distribute_num || 0);
  }

  const agents = TEAM_ORDER
    .filter(n => byStaff.has(n))
    .map(n => {
      const s = byStaff.get(n);
      const mEffFol = monthlyEffFollowMap.get(n) || 0;
      const mLeads  = monthlyLeadsMap.get(n) || 0;
      const mPC = s.monthlyPC || 0;
      const monthlyEffConvRate  = mEffFol > 0 ? +(mPC / mEffFol  * 100).toFixed(1) : null;
      const monthlyDistConvRate = mLeads  > 0 ? +(mPC / mLeads   * 100).toFixed(1) : null;
      return {
        name:              n,
        leadsAssigned:     num(s.leadsAssigned),
        followCount:       num(s.followCount),
        effectiveFollow:   num(s.effectiveFollow),
        weeklyPC:          num(s.weeklyPC),
        monthlyPC:         num(s.monthlyPC),
        monthlyConsultPC:  s.monthlyConsultPC || 0,
        monthlyLeads:      mLeads,
        monthlyEffFollow:  mEffFol,
        monthlyEffConvRate,
        monthlyDistConvRate,
        lcPC:              s.lcPC,
        phonePC:           s.phonePC,
        emailPC:           s.emailPC,
      };
    });

  // Team PC = sum of conversion team members only (not all US staff)
  const weeklyPC  = agents.reduce((sum, a) => sum + (parseInt(a.weeklyPC)  || 0), 0);
  const monthlyPC = agents.reduce((sum, a) => sum + (parseInt(a.monthlyPC) || 0), 0);
  const lcPC      = agents.reduce((sum, a) => sum + (a.lcPC    || 0), 0);
  const phonePC   = agents.reduce((sum, a) => sum + (a.phonePC || 0), 0);
  const emailPC   = agents.reduce((sum, a) => sum + (a.emailPC || 0), 0);
  const consultPC = lcPC + phonePC + emailPC;

  return {
    team: { weeklyPC: num(weeklyPC), monthlyPC: num(monthlyPC), lcPC, phonePC, emailPC, consultPC },
    agents,
  };
}

// ── Channel PC (PC detail table: page pbb45c349b2854bad9223591) ───
async function fetchChannelPCDetail(start, end) {
  const CD_ID      = 'oa724299e80dd4e4daaa9301';
  const DS_ID      = 'm79e24ac5abd4430c877951f';
  const FD_DATE    = 'o5e36173392fd43d6aca7093';
  const FD_TEAM    = 's7c6806ceb8bd49dcbef01cd';
  const FD_METHOD  = 'iff133cf998bb479b8072be5';
  const FD_AGENT   = 'f3c5178b2a7e04aa1b6f34e7';
  const FD_UID     = 'h3c24e5d780bb42c5ae75835';
  const FD_REGION  = 'ud94da47e746c4b5e9a9f8f6';
  const FD_FLWTIME = 's84c14b87bfbb47e5b005627';
  const SRC_DATE   = 'v2baa810cccf044059933f95';
  const SRC_TEAM   = 's1f1f3f494f0c44e78b2e30e';

  // Use "end 23:59:59" (inclusive) — "start of next day" over-counts by including midnight records
  const startDT = `${start} 00:00:00`;
  const endDT   = `${end} 23:59:59`;

  // 6 row dims (地区/UID/转化时间/处理人/有效跟进方式/最近跟进时间) so each row = 1 unique PC record
  const body = {
    offset: 0, limit: 500,
    filters: [
      { name: '转化时间，北京时间，精确到秒', fdId: FD_DATE, dsId: DS_ID, cdId: CD_ID,
        fdType: 'TIMESTAMP', filterType: 'BT', originFilterType: 'BT', sourceCdId: SRC_DATE,
        filterValue: [startDT, endDT], displayValue: [startDT, endDT] },
      { name: '员工最小组织', fdId: FD_TEAM, dsId: DS_ID, cdId: CD_ID,
        fdType: 'STRING', filterType: 'IN', originFilterType: 'IN', sourceCdId: SRC_TEAM,
        filterValue: ['美国转化客服组'], displayValue: [] },
    ],
    treeFilters: [], dynamicParams: [], dynamicFieldFilters: [],
    combinationFilters: [], layerTreeFilters: [],
    headerSortings: null, rowExpand: null, sorting: [],
    name: '报表',
    zoneFilter: {
      zoneData: {
        row: [
          { fdId: FD_REGION,  name: '地区',                       alias: '地区',         fdType: 'STRING',    metaType: 'DIM', isAggregated: false, calculationType: 'normal', baseFdType: 'STRING',    key: 'TfjUzBaVqoOqNRmPnisQVjSd', level: 'dataset', dsId: DS_ID },
          { fdId: FD_UID,     name: '牛牛号，确定性密文 UID',       alias: 'UID',          fdType: 'STRING',    metaType: 'DIM', isAggregated: false, calculationType: 'normal', baseFdType: 'STRING',    key: 'rEwTHKxCsuJWxItJRyiHUZos', level: 'dataset', dsId: DS_ID },
          { fdId: FD_DATE,    name: '转化时间，北京时间，精确到秒', alias: '转化时间',      fdType: 'TIMESTAMP', metaType: 'DIM', isAggregated: false, calculationType: 'normal', baseFdType: 'TIMESTAMP', key: 'sNsDeOIDBWcUIbizMULuciGY', level: 'dataset', dsId: DS_ID },
          { fdId: FD_AGENT,   name: '处理人显示名：英文名（中文）', alias: '处理人',        fdType: 'STRING',    metaType: 'DIM', isAggregated: false, calculationType: 'normal', baseFdType: 'STRING',    key: 'lUFwQwbfvkGVfBaOMSXDhFIC', level: 'dataset', dsId: DS_ID },
          { fdId: FD_METHOD,  name: '最终有效跟进方式',             alias: '有效跟进方式',  fdType: 'STRING',    metaType: 'DIM', isAggregated: false, calculationType: 'normal', baseFdType: 'STRING',    key: 'RRFQkjdopRPRadAspydnPbPf', level: 'dataset', dsId: DS_ID },
          { fdId: FD_FLWTIME, name: '最近一次有效跟进时间，北京时间，精确到秒', alias: '最近一次有效跟进时间', fdType: 'TIMESTAMP', metaType: 'DIM', isAggregated: false, calculationType: 'normal', baseFdType: 'TIMESTAMP', key: 'kEQcJBVUhpxIdKSrFfksmaFw', level: 'dataset', dsId: DS_ID },
        ],
        column: [], metric: [],
        sorting: [{ fdId: FD_DATE, name: '转化时间，北京时间，精确到秒', alias: '转化时间，北京时间，精确到秒',
          fdType: 'TIMESTAMP', metaType: 'DIM', aggrType: 'NUL', calculationType: 'normal',
          baseFdType: 'TIMESTAMP', key: 'LZtjYtHVKNVBiWTWdxiJEegb', ordering: 'desc',
          nameTranslated: '转化时间，北京时间，精确到秒' }],
      }
    },
    taskRequestId: randId(),
  };

  try {
    const v   = await resolveVParam(CD_ID);
    const res = await guandataReq(`/api/card/${CD_ID}/data?v=${v}`, 'POST',
      { 'Content-Type': 'application/json' }, JSON.stringify(body));
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const resp = res.body;

    // Each row = 1 PC record; method is at index 4, agent at index 3
    const rowVals = resp?.response?.chartMain?.row?.values || [];

    if (!rowVals.length) {
      console.warn('[WARN] channelPCDetail: empty — response keys:', Object.keys(resp?.response || {}).join(', '));
      return { lc: '-', phone: '-', email: '-', byAgent: {} };
    }

    const methodCounts = {};
    const agentCounts  = {};
    for (const labels of rowVals) {
      const method   = (labels[4]?.title ?? labels[4]?.v ?? '').trim();
      const agentRaw = (labels[3]?.title ?? labels[3]?.v ?? '').trim();
      const agentM   = agentRaw.match(/^([^(（]+)/);
      const agent    = agentM ? agentM[1].trim().toLowerCase() : agentRaw.toLowerCase();
      if (method) methodCounts[method] = (methodCounts[method] || 0) + 1;
      if (agent && method) {
        if (!agentCounts[agent]) agentCounts[agent] = {};
        agentCounts[agent][method] = (agentCounts[agent][method] || 0) + 1;
      }
    }
    console.log('[OK] channelPCDetail methods:', JSON.stringify(methodCounts));

    const norm = s => (s || '').toLowerCase();
    let lc = 0, phone = 0, email = 0, ob = 0;
    for (const [method, cnt] of Object.entries(methodCounts)) {
      const m = norm(method);
      if      (m.includes('在线') || m.includes('chat'))  lc    += cnt;
      else if (m.includes('电话') || m.includes('phone')) phone += cnt;
      else if (m.includes('邮件') || m.includes('mail'))  email += cnt;
      else if (m === '外呼' || m === 'sms')               ob    += cnt;
    }
    return { lc, phone, email, ob, byAgent: agentCounts, raw: methodCounts };
  } catch (e) {
    console.warn('[WARN] fetchChannelPCDetail:', e.message);
    return { lc: '-', phone: '-', email: '-', ob: 0, byAgent: {} };
  }
}

// ── TOP 10 Business Categories ────────────────────────────────────
async function fetchLcTopCategories(start, end) {
  try {
    const catDim = mkDim('e142a1c0e20e84d7fa17ab01', '业务分二级');
    const ticketMetric = { fdId: F.LC_TICKETS, name: '工单数', fdType: 'DOUBLE', metaType: 'METRIC',
      isAggregated: true, calculationType: 'aggregation', key: 'lcCat001', level: 'dataset',
      formula: 'count(distinct [工单号])' };
    const filters = [
      mkDateFilter(F.LC_DATE, start, end, F.LC_DS_ID, CARDS.LC_QUEUE, F.LC_DATE_SRC),
      { name: 'agent', fdId: F.LC_AGENT, key: F.LC_AGENT, fdType: 'STRING',
        filterType: 'IN', filterValue: [...CONVERSION_TEAM], dsId: F.LC_DS_ID, cdId: CARDS.LC_QUEUE },
    ];
    const resp = await guandataPost(CARDS.LC_QUEUE, buildBody([catDim], [ticketMetric], filters, [], 500, 'LC Top Cat'));
    return agentRows(resp)
      .filter(r => r.name && r.name !== '-' && (r.vals[0] || 0) > 0)
      .sort((a, b) => (b.vals[0] || 0) - (a.vals[0] || 0))
      .slice(0, 10)
      .map(r => ({ name: r.name, count: toInt(r.vals[0]) }));
  } catch (e) { console.warn('[WARN] LC top categories:', e.message); return []; }
}

async function fetchPhoneTopCategories(start, end) {
  try {
    const catDim = mkDim('va5d86efacfb443adbd3794e', '二级业务分类');
    const ticketMetric = { fdId: 'd0a5a44ec09c64ede83a9cae', name: '工单数', fdType: 'DOUBLE', metaType: 'METRIC',
      isAggregated: true, calculationType: 'aggregation', key: 'phCat001', level: 'dataset' };
    const filters = [
      mkDateFilter(F.PH_DATE, start, end, F.PH_DS_ID, CARDS.PHONE, F.PH_DATE_SRC),
      { name: 'dept', fdId: F.PH_TEAM, key: F.PH_TEAM, fdType: 'STRING',
        filterType: 'IN', filterValue: ['US Conversion CS Team'], dsId: F.PH_DS_ID, cdId: CARDS.PHONE },
    ];
    const resp = await guandataPost(CARDS.PHONE, buildBody([catDim], [ticketMetric], filters, [], 500, 'Phone Top Cat'));
    return agentRows(resp)
      .filter(r => r.name && r.name !== '-' && (r.vals[0] || 0) > 0)
      .sort((a, b) => (b.vals[0] || 0) - (a.vals[0] || 0))
      .slice(0, 10)
      .map(r => ({ name: r.name, count: toInt(r.vals[0]) }));
  } catch (e) { console.warn('[WARN] Phone top categories:', e.message); return []; }
}

async function fetchEmailTopCategories(start, end) {
  try {
    const EM_CARD = 's9171c1087a664ae689047c4';
    const EM_DS   = 'ncd519d0a95e74646bf48e5f';
    const EM_DATE = 'a04853e434ab34d21970334a';
    const EM_CAT  = 'td846c97cd41441ef91dc758';
    const EM_MAIL = 'o579a0748b992414da789a38';
    const EM_TICK = 'fffd3c45db0fb4d859ec7c57';
    const catDim = mkDim(EM_CAT, '工单二级分类');
    const ticketMetric = { fdId: EM_TICK, name: '工单数', fdType: 'DOUBLE', metaType: 'METRIC',
      isAggregated: true, calculationType: 'aggregation', key: 'emCat001', level: 'dataset' };
    const filters = [
      { name: '工单创建-日', fdId: EM_DATE, key: EM_DATE, fdType: 'STRING',
        filterType: 'BT', filterValue: [start, end], displayValue: [start, end],
        dsId: EM_DS, cdId: EM_CARD },
      { name: 'account_mail', fdId: EM_MAIL, key: EM_MAIL, fdType: 'STRING',
        filterType: 'IN', filterValue: ['ca@us.moomoo.com', 'cs@us.moomoo.com', 'pcs@us.moomoo.com', 'support@moomoocrypto.com'],
        dsId: EM_DS, cdId: EM_CARD },
    ];
    const resp = await guandataPost(EM_CARD, buildBody([catDim], [ticketMetric], filters, [], 500, 'Email Top Cat'));
    return agentRows(resp)
      .filter(r => r.name && r.name !== '-' && (r.vals[0] || 0) > 0)
      .sort((a, b) => (b.vals[0] || 0) - (a.vals[0] || 0))
      .slice(0, 10)
      .map(r => ({ name: r.name, count: toInt(r.vals[0]) }));
  } catch (e) { console.warn('[WARN] Email top categories:', e.message); return []; }
}

async function fetchQcSat(start, end) {
  const makeBody = (row, cdId) => ({
    offset: 0, limit: 200,
    filters: [{
      name: '日期', fdId: QC_SAT.DATE_FDID, key: QC_SAT.DATE_FDID, fdType: 'STRING',
      filterType: 'BT', originFilterType: 'BT',
      filterValue: [start, end], displayValue: [start, end],
      dsId: QC_SAT.DS_ID, cdId, sourceCdId: cdId,
    }],
    zoneFilter: {
      zoneData: {
        row, column: QC_SAT.COL,
        metric: [QC_SAT.METRIC], sorting: [],
        filters: [QC_SAT.CHANNEL_FILTER],
      }
    },
    treeFilters: [], dynamicParams: [], dynamicFieldFilters: [],
    combinationFilters: [], layerTreeFilters: [],
    headerSortings: null, rowExpand: null, sorting: [],
    name: '', taskRequestId: randId(),
  });

  const [teamResp, agentResp] = await Promise.all([
    guandataPost(QC_SAT.CDID_TEAM,  makeBody([QC_SAT.ROW_TEAM],  QC_SAT.CDID_TEAM)),
    guandataPost(QC_SAT.CDID_AGENT, makeBody(QC_SAT.ROW_AGENT,   QC_SAT.CDID_AGENT)),
  ]);

  const teamData    = teamResp?.response?.chartMain?.data     || [];
  const teamRowVals = teamResp?.response?.chartMain?.row?.values || [];
  let teamSat = '-';
  teamData.forEach((row, i) => {
    const label = teamRowVals[i]?.[0]?.title ?? '';
    if (label.includes('US')) teamSat = pct(row[0]?.v);
  });

  const agentData    = agentResp?.response?.chartMain?.data     || [];
  const agentRowVals = agentResp?.response?.chartMain?.row?.values || [];
  const agents = agentData
    .map((row, i) => ({
      name: agentRowVals[i]?.[1]?.title ?? agentRowVals[i]?.[0]?.title ?? '',
      satisfaction: pct(row[0]?.v),
    }))
    .filter(a => CONVERSION_TEAM.has(a.name));

  return { team: { satisfaction: teamSat }, agents };
}

async function fetchQcFaults(start, end) {
  const cdId  = QC_FAULTS.CDID;
  const dsId  = QC_FAULTS.DS_ID;
  const body  = {
    offset: 0, limit: 200,
    filters: [{
      name: '日期', fdId: QC_FAULTS.DATE_FDID, key: QC_FAULTS.DATE_FDID, fdType: 'STRING',
      filterType: 'BT', originFilterType: 'BT',
      filterValue: [start, end], displayValue: [start, end],
      dsId, cdId, sourceCdId: cdId,
    }],
    zoneFilter: {
      zoneData: {
        row: [{
          fdId: QC_FAULTS.AGENT_FDID, name: '员工英文名',
          fdType: 'STRING', metaType: 'DIM', isAggregated: false, calculationType: 'normal',
          key: QC_FAULTS.AGENT_KEY, level: 'dataset', dsId,
        }],
        column: [{ name: '度量名', metaType: 'MPH', key: 'aWxMeJMiFiCjdaGrpBLNOyjG', nameTranslated: '度量名', alias: '度量名' }],
        metric: [
          { fdId: QC_FAULTS.FATAL_FDID,    name: '客服侧致命差错工单量',   fdType: 'LONG', metaType: 'METRIC',
            aggrType: 'SUM', isAggregated: false, calculationType: 'normal',
            key: QC_FAULTS.FATAL_KEY,    level: 'dataset', dsId },
          { fdId: QC_FAULTS.NONFATAL_FDID, name: '客服侧非致命差错工单量', fdType: 'LONG', metaType: 'METRIC',
            aggrType: 'SUM', isAggregated: false, calculationType: 'normal',
            key: QC_FAULTS.NONFATAL_KEY, level: 'dataset', dsId },
        ],
        sorting: [], filters: [],
      }
    },
    treeFilters: [], dynamicParams: [], dynamicFieldFilters: [],
    combinationFilters: [], layerTreeFilters: [],
    headerSortings: null, rowExpand: null, sorting: [],
    name: '', taskRequestId: randId(),
  };

  try {
    const resp    = await guandataPost(cdId, body);
    const rowData = resp?.response?.chartMain?.data        || [];
    const rowVals = resp?.response?.chartMain?.row?.values || [];
    const agents  = rowData.map((row, i) => {
      const raw  = rowVals[i]?.[0]?.title ?? '';
      const m    = raw.match(/（([^）]+)）/);
      const name = (m ? m[1] : raw).toLowerCase();
      return { name, fatal: parseInt(row[0]?.v) || 0, nonfatal: parseInt(row[1]?.v) || 0 };
    }).filter(a => CONVERSION_TEAM.has(a.name));
    return { agents };
  } catch (e) {
    console.warn('[WARN] QC faults:', e.message);
    return { agents: [] };
  }
}

async function fetchConsultPC(weekStart, weekEnd, mFloor) {
  const C = CONSULT_PC_CARD;
  const POST_CDID = QC_FAULTS.CDID;  // supports all 3 PC metrics (CS, AE, TOT)
  const BASE_FILTERS = [
    { name: '地区', fdId: C.REGION_FDID, dsId: C.DS_ID, cdId: POST_CDID, fdType: 'STRING',
      filterType: 'IN', originFilterType: 'IN', sourceCdId: C.REGION_SRC,
      filterValue: ['US'], displayValue: ['US'] },
    { name: '员工最小组织', fdId: C.ORG_FDID, dsId: C.DS_ID, cdId: POST_CDID, fdType: 'STRING',
      filterType: 'IN', originFilterType: 'IN', sourceCdId: C.ORG_SRC,
      filterValue: ['美国转化客服组'], displayValue: [] },
  ];
  const ROW_DIM = {
    fdId: C.AGENT_FDID, name: '处理人显示名：英文名（中文）', alias: '客服',
    fdType: 'STRING', metaType: 'DIM', isAggregated: false, calculationType: 'normal',
    baseFdType: 'STRING', key: C.AGENT_KEY, level: 'dataset', dsId: C.DS_ID, zoneId: 'row',
  };
  const PC_METRIC = {
    fdId: C.PC_FDID, name: '客服侧PC', fdType: 'LONG',
    metaType: 'METRIC', aggrType: 'SUM', isAggregated: false, calculationType: 'normal',
    baseFdType: 'LONG', key: C.PC_KEY, level: 'dataset', dsId: C.DS_ID,
  };
  const AE_METRIC = {
    fdId: C.AE_FDID, name: '客经侧PC', fdType: 'LONG',
    metaType: 'METRIC', aggrType: 'SUM', isAggregated: false, calculationType: 'normal',
    baseFdType: 'LONG', key: C.AE_KEY, level: 'dataset', dsId: C.DS_ID,
  };
  const TOT_METRIC = {
    fdId: C.TOT_FDID, name: '总PC', fdType: 'LONG',
    metaType: 'METRIC', aggrType: 'SUM', isAggregated: false, calculationType: 'normal',
    baseFdType: 'LONG', key: C.TOT_KEY, level: 'dataset', dsId: C.DS_ID,
  };
  const PC_COL = [{ name: '度量名', metaType: 'MPH', key: 'hWfrOKnIhVfPaymcQDxqjYfA', nameTranslated: '度量名', alias: '度量名' }];

  function buildPcBody(filters) {
    return {
      offset: 0, limit: 200, filters,
      treeFilters: [], dynamicParams: [], dynamicFieldFilters: [],
      combinationFilters: [], layerTreeFilters: [],
      headerSortings: null, rowExpand: null, sorting: [],
      name: '报表',
      zoneFilter: { zoneData: { row: [ROW_DIM], column: PC_COL, metric: [PC_METRIC, AE_METRIC, TOT_METRIC], sorting: [] } },
      taskRequestId: randId(),
    };
  }

  function parsePC3(resp) {
    const result = { cs: {}, ae: {}, tot: {} };
    const data    = resp?.response?.chartMain?.data    || [];
    const rowVals = resp?.response?.chartMain?.row?.values || [];
    data.forEach((row, i) => {
      const title = rowVals[i]?.[0]?.title ?? '';
      const m = title.match(/（([^）]+)）$/);
      if (!m) return;
      const name = m[1].trim().toLowerCase();
      result.cs[name]  = parseInt(row[0]?.v) || 0;
      result.ae[name]  = parseInt(row[1]?.v) || 0;
      result.tot[name] = parseInt(row[2]?.v) || 0;
    });
    return result;
  }

  const monthLabel = (mFloor || weekEnd).slice(0, 7);
  const weekFilters  = [...BASE_FILTERS, {
    name: '日期', fdId: C.DATE_FDID, dsId: C.DS_ID, cdId: POST_CDID, fdType: 'STRING',
    filterType: 'BT', originFilterType: 'BT', sourceCdId: C.DATE_SRC,
    filterValue: [weekStart, weekEnd], displayValue: [weekStart, weekEnd],
  }];
  const mStartDate = monthStart(weekEnd);
  const monthFilters = [...BASE_FILTERS, {
    name: '日期', fdId: C.DATE_FDID, dsId: C.DS_ID, cdId: POST_CDID, fdType: 'STRING',
    filterType: 'BT', originFilterType: 'BT', sourceCdId: C.DATE_SRC,
    filterValue: [mStartDate, weekEnd], displayValue: [mStartDate, weekEnd],
  }];

  const [weekResp, monthResp] = await Promise.all([
    guandataPost(POST_CDID, buildPcBody(weekFilters)),
    guandataPost(POST_CDID, buildPcBody(monthFilters)),
  ]);
  const weekly  = parsePC3(weekResp);
  const monthly = parsePC3(monthResp);
  console.log(`[OK] Consult PC (weekly CS): ${JSON.stringify(weekly.cs)}`);
  console.log(`[OK] Consult PC (weekly AE): ${JSON.stringify(weekly.ae)}`);
  console.log(`[OK] Consult PC (monthly/${monthLabel} total): ${JSON.stringify(monthly.tot)}`);
  return { weekly: weekly.cs, weeklySales: weekly.ae, monthly: monthly.cs, monthlyTotal: monthly.tot };
}

async function fetchWsSat(dataStart, dataEnd) {
  if (!WS_COOKIE) {
    console.warn('[WARN] WS_COOKIE not set — skipping workspace CSAT');
    return { team: { satisfaction: '-', total: 0 }, agents: [] };
  }

  const begin  = toUnixBT(dataStart, 0);
  const endTs  = toUnixBT(dataEnd, 0) + 86400 - 1;
  const csrf   = (WS_COOKIE.match(/csrfToken=([^;]+)/) || [])[1] || '';

  let allItems = [];
  let page = 1;
  while (true) {
    const bodyStr = JSON.stringify({ broker: 2, evaluateTimeBegin: begin, evaluateTimeEnd: endTs, currentPage: page, perPage: 500 });
    const res = await httpRequest({
      hostname: 'us-workspace.futuoa.com',
      path: '/apis/srpc/cs_order_service/GetBadEvaluations',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf, 'Cookie': WS_COOKIE, 'Content-Length': Buffer.byteLength(bodyStr) },
    }, bodyStr);
    if (res.status !== 200 || res.body?.code !== 0) {
      console.warn(`[WARN] WS CSAT page ${page}: ${res.body?.message || `HTTP ${res.status}`}`);
      break;
    }
    const d = res.body.data;
    allItems = allItems.concat(d.badEvaluation || []);
    // API returns all d.total records on page 1 regardless of perPage/totalPage
    if (allItems.length >= (d.total || 0)) break;
    if (page >= (d.totalPage || 1)) break;
    page++;
  }

  // optionSatisfied: 0=Superb,1=Good,2=Average,3=Dissatisfied,4=Bad (all are rated)
  // channel: 1=LiveChat, 2=Phone, 7=Email
  const CAT_NAME = {
    1605:'平台基础体验',1607:'出金',1608:'入金',1609:'开户前咨询',1622:'其他',3189:'销户',3880:'开户后咨询',
    1606:'税务',1619:'社区',1621:'行情',
    1625:'通用设置',1627:'登录相关',1628:'短信验证码',1635:'其他',1636:'出金其他问题',1639:'WIRE出金操作',1640:'ACH出金进度/催出金',
    1645:'WIRE入金异常',1648:'ACH入金异常',1649:'ACH入金操作',1650:'美国身份开户咨询',1651:'台湾身份开户咨询',1652:'其他身份开户咨询',
    1657:'其他问题',1709:'期权',1727:'邀请活动',1745:'问题不明确',1732:'禁言申诉/举报',1742:'证券分析功能',1744:'非我可业务',
    4868:'充值/提取',
    3209:'注销证券账户（已开户）',3213:'放弃开户/注销moomooID（未开户）',3752:'绑卡相关',3881:'修改资料',
    3884:'w8/w9表格相关',4025:'重置审核',4829:'重复开户',4838:'旧设备验证',4842:'注销现金/融资账户',4848:'借记卡',
    3210:'不使用（薅完羊毛等）',3214:'不使用（薅完羊毛等）',4854:'修改电话号码/忘记密码',4856:'其他',
    1658:'开户驳回',1659:'开户前问题',1660:'开户填写',1663:'开户前问题',1667:'开户前问题',3876:'催开户',3878:'催开户',
  };
  const CAT_LEVEL = {
    1605:1,1607:1,1608:1,1609:1,1622:1,3189:1,3880:1,1606:1,1619:1,1621:1,
    1625:2,1627:2,1628:2,1635:2,1639:2,1640:2,1648:2,1649:2,1650:2,1651:2,1652:2,
    1657:2,1745:2,1732:2,1742:2,1744:2,3209:2,3213:2,3752:2,3881:2,3884:2,4025:2,4829:2,4838:2,4842:2,4848:2,
    3210:3,3214:3,4854:3,4856:3,1658:3,1659:3,1660:3,1663:3,1667:3,3876:3,3878:3,
  };

  const bySid = {};
  const negCatMap = {};
  for (const e of allItems) {
    if (!WS_TEAM_SIDS.has(e.sid)) continue;
    if (!bySid[e.sid]) bySid[e.sid] = { total: 0, lc: 0, phone: 0, email: 0, superb: 0, good: 0, avg: 0, dissatisfied: 0, bad: 0 };
    const s = bySid[e.sid];
    s.total++;
    if (e.channel === 1) s.lc++;
    else if (e.channel === 2) s.phone++;
    else if (e.channel === 7) s.email++;
    const o = e.optionSatisfied;
    if (o === 0) s.superb++;
    else if (o === 1) s.good++;
    else if (o === 2) s.avg++;
    else if (o === 3) s.dissatisfied++;
    else if (o === 4) s.bad++;
    if (o === 3 || o === 4) {
      for (const cid of (Array.isArray(e.categoryInfo) ? e.categoryInfo : [])) {
        if (CAT_LEVEL[cid] !== 2) continue;
        if (!negCatMap[cid]) negCatMap[cid] = { id: cid, name: CAT_NAME[cid] || String(cid), count: 0 };
        negCatMap[cid].count++;
      }
    }
  }

  let teamTotal = 0, teamLc = 0, teamPhone = 0, teamEmail = 0;
  let teamSuperb = 0, teamGood = 0, teamAvg = 0, teamDissatisfied = 0, teamBad = 0;
  for (const v of Object.values(bySid)) {
    teamTotal += v.total; teamLc += v.lc; teamPhone += v.phone; teamEmail += v.email;
    teamSuperb += v.superb; teamGood += v.good; teamAvg += v.avg;
    teamDissatisfied += v.dissatisfied; teamBad += v.bad;
  }
  const teamSat = teamTotal > 0 ? ((teamTotal - teamDissatisfied - teamBad) / teamTotal * 100).toFixed(1) + '%' : '-';

  const agents = TEAM_ORDER.map(name => {
    const v = bySid[WS_TEAM_MAP[name]] || { total: 0, lc: 0, phone: 0, email: 0, superb: 0, good: 0, avg: 0, dissatisfied: 0, bad: 0 };
    const sat = v.total > 0 ? ((v.total - v.dissatisfied - v.bad) / v.total * 100).toFixed(1) + '%' : '-';
    return { name, ...v, satisfaction: sat };
  });

  const negCategories = Object.values(negCatMap).sort((a, b) => b.count - a.count);
  console.log(`[OK] WS CSAT: ${allItems.length} evals (${teamTotal} team), team sat ${teamSat}, neg-cat2 types: ${negCategories.length}`);
  return {
    team: { satisfaction: teamSat, total: teamTotal, lc: teamLc, phone: teamPhone, email: teamEmail, superb: teamSuperb, good: teamGood, avg: teamAvg, dissatisfied: teamDissatisfied, bad: teamBad },
    agents,
    negCategories,
  };
}

async function fetchTeamVolSummary(start, end) {
  const lcFilters = [
    mkDateFilter(F.LC_DATE, start, end, F.LC_DS_ID, CARDS.LC_QUEUE, F.LC_DATE_SRC),
    { name:'接待客服名字-英', fdId:F.LC_AGENT, key:F.LC_AGENT, fdType:'STRING', filterType:'IN', filterValue:[...CONVERSION_TEAM], dsId:F.LC_DS_ID, cdId:CARDS.LC_QUEUE },
  ];
  const phFilters = [
    mkDateFilter(F.PH_DATE, start, end, F.PH_DS_ID, CARDS.PHONE, F.PH_DATE_SRC),
    { name:'dept', fdId:F.PH_TEAM, key:F.PH_TEAM, fdType:'STRING', filterType:'IN', filterValue:['US Conversion CS Team'], dsId:F.PH_DS_ID, cdId:CARDS.PHONE },
  ];
  const emFilters = [
    { name:'account_mail', fdId:F.EM_MAIL_FDID, key:F.EM_MAIL_FDID, fdType:'STRING', filterType:'IN', filterValue:['ca@us.moomoo.com','cs@us.moomoo.com','pcs@us.moomoo.com','support@moomoocrypto.com'], dsId:F.EM_DS_ID, cdId:CARDS.EMAIL, sourceCdId:F.EM_MAIL_SRC },
    { name:'consult_time_date', fdId:F.EM_DATE, key:F.EM_DATE_KEY, fdType:'STRING', filterType:'BT', filterValue:[start,end], displayValue:[start,end], dsId:F.EM_DS_ID, cdId:CARDS.EMAIL },
    { name:'reply_sid_nick', fdId:F.EM_AGENT, key:F.EM_AGENT, fdType:'STRING', filterType:'IN', filterValue:[...CONVERSION_TEAM], dsId:F.EM_DS_ID, cdId:CARDS.EMAIL },
  ];
  const [lcR, phR, emR] = await Promise.allSettled([
    guandataPost(CARDS.LC_QUEUE, buildBody([], LC_METRICS, lcFilters, [], 1, '工单量')),
    guandataPost(CARDS.PHONE, buildBody([], PH_METRICS, phFilters, [], 1, '工单量', PH_COL)),
    guandataPost(CARDS.EMAIL, buildBody([], EM_METRICS, emFilters, [], 1, '工单量', EM_COL)),
  ]);
  const lcTix = lcR.status === 'fulfilled' ? toInt(teamValues(lcR.value)[0]) : 0;
  const phTix = phR.status === 'fulfilled' ? toInt(teamValues(phR.value)[0]) : 0;
  const emTix = emR.status === 'fulfilled' ? toInt(teamValues(emR.value)[1]) : 0;
  return { vol: lcTix + phTix + emTix };
}

async function fetchOutboundFollowSummary(start, end) {
  try {
    const resp = await uscmGet('/api/visitor/overseas-statistics/marketing-work', {
      start_date: toYYYYMMDD(start), end_date: toYYYYMMDD(end)
    });
    const list = resp?.data?.list || [];
    const staffMax = {};
    for (const row of list) {
      if (!CONVERSION_TEAM.has(row.staff_name)) continue;
      staffMax[row.staff_name] = Math.max(staffMax[row.staff_name] || 0, row.call_num || 0);
    }
    return { followCount: Object.values(staffMax).reduce((s, v) => s + v, 0) };
  } catch (e) {
    console.warn('[WARN] fetchOutboundFollowSummary:', e.message);
    return { followCount: 0 };
  }
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
    const inner = typeof c !== 'string' ? `<strong>${esc(c)}</strong>`
      : c.startsWith('<strong>') ? c
      : c.includes('<') ? `<strong>${c}</strong>`
      : `<strong>${esc(c)}</strong>`;
    return `<td>${inner}</td>`;
  }).join('') + '</tr>';
}
function cvCell(val, dotHtml = '', sub = '') {
  const inlineSub = sub ? `<span class="tgt" style="margin-left:5px">${sub.replace(/<[^>]*>/g,'')}</span>` : '';
  if (!dotHtml) return `<strong>${esc(String(val))}</strong>${inlineSub}`;
  return `<span class="val-wrap"><strong>${esc(String(val))}</strong>${dotHtml}${inlineSub}</span>`;
}
function ansCell(label, val, dotHtml = '', target = '') {
  const base = dotHtml ? `<span class="val-wrap"><strong>${esc(String(val))}</strong>${dotHtml}</span>` : `<strong>${esc(String(val))}</strong>`;
  const sub = [label, target ? `≥${target}` : ''].filter(Boolean).join('');
  return sub ? `${base}<br><span class="lbl">${esc(sub)}</span>` : base;
}
function dot(pctStr, threshold) {
  if (!pctStr || pctStr === '-') return '';
  const v = parseFloat(pctStr);
  if (isNaN(v)) return '';
  return `<span class="dot ${v >= threshold ? 'dot-green' : 'dot-red'}"></span>`;
}
function dotRed(pctStr, threshold) {
  if (!pctStr || pctStr === '-') return '';
  const v = parseFloat(pctStr);
  if (isNaN(v) || v >= threshold) return '';
  return '<span class="dot dot-red" style="position:absolute;right:-12px;top:50%;transform:translateY(-50%)"></span>';
}
function withDot(val, dotHtml) {
  if (!dotHtml) return esc(String(val));
  return `<span style="position:relative;display:inline-block">${esc(String(val))}${dotHtml}</span>`;
}
function kpiCell(val, threshold) {
  if (!val || val === '-') return val || '-';
  const v = parseFloat(val);
  if (isNaN(v) || v === 0) return val;
  if (v >= threshold) return val;
  return { html: `<span style="color:#dc2626;font-weight:700">${esc(String(val))}</span>` };
}
function kpiCellMin(val, colMin, colMax) {
  if (!val || val === '-') return val || '-';
  const v = parseFloat(val);
  if (isNaN(v) || colMin === null) return val;
  if (v <= colMin && colMax != null && colMin < colMax)
    return { html: `<span style="color:#dc2626;font-weight:700">${esc(String(val))}</span>` };
  return val;
}
function kpiCellCsat(val, colMin, colMax, threshold = 84) {
  if (!val || val === '-') return val || '-';
  const v = parseFloat(val);
  if (isNaN(v)) return val;
  const isBottom = colMin !== null && colMax != null && colMin < colMax && v <= colMin;
  if (isBottom || v < threshold)
    return { html: `<span style="color:#dc2626;font-weight:700">${esc(String(val))}</span>` };
  return val;
}
function colBounds(items, getter) {
  const vals = items.map(getter).map(v => parseFloat(v)).filter(v => !isNaN(v) && v > 0);
  if (vals.length < 2) return null;
  const mn = Math.min(...vals), mx = Math.max(...vals);
  if (mn === mx) return null;
  return { min: mn, max: mx };
}
function rankTd(val, bounds) {
  if (!bounds || !val || val === '-') return val || '-';
  const v = parseFloat(val);
  if (isNaN(v)) return val;
  if (v <= bounds.min) return { html: `<span style="color:#dc2626;font-weight:700">${esc(String(val))}</span>` };
  if (v >= bounds.max) return { html: `<span style="color:#15803d;font-weight:700">${esc(String(val))}</span>` };
  return val;
}
function dotRedMin(pctStr, isMin) {
  if (!isMin || !pctStr || pctStr === '-') return '';
  return '<span class="dot dot-red" style="position:absolute;right:-12px;top:50%;transform:translateY(-50%)"></span>';
}
function b(zh, en) { return `${zh}<br><span class="en">${en}</span>`; }
function bCsat() { return `满意度<br><span class="en">CSAT <span style="font-size:10px;color:#bbb;font-weight:400">≥84%</span></span>`; }
function bFcr() { return `一次性解决率<br><span class="en">FCR <span style="font-size:10px;color:#bbb;font-weight:400">≥95%</span></span>`; }
function tbl(header, rows, emptyMsg = '暂无数据', colgroup = '', cls = '') {
  const body = rows.length ? rows.join('') : `<tr><td colspan="20" class="empty">${emptyMsg}</td></tr>`;
  const clsAttr = cls ? ` class="${cls}"` : '';
  return `<table${clsAttr}>${colgroup}<thead>${header}</thead><tbody>${body}</tbody></table>`;
}
function sect(id, titleZh, titleEn, content) {
  return `<div class="section" id="${id}"><h2><span class="sect-num">${id}</span>${titleZh} <span class="en">${titleEn}</span></h2>${content}</div>`;
}

function buildCsatSection(wsSat, lcSat, phoneSat, emailSat, histTrend) {
  const team = wsSat?.team || {};
  const agents = (wsSat?.agents || []).filter(a => a.total > 0);

  function trendBarChart(title, enTitle, items, colorFn) {
    const vals = items.map(i => (typeof i.v === 'number' ? i.v : parseFloat(i.v)) || 0);
    const maxVal = Math.max(...vals, 1);
    const bars = items.map((item, idx) => {
      const v = vals[idx];
      const barH = Math.max(4, Math.round((v / maxVal) * 52));
      const color = colorFn ? colorFn(v) : '#3b82f6';
      const numLabel = colorFn ? `${v.toFixed(1)}%` : (v > 0 ? String(Math.round(v)) : '-');
      return `<div style="display:flex;flex-direction:column;align-items:center;gap:2px;flex:1">`
        + `<div style="font-size:9px;color:#374151;font-weight:600">${numLabel}</div>`
        + `<div style="width:100%;height:${barH}px;background:${color};border-radius:2px 2px 0 0"></div>`
        + `<div style="font-size:8px;color:#6b7280;white-space:nowrap;text-align:center">${item.label}</div>`
        + `</div>`;
    }).join('');
    return `<div style="flex:1;min-width:140px">`
      + `<div style="font-size:11px;font-weight:600;color:#374151;margin-bottom:6px">${title} <span style="font-size:10px;color:#9ca3af;font-weight:400">${enTitle}</span></div>`
      + `<div style="display:flex;align-items:flex-end;gap:6px;height:60px">${bars}</div>`
      + `</div>`;
  }

  const csatColor = v => v >= 84 ? '#16a34a' : v >= 70 ? '#d97706' : '#dc2626';
  const trendHtml = '';

  if (!team.total) {
    return trendHtml + '<p class="meta" style="color:#94a3b8">无满意度数据（WS_COOKIE 未配置或本周无评价）</p>';
  }

  const colgroup = '<colgroup>'
    + '<col style="width:11%"><col style="width:7%">'
    + '<col style="width:7%"><col style="width:6%"><col style="width:7%">'
    + '<col style="width:8%"><col style="width:8%"><col style="width:8%"><col style="width:9%"><col style="width:8%">'
    + '<col style="width:10%"></colgroup>';

  const header = '<tr class="group-header">'
    + '<th rowspan="2" style="vertical-align:middle">客服<br><span class="en">Agent</span></th>'
    + '<th rowspan="2" style="vertical-align:middle;text-align:center">总评价<br><span class="en">Total</span></th>'
    + '<th colspan="3" class="zone-weekly" style="text-align:center">渠道评价数 <span class="en">By Channel</span></th>'
    + '<th colspan="5" class="zone-csat" style="text-align:center">评价分布 <span class="en">Rating Breakdown</span></th>'
    + '<th rowspan="2" style="vertical-align:middle">满意度<br><span class="en">CSAT</span></th></tr>'
    + '<tr>'
    + '<th class="zone-weekly" style="text-align:center">在线</th>'
    + '<th class="zone-weekly" style="text-align:center">电话</th>'
    + '<th class="zone-weekly" style="border-right:2px solid #bfdbfe;text-align:center">邮件</th>'
    + '<th class="zone-csat">超赞</th><th class="zone-csat">满意</th><th class="zone-csat">一般</th>'
    + '<th class="zone-csat">不满意</th><th class="zone-csat" style="border-right:2px solid #a5f3fc">糟糕</th>'
    + '</tr>';

  function csatCell(satStr) {
    if (satStr === '-') return '-';
    const v = parseFloat(satStr);
    return v < 84
      ? `<span style="color:#dc2626;font-weight:700">${satStr}</span>`
      : satStr;
  }

  function zeroOrDash(n) { return (n && n > 0) ? n : '-'; }

  const agentRows = agents.map(a =>
    `<tr><td>${esc(a.name)}</td><td>${a.total}</td>`
    + `<td>${zeroOrDash(a.lc)}</td><td>${zeroOrDash(a.phone)}</td><td>${zeroOrDash(a.email)}</td>`
    + `<td>${zeroOrDash(a.superb)}</td><td>${zeroOrDash(a.good)}</td><td>${zeroOrDash(a.avg)}</td>`
    + `<td>${zeroOrDash(a.dissatisfied)}</td><td>${zeroOrDash(a.bad)}</td>`
    + `<td>${csatCell(a.satisfaction)}</td></tr>`
  );

  const teamSatV = parseFloat(team.satisfaction);
  const teamSatCell = teamSatV >= 84
    ? `<strong>${team.satisfaction}</strong> <span class="tgt" style="margin-left:5px">≥84%</span>`
    : `<strong><span style="color:#dc2626;font-weight:700">${team.satisfaction}</span></strong> <span class="tgt" style="margin-left:5px">≥84%</span>`;
  const totalRow = `<tr class="consult-total-row">`
    + `<td><strong>合计 Total</strong></td><td><strong>${team.total}</strong></td>`
    + `<td><strong>${team.lc || 0}</strong></td><td><strong>${team.phone || 0}</strong></td><td><strong>${team.email || 0}</strong></td>`
    + `<td><strong>${team.superb || 0}</strong></td><td><strong>${team.good || 0}</strong></td><td><strong>${team.avg || 0}</strong></td>`
    + `<td><strong>${team.dissatisfied || 0}</strong></td><td><strong>${team.bad || 0}</strong></td>`
    + `<td>${teamSatCell}</td></tr>`;

  const tableHtml = `<table>${colgroup}<thead>${header}</thead><tbody>${agentRows.join('')}${totalRow}</tbody></table>`;

  // 亮点
  const superbPct = team.total > 0 ? (team.superb / team.total * 100).toFixed(1) : '0';
  const perfectAgents = agents.filter(a => a.satisfaction === '100.0%').map(a => a.name);

  // 改善方向 items (dynamic, up to 3)
  const nums = ['①', '②', '③'];
  const improvements = [];

  // Lowest channel CSAT from BI data (below 84%)
  const chans = [
    { name: '在线 Live Chat', sat: lcSat },
    { name: '电话 Phone', sat: phoneSat },
    { name: '邮件 Email', sat: emailSat },
  ].filter(c => c.sat && c.sat !== '-' && parseFloat(c.sat) < 84)
   .sort((a, b) => parseFloat(a.sat) - parseFloat(b.sat));
  if (chans.length > 0) {
    const w = chans[0];
    improvements.push({
      title: `${w.name} CSAT <span style="color:#dc2626">${w.sat}</span><br><span style="font-size:11px;font-weight:400;color:#93c5fd">目标 ≥84%</span>`,
      bullets: ['排查评价触达率，提升评价覆盖', '复盘负面工单，识别根因'],
    });
  }

  // Lowest individual CSAT agent (≥3 evals, below 84%)
  const lowAgents = agents
    .filter(a => a.total >= 3 && a.satisfaction !== '-' && parseFloat(a.satisfaction) < 84)
    .sort((a, b) => parseFloat(a.satisfaction) - parseFloat(b.satisfaction));
  if (lowAgents.length > 0) {
    const w = lowAgents[0];
    const neg = (w.dissatisfied || 0) + (w.bad || 0);
    improvements.push({
      title: `${esc(w.name)} 重点关注<br><span style="font-size:11px;font-weight:400;color:#93c5fd">${w.satisfaction}，负面评价 ${neg}/${w.total}</span>`,
      bullets: [`1v1 复盘 ${neg} 条负面工单，分析高频不满意场景`, '制定个人改善计划，下周跟进'],
    });
  }

  // Agents with CSAT ≤ 60%
  const veryLow = agents.filter(a => a.satisfaction !== '-' && parseFloat(a.satisfaction) <= 60).map(a => a.name);
  if (veryLow.length > 0) {
    improvements.push({
      title: `低分层（≤60%）<br><span style="font-size:11px;font-weight:400;color:#93c5fd">${veryLow.join(' / ')}</span>`,
      bullets: ['样本量小，优先提升评价量基础', '全员宣导主动引导客户评价的服务习惯'],
    });
  }

  const improvCols = improvements.slice(0, 3).map((item, i) =>
    `<div><div style="font-size:12.5px;font-weight:700;color:#1456F0;padding-bottom:6px;border-bottom:2px solid #bfdbfe;margin-bottom:8px">${nums[i]} ${item.title}</div>`
    + `<div style="font-size:12px;color:#444;line-height:1.8">`
    + item.bullets.map((bull, bi) => `<div style="padding-left:10px;position:relative${bi < item.bullets.length - 1 ? ';margin-bottom:3px' : ''}"><span style="position:absolute;left:0;color:#1456F0">›</span>${bull}</div>`).join('')
    + `</div></div>`
  );

  const improvHtml = improvements.length > 0
    ? `<div style="background:#eff6ff;border-left:4px solid #1456F0;border-radius:6px;padding:14px 18px">`
      + `<div style="font-size:11px;font-weight:700;color:#1456F0;letter-spacing:1px;margin-bottom:12px">改善方向</div>`
      + `<div style="display:grid;grid-template-columns:${improvements.slice(0, 3).map(() => '1fr').join(' ')};gap:20px">${improvCols.join('')}</div>`
      + `</div>`
    : `<div style="background:#f0fdf4;border-left:4px solid #22c55e;border-radius:6px;padding:12px 16px;font-size:13px;color:#15803d">本周团队满意度表现良好，无明显待改善项</div>`;

  const negTotal = (team.dissatisfied || 0) + (team.bad || 0);
  const teamSatV2 = parseFloat(team.satisfaction);
  const metTarget = !isNaN(teamSatV2) && teamSatV2 >= 84;
  const sortedBySat = [...agents].filter(a => a.satisfaction !== '-').sort((a, b) => parseFloat(b.satisfaction) - parseFloat(a.satisfaction));
  const topAgent = sortedBySat[0];
  const bot3 = [...sortedBySat].reverse().slice(0, 3);
  const statusText = metTarget
    ? `<span style="color:#16a34a;font-weight:700">符合目标 ≥84%</span>`
    : `<span style="color:#dc2626;font-weight:700">未达目标 ≥84%</span>`;
  const topText = topAgent ? `团队最高满意度：<strong>${esc(topAgent.name)}</strong>（${topAgent.satisfaction}）；` : '';
  const bot3Text = bot3.length > 0 ? `最低 ${bot3.length} 名：${bot3.map(a => `<strong>${esc(a.name)}</strong>（${a.satisfaction}）`).join('、')}` : '';
  const overviewHtml = `<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:10px 14px;margin-bottom:14px;font-size:12.5px;color:#444;line-height:1.9">`
    + `本周被评价工单 <strong>${team.total}</strong> 条，超赞 <strong>${team.superb || 0}</strong> 条（占比 ${superbPct}%），`
    + `不满意及糟糕工单 <strong>${negTotal}</strong> 条；团队满意度 <strong>${team.satisfaction}</strong>，${statusText}。`
    + (topText || bot3Text ? `<br>${topText}${bot3Text}。` : '')
    + `</div>`;

  const summary = `<h3 style="margin-top:18px">满意度小结</h3><div style="margin-top:10px">`
    + overviewHtml
    + `</div>`;

  const negCats = (wsSat?.negCategories || []).filter(c => c.count > 0);
  const negCatHtml = negCats.length > 0
    ? `<div class="subsect-title" style="margin-top:22px">不满意工单分类分布（二级）<span class="en"> Dissatisfied Ticket Category Breakdown (L2)</span></div>`
      + `<table style="width:auto;min-width:320px"><thead><tr>`
      + `<th style="text-align:left">分类</th><th style="text-align:center;min-width:60px">工单数</th><th style="text-align:center;min-width:60px">占比</th>`
      + `</tr></thead><tbody>`
      + (() => {
          const negTotal2 = negCats.reduce((s, x) => s + x.count, 0);
          return negCats.map(c => {
            const pct = negTotal2 > 0 ? (c.count / negTotal2 * 100).toFixed(1) : '0';
            return `<tr><td>${esc(c.name)}</td><td style="text-align:center">${c.count}</td><td style="text-align:center">${pct}%</td></tr>`;
          }).join('');
        })()
      + `</tbody></table>`
    : '';

  return trendHtml + summary;
}

function generateHTML(data, weekStart, weekEnd) {
  const { lc, util, phone, phoneUtil, email, emailSat, sla, outbound, qcSat, wsSat, monthlyLc, monthlyPhone, monthlyEmail, monthlyEmailSat, monthlyQcFaults, prev, lcTopCats, phoneTopCats, emailTopCats, autoConsultPC, channelPC, monthlyWsSat, histWsSat, histTrend } = data;

  // 外呼転化PC = 客経侧已転化PC from a367/ndfe card (authoritative source)
  // Sum of weeklySales per agent; fall back to pbb45c count only if ndfe returns nothing
  const _ndfeObTotal = Object.values(autoConsultPC?.weeklySales || {}).reduce((s, v) => s + v, 0);
  const obPcTeam = _ndfeObTotal > 0 ? _ndfeObTotal : (typeof channelPC.ob === 'number' ? channelPC.ob : 0);

  // WoW delta: green = better (higher), red = worse; neutral for tickets (gray)
  function wowDelta(curr, prevVal, higherIsBetter = true, isInt = false) {
    const c = parseFloat(curr), p = parseFloat(prevVal);
    if (isNaN(c) || isNaN(p)) return '';
    const d = c - p;
    if (Math.abs(d) < (isInt ? 0.5 : 0.05)) return '';
    const better = higherIsBetter ? d > 0 : d < 0;
    const color = better ? '#16a34a' : '#dc2626';
    const arrow = d > 0 ? '↑' : '↓';
    const fmt = isInt ? Math.abs(Math.round(d)).toString() : Math.abs(d).toFixed(1).replace(/\.0$/, '');
    return `<br><span style="font-size:10px;color:${color};font-weight:500">${arrow}${fmt} <span style="color:#9ca3af;font-weight:400">vs LW</span></span>`;
  }

  // Build lookup maps
  const utilMap    = {};  (util.agents    || []).forEach(a => { utilMap[a.name]    = a; });
  const lcMap      = {};  (lc.agents      || []).forEach(a => { lcMap[a.name]      = a; });
  const phoneMap   = {};  (phone.agents   || []).forEach(a => { phoneMap[a.name]   = a; });
  const puMap      = {};  (phoneUtil      || []).forEach(a => { puMap[a.name]      = a; });
  const emailMap   = {};  (email.agents   || []).forEach(a => { emailMap[a.name]   = a; });
  const emailSatMap= {};  (emailSat.agents|| []).forEach(a => { emailSatMap[a.name]= a; });
  const obMap      = {};  (outbound.agents|| []).forEach(a => { obMap[a.name]      = a; });
  const slaAgentMap= {};  (sla.agents     || []).forEach(a => { slaAgentMap[a.name]= a; });
  const qcSatMap   = {};  (qcSat?.agents  || []).forEach(a => { qcSatMap[a.name]   = a; });
  const wsSatMap   = {};  (wsSat?.agents  || []).forEach(a => { wsSatMap[a.name]   = a; });
  const mLcMap      = {};  (monthlyLc?.agents       || []).forEach(a => { mLcMap[a.name]       = a; });
  const mPhoneMap   = {};  (monthlyPhone?.agents    || []).forEach(a => { mPhoneMap[a.name]    = a; });
  const mEmailMap   = {};  (monthlyEmail?.agents    || []).forEach(a => { mEmailMap[a.name]    = a; });
  const mEmailSatMap  = {}; (monthlyEmailSat?.agents   || []).forEach(a => { mEmailSatMap[a.name]  = a; });
  const mWsSatMap   = {};  (monthlyWsSat?.agents    || []).forEach(a => { mWsSatMap[a.name]    = a; });
  const qcFaultsMap   = {}; (monthlyQcFaults?.agents   || []).forEach(a => { qcFaultsMap[a.name]   = a; });

  function computeMonthlyEval(satStr, negCount) {
    if (!satStr || satStr === '-') return { eval: 0, neg: 0 };
    const satDec = parseFloat(satStr) / 100;
    if (isNaN(satDec) || satDec <= 0) return { eval: 0, neg: 0 };
    if (negCount > 0 && satDec < 1) return { eval: Math.round(negCount / (1 - satDec)), neg: negCount };
    return { eval: 0, neg: 0 };
  }

  // ── Section I.A: Channel Team Summary ──────────────────────────
  const obTotalFollow    = outbound.agents.reduce((s,a) => s + (parseInt(a.followCount)    || 0), 0);
  const obTotalEffective = outbound.agents.reduce((s,a) => s + (parseInt(a.effectiveFollow) || 0), 0);
  const obEffectiveRate  = obTotalFollow > 0 ? (obTotalEffective / obTotalFollow * 100).toFixed(1) + '%' : '-';

  // Consult totals
  const consultTotalTickets = (toInt(lc.team.tickets) + toInt(phone.team.inbound) + toInt(email.team.replied));
  const consultLC    = toInt(lc.team.tickets);
  const consultPhone = toInt(phone.team.inbound);
  const consultEmail = toInt(email.team.replied);

  // Per-channel PC: CLI override > Guandata pbb45... table > USCM data > '-'
  const lcPC    = lcPCArg    != null ? parseInt(lcPCArg)    : (typeof channelPC.lc    === 'number' ? channelPC.lc    : (typeof outbound.team.lcPC    === 'number' ? outbound.team.lcPC    : '-'));
  const phonePC = phonePCArg != null ? parseInt(phonePCArg) : (typeof channelPC.phone === 'number' ? channelPC.phone : (typeof outbound.team.phonePC === 'number' ? outbound.team.phonePC : '-'));
  const emailPC = emailPCArg != null ? parseInt(emailPCArg) : (typeof channelPC.email === 'number' ? channelPC.email : (typeof outbound.team.emailPC === 'number' ? outbound.team.emailPC : '-'));
  const consultPC = (typeof lcPC === 'number' && typeof phonePC === 'number' && typeof emailPC === 'number')
    ? lcPC + phonePC + emailPC
    : agentConsultPCArg != null
      ? Object.values(agentConsultPCMap).reduce((s, v) => s + v, 0)
      : autoConsultPC?.weekly && Object.keys(autoConsultPC.weekly).length > 0
        ? Object.values(autoConsultPC.weekly).reduce((s, v) => s + v, 0)
        : '-';

  // 合计行满意度：来自 WS（跨渠道综合满意度）
  const consultCSAT = wsSat?.team?.satisfaction || '-';

  // ── 咨询业务 table (7 cols: 渠道, 工单量, PC, 接通率, 满意度, FCR, 平均处理时长) ──
  const consultColgroup = '<colgroup>'
    + '<col style="width:12%">'   // 渠道
    + '<col style="width:9%">'    // 工单量
    + '<col style="width:8%">'    // PC
    + '<col style="width:18%">'   // 接通率/SLA
    + '<col style="width:18%">'   // 满意度
    + '<col style="width:15%">'   // FCR
    + '<col style="width:20%">'   // 平均处理时长
    + '</colgroup>';

  const consultTable = tbl(
    th(b('渠道','Channel'), b('工单量','Volume'), b('咨询PC','Consult PC'), bCsat(), b('接通率','Answer Rate'), bFcr(), b('平均处理时长','Avg Handle')),
    [
      // 合计 row
      `<tr class="consult-total-row"><td><strong>合计 Total</strong></td><td><strong>${consultTotalTickets || '-'}</strong></td><td><strong>${consultPC}</strong></td><td>${cvCell(consultCSAT, dot(consultCSAT, 84))}</td><td>-</td><td>-</td><td>-</td></tr>`,
      trB('在线 Live Chat',
        consultLC + wowDelta(consultLC, prev?.lc?.tickets, true, true),
        lcPC,
        cvCell(lc.team.satisfaction, dot(lc.team.satisfaction, 84)),
        ansCell('30s接通', lc.team.thirtySecRate, dot(lc.team.thirtySecRate, 90), '90%'),
        cvCell(lc.team.fcr, dot(lc.team.fcr, 95)),
        lc.team.avgHandle),
      trB('电话 Phone',
        consultPhone + wowDelta(consultPhone, prev?.phone?.tickets, true, true),
        phonePC,
        cvCell(phone.team.satisfaction, dot(phone.team.satisfaction, 84)),
        ansCell('20s接通', phone.team.ans20s, dot(phone.team.ans20s, 95), '95%'),
        cvCell(phone.team.fcr, dot(phone.team.fcr, 95)),
        phone.team.avgDuration),
      trB('邮件 Email',
        consultEmail + wowDelta(consultEmail, prev?.email?.tickets, true, true),
        emailPC,
        cvCell(emailSat.team.satisfaction, dot(emailSat.team.satisfaction, 84)),
        ansCell('Overall SLA', sla.overallSLA, dot(sla.overallSLA, 90), '90%'),
        '-',
        '-'),
    ],
    '暂无数据',
    consultColgroup,
    'team-summary'
  );

  // ── 转化业务 table (5 cols) ──
  const salesColgroup = '<colgroup>'
    + '<col style="width:18%">'   // 外呼跟进量
    + '<col style="width:20%">'   // 有效跟进量
    + '<col style="width:18%">'   // 有效跟进率
    + '<col style="width:22%">'   // Weekly PC
    + '<col style="width:22%">'   // Monthly PC
    + '</colgroup>';
  const obTeamWeeklyPC = obPcTeam > 0 ? obPcTeam : (outbound.team?.weeklyPC || '-');
  const salesTable = tbl(
    th(b('外呼跟进量','Outbound Contacts'), b('有效跟进量','Effective (≥40s)'), b('有效跟进率','Effective Rate'), b('周外呼转化PC','Weekly OB Conv. PC'), b('月总PC','Monthly Total PC')),
    [
      `<tr class="team-row"><td><strong>${obTotalFollow || '-'}</strong></td><td><strong>${obTotalEffective || '-'}</strong></td><td><strong>${obEffectiveRate}</strong></td><td><strong>${obTeamWeeklyPC}</strong></td><td><strong>${outbound.team.monthlyPC}</strong></td></tr>`,
    ],
    '暂无数据',
    salesColgroup,
    'team-summary'
  );

  const teamSummaryTable = `<div class="subsect-title">咨询业务 <span class="en">Consultation</span></div>${consultTable}<div class="subsect-title" style="margin-top:18px">转化业务 <span class="en">Conversion / Outbound</span></div>${salesTable}`;

  // ── Section I.B: Individual Summary ────────────────────────────
  // Pass 1: compute data objects (no HTML yet)
  const agentSummaryData = TEAM_ORDER.map(name => {
    const lcData = lcMap[name]       || {};
    const phData = phoneMap[name]    || {};
    const ob     = obMap[name]       || {};
    const lcTix = toInt(lcData.tickets);
    const phTix = toInt(phData.inbound);
    const emTix = toInt((emailMap[name] || {}).tickets);
    const total  = lcTix + phTix + emTix;
    const agentCsat = (wsSatMap[name]||{}).satisfaction || (qcSatMap[name]||{}).satisfaction || '-';
    const agentConsultPCFromAPI = (ob.lcPC || 0) + (ob.phonePC || 0) + (ob.emailPC || 0);
    const agentConsultPCBi = autoConsultPC?.weekly?.[name] ?? agentConsultPCFromAPI;
    const agentConsultPC = agentConsultPCArg != null
      ? (agentConsultPCMap.hasOwnProperty(name) ? agentConsultPCMap[name] : 0)
      : agentConsultPCBi;
    const agentSalesPCBi   = autoConsultPC?.weeklySales?.[name] ?? null;
    const agentSalesPC     = agentSalesPCBi !== null
      ? agentSalesPCBi
      : ((ob.weeklyPC != null && ob.weeklyPC !== '-') ? ob.weeklyPC : 0);
    const agentWeeklyTotal = agentConsultPC + agentSalesPC;
    const agentMonthlyConsultBi = autoConsultPC?.monthly?.[name] ?? (ob.monthlyConsultPC || 0);
    const agentMonthlyConsult = agentMonthlyConsultPCArg != null
      ? (agentMonthlyConsultPCMap.hasOwnProperty(name) ? agentMonthlyConsultPCMap[name] : 0)
      : agentMonthlyConsultBi;
    const agentMonthlySales    = (ob.monthlyPC != null && ob.monthlyPC !== '-') ? ob.monthlyPC : 0;
    const agentMonthlyPCBi     = autoConsultPC?.monthlyTotal?.[name] ?? null;
    const agentMonthlyPC       = agentMonthlyPCBi !== null
      ? agentMonthlyPCBi
      : agentMonthlyConsult + agentMonthlySales;
    const monthlyLcTix    = toInt((mLcMap[name]||{}).tickets);
    const monthlyPhTix    = toInt((mPhoneMap[name]||{}).inbound);
    const monthlyEmTix    = toInt((mEmailMap[name]||{}).tickets);
    const agentMonthlyTickets = monthlyLcTix + monthlyPhTix + monthlyEmTix;
    const csatNum  = agentCsat !== '-' ? parseFloat(agentCsat) : null;
    const omniRaw  = (utilMap[name]||{}).omniUtil;
    const omniNum  = omniRaw && omniRaw !== '-' ? parseFloat(omniRaw) : null;
    const attendance = agentAttendanceArg != null
      ? (agentAttendanceMap.hasOwnProperty(name) ? agentAttendanceMap[name] : null)
      : null;
    const mWsEntry = mWsSatMap[name];
    const monthlyCsatRaw = mWsEntry?.satisfaction || '-';
    const monthlyCsatNum = monthlyCsatRaw !== '-' ? parseFloat(monthlyCsatRaw) : null;
    const monthlyFatal    = (qcFaultsMap[name] || {}).fatal    ?? 0;
    const monthlyNonfatal = (qcFaultsMap[name] || {}).nonfatal ?? 0;
    return { name, total, consultPC: agentConsultPC, salesPC: agentSalesPC, weeklyTotal: agentWeeklyTotal,
             monthlyTickets: agentMonthlyTickets, monthlyLcTix, monthlyPhTix, monthlyEmTix,
             monthlyConsult: agentMonthlyConsult, monthlySales: agentMonthlySales, monthlyPC: agentMonthlyPC,
             monthlyCsatRaw, monthlyCsatNum,
             monthlyFatal, monthlyNonfatal,
             csatNum, csatRaw: agentCsat, omniNum, omniRaw, attendance };
  }).sort((a, b) => b.total - a.total);

  // Pass 2: per-column rank (top=max → green, bot=min → red; ties all highlighted)
  function colRanks(arr, key) {
    const nums = arr.map((d, i) => ({ i, v: d[key] })).filter(x => x.v != null && typeof x.v === 'number' && !isNaN(x.v));
    if (nums.length < 2) return { tops: new Set(), bots: new Set() };
    const max = Math.max(...nums.map(x => x.v)), min = Math.min(...nums.map(x => x.v));
    if (min === max) return { tops: new Set(), bots: new Set() };
    return {
      tops: new Set(nums.filter(x => x.v === max).map(x => x.i)),
      bots: new Set(nums.filter(x => x.v === min).map(x => x.i)),
    };
  }
  const rk = {
    total:          colRanks(agentSummaryData, 'total'),
    consultPC:      colRanks(agentSummaryData, 'consultPC'),
    salesPC:        colRanks(agentSummaryData, 'salesPC'),
    weeklyTotal:    colRanks(agentSummaryData, 'weeklyTotal'),
    monthlyTickets: colRanks(agentSummaryData, 'monthlyTickets'),
    monthlyPC:      colRanks(agentSummaryData, 'monthlyPC'),
    monthlyCsat:    colRanks(agentSummaryData, 'monthlyCsatNum'),
    csat:           colRanks(agentSummaryData, 'csatNum'),
    omni:           colRanks(agentSummaryData, 'omniNum'),
  };
  function rc(i, key, extra = '') {
    const rank = rk[key].tops.has(i) ? 'rank-top' : rk[key].bots.has(i) ? 'rank-bot' : '';
    const cls  = [rank, extra].filter(Boolean).join(' ');
    return cls ? ` class="${cls}"` : '';
  }

  const hasAttendance = agentAttendanceArg != null;

  const agentSummaryRows = agentSummaryData.map((d, i) => {
    const omniHtml = d.omniRaw && d.omniRaw !== '-'
      ? (rk.omni.bots.has(i) ? `<span style="color:#dc2626;font-weight:700">${esc(d.omniRaw)}</span>`
         : rk.omni.tops.has(i) ? `<span style="color:#15803d;font-weight:700">${esc(d.omniRaw)}</span>`
         : esc(d.omniRaw))
      : '-';
    return '<tr>'
      + `<td>${esc(d.name)}</td>`
      + (hasAttendance ? `<td style="text-align:center">${d.attendance != null ? d.attendance : '-'}</td>` : '')
      + `<td${rc(i,'total')}>${esc(String(d.total || '-'))}</td>`
      + `<td data-col="consultpc"${rc(i,'consultPC')}>${esc(String(d.consultPC))}</td>`
      + `<td data-col="salespc"${rc(i,'salesPC')}>${esc(String(d.salesPC))}</td>`
      + `<td${rc(i,'weeklyTotal')}>${esc(String(d.weeklyTotal))}</td>`
      + `<td>${d.csatNum !== null && !isNaN(d.csatNum) && d.csatNum < 84 ? `<span style="color:#dc2626;font-weight:700">${esc(d.csatRaw)}</span>` : esc(d.csatRaw || '-')}</td>`
      + `<td${rc(i,'omni','zone-end')}>${omniHtml}</td>`
      + `<td${rc(i,'monthlyTickets')}>${esc(String(d.monthlyTickets || '-'))}</td>`
      + `<td${rc(i,'monthlyCsat')}>${d.monthlyCsatNum !== null && !isNaN(d.monthlyCsatNum) && d.monthlyCsatNum < 84 ? `<span style="color:#dc2626;font-weight:700">${esc(d.monthlyCsatRaw)}</span>` : esc(d.monthlyCsatRaw || '-')}</td>`
      + `<td style="text-align:center;color:${d.monthlyFatal > 0 ? '#dc2626' : 'inherit'};font-weight:${d.monthlyFatal > 0 ? '700' : '400'}">${d.monthlyFatal}</td>`
      + `<td style="text-align:center">${d.monthlyNonfatal}</td>`
      + `<td${rc(i,'monthlyPC')}>${esc(String(d.monthlyPC))}</td>`
      + (() => { const pct = d.monthlyPC > 0 ? Math.round(d.monthlyPC / monthlyPCKpi * 100) : null; return pct != null ? `<td style="font-weight:700;color:${pct >= 100 ? '#15803d' : '#dc2626'}">${pct}%</td>` : '<td>-</td>'; })()
      + '</tr>';
  });

  const wsTeamSat  = wsSat?.team?.satisfaction || '-';
  const qcTeamSat  = qcSat?.team?.satisfaction || '-';
  const teamSatDisplay = wsTeamSat !== '-' ? wsTeamSat : qcTeamSat;
  const fullHistTrend = [
    ...(histTrend || []),
    { label: weekLabel(weekStart, weekEnd), vol: consultTotalTickets, followCount: obTotalFollow, csat: wsTeamSat },
  ];
  const indGroupHeader = '<tr class="group-header">'
    + '<th rowspan="2" style="vertical-align:middle">客服<br><span class="en">Agent</span></th>'
    + `<th colspan="${hasAttendance ? 7 : 6}" class="zone-weekly">周度业绩 <span class="en">Weekly</span></th>`
    + '<th colspan="6" class="zone-monthly">月度业绩 <span class="en">Monthly</span></th>'
    + '</tr>';
  const indColHeader = '<tr>'
    + (hasAttendance ? `<th style="text-align:center">${b('出勤','Days')}</th>` : '')
    + `<th style="text-align:center">${b('工单量','Total Tickets')}</th>`
    + `<th data-col="consultpc">${b('咨询PC','Consult PC')}</th>`
    + `<th data-col="salespc">${b('转化PC','Conv. PC')}</th>`
    + `<th>${b('周度总PC','Weekly Total PC')}</th>`
    + `<th>${b('满意度','CSAT')}</th>`
    + `<th style="border-right:2px solid #c0cadf">${b('全渠道工时利用率','Omni Util')}</th>`
    + `<th>${b('月度总工单','Monthly Tickets')}</th>`
    + `<th>${b('月满意度','Monthly CSAT')}</th>`
    + `<th style="text-align:center">${b('月度致命差错','Monthly Fatal')}</th>`
    + `<th style="text-align:center">${b('月度非致命差错','Monthly Non-Fatal')}</th>`
    + `<th>${b('月度总PC','Monthly Total PC')}</th>`
    + `<th>${b('月度KPI达成','Monthly KPI%')}</th>`
    + '</tr>';
  const indTotalTickets    = agentSummaryData.reduce((s, d) => s + (parseInt(d.total)        || 0), 0);
  const indTotalConsultPC  = agentSummaryData.reduce((s, d) => s + (parseInt(d.consultPC)    || 0), 0);
  const indTotalSalesPC    = agentSummaryData.reduce((s, d) => s + (parseInt(d.salesPC)      || 0), 0);
  const indTotalWeeklyPC   = agentSummaryData.reduce((s, d) => s + (parseInt(d.weeklyTotal)  || 0), 0);
  const indTotalMonthlyLc  = agentSummaryData.reduce((s, d) => s + (d.monthlyLcTix || 0), 0);
  const indTotalMonthlyPh  = agentSummaryData.reduce((s, d) => s + (d.monthlyPhTix || 0), 0);
  const indTotalMonthlyEm  = agentSummaryData.reduce((s, d) => s + (d.monthlyEmTix || 0), 0);
  const indTotalMonthlyTix = agentSummaryData.reduce((s, d) => s + (parseInt(d.monthlyTickets)|| 0), 0);
  const indTotalMonthlyPC  = agentSummaryData.reduce((s, d) => s + (parseInt(d.monthlyPC)    || 0), 0);
  const teamCsatV2 = parseFloat(teamSatDisplay);
  const teamCsatHtml = teamSatDisplay !== '-' && !isNaN(teamCsatV2) && teamCsatV2 < 84
    ? `<span style="color:#dc2626;font-weight:700">${teamSatDisplay}</span>`
    : teamSatDisplay;
  const indTotalAttendance = hasAttendance
    ? agentSummaryData.reduce((s, d) => s + (d.attendance != null ? d.attendance : 0), 0)
    : null;
  const indTotalRow = '<tr class="consult-total-row">'
    + `<td><strong>合计 Total</strong></td>`
    + (hasAttendance ? `<td style="text-align:center"><strong>${indTotalAttendance}</strong></td>` : '')
    + `<td>${indTotalTickets || '-'}</td>`
    + `<td>${indTotalConsultPC || '-'}</td>`
    + `<td>${indTotalSalesPC || '-'}</td>`
    + `<td>${indTotalWeeklyPC || '-'}</td>`
    + `<td>${teamCsatHtml}</td>`
    + `<td style="border-right:2px solid #c0cadf">--</td>`
    + `<td>${indTotalMonthlyTix || '-'}</td>`
    + `<td>${monthlyWsSat?.team?.satisfaction || '-'}</td>`
    + (() => { const t = agentSummaryData.reduce((s, d) => s + d.monthlyFatal, 0); return `<td style="text-align:center;color:${t > 0 ? '#dc2626' : 'inherit'};font-weight:${t > 0 ? '700' : '400'}">${t}</td>`; })()
    + `<td style="text-align:center">${agentSummaryData.reduce((s, d) => s + d.monthlyNonfatal, 0)}</td>`
    + `<td>${indTotalMonthlyPC || '-'}</td>`
    + (() => { const pct = indTotalMonthlyPC > 0 ? Math.round(indTotalMonthlyPC / (TEAM_ORDER.length * monthlyPCKpi) * 100) : null; return pct != null ? `<td style="font-weight:700;color:${pct >= 100 ? '#15803d' : '#dc2626'}">${pct}%</td>` : '<td>-</td>'; })()
    + '</tr>';
  const individualSummaryTable = tbl(indGroupHeader + indColHeader, [...agentSummaryRows, indTotalRow], '暂无数据', '', 'ind-summary');

  const csatRankSection = '';

  // ── Section II.A: Live Chat Individual ─────────────────────────
  const _lcAgents = TEAM_ORDER.filter(name => lcMap[name]);
  const _lcAgentsData = _lcAgents.map(n => lcMap[n]);
  const _lc30sB = colBounds(_lcAgentsData, a => a.thirtySecRate);
  const _lcSatB  = colBounds(_lcAgentsData, a => a.satisfaction);
  const _lcFcrB  = colBounds(_lcAgentsData, a => a.fcr);
  const lcIndRows = _lcAgents
    .map(name => {
      const lca = lcMap[name] || {};
      return tr(name, lca.tickets || '-',
        rankTd(lca.thirtySecRate, _lc30sB),
        rankTd(lca.satisfaction, _lcSatB),
        rankTd(lca.fcr, _lcFcrB),
        lca.avgHandle || '-');
    });
  const lcIndTable = tbl(
    th(b('客服','Agent'), b('工单','Tickets'), b('30s接通','30s Rate'), b('满意度','CSAT'), b('一次性解决率','FCR'), b('平均处理时长','Avg Handle')),
    lcIndRows
  );

  // ── TOP 10 Business Categories ─────────────────────────────────
  function buildTopCatTable(cats) {
    if (!cats || cats.length === 0) return '<p class="meta" style="font-size:12px;color:#aaa;margin:8px 0">暂无数据 No data</p>';
    const total = cats.reduce((s, c) => s + c.count, 0);
    const rows = cats.map((c, i) =>
      `<tr><td style="color:#6b7280;font-size:11px;width:20px;text-align:center">${i + 1}</td><td style="text-align:left">${esc(c.name)}</td><td>${c.count}</td><td>${total > 0 ? (c.count / total * 100).toFixed(1) + '%' : '-'}</td></tr>`
    ).join('');
    return `<table><thead><tr><th style="width:20px;text-align:center">#</th><th style="text-align:left">分类 Category</th><th>工单数</th><th>占比</th></tr></thead><tbody>${rows}</tbody></table>`;
  }
  const topCatSection = (lcTopCats?.length || phoneTopCats?.length || emailTopCats?.length)
    ? `<h3 style="margin-top:18px">渠道业务分类 TOP 10 Business Category TOP 10</h3>
<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px;align-items:start;margin-top:10px">
  <div><div class="subsect-title">在线 Live Chat</div>${buildTopCatTable(lcTopCats)}</div>
  <div><div class="subsect-title">电话 Phone</div>${buildTopCatTable(phoneTopCats)}</div>
  <div><div class="subsect-title">邮件 Email</div>${buildTopCatTable(emailTopCats)}</div>
</div>`
    : '';

  // ── Section II.B: Phone Individual ─────────────────────────────
  const _phAgents = TEAM_ORDER.filter(name => phoneMap[name] && toInt(phoneMap[name].inbound) > 0);
  const _phAgentsData = _phAgents.map(n => phoneMap[n]);
  const _ph20sB = colBounds(_phAgentsData, a => a.ans20s);
  const _phSatB  = colBounds(_phAgentsData, a => a.satisfaction);
  const _phFcrB  = colBounds(_phAgentsData, a => a.fcr);
  const phIndRows = _phAgents
    .map(name => {
      const ph = phoneMap[name] || {};
      return tr(name, ph.inbound || '-',
        rankTd(ph.ans20s, _ph20sB),
        ph.avgDuration || '-',
        rankTd(ph.satisfaction, _phSatB),
        rankTd(ph.fcr, _phFcrB));
    });
  const phIndTable = tbl(
    th(b('客服','Agent'), b('呼入','Inbound'), b('20s接通','20s Rate'), b('通话时长','Call Dur.'), b('满意度','CSAT'), b('一次性解决率','FCR')),
    phIndRows
  );

  // ── Section II.C: Email Individual ─────────────────────────────
  const _emAgents = TEAM_ORDER.filter(name => emailMap[name]);
  const _emAgentsData = _emAgents.map(n => emailMap[n]);
  const _emSatAgentsData = _emAgents.map(n => emailSatMap[n] || {});
  const _emSlaB = colBounds(_emAgentsData, a => a.slaRate);
  const _emSatB  = colBounds(_emSatAgentsData, a => a.satisfaction);
  const emIndRows = _emAgents
    .map(name => {
      const em  = emailMap[name]    || {};
      const esa = emailSatMap[name] || {};
      return tr(name, em.tickets || '-',
        rankTd(em.slaRate, _emSlaB),
        rankTd(esa.satisfaction, _emSatB));
    });
  const emIndTable = tbl(
    th(b('客服','Agent'), b('工单','Tickets'), b('SLA达标','SLA Rate'), b('满意度','CSAT')),
    emIndRows
  );

  // ── Section II.D: Outbound Individual ──────────────────────────
  const obIndRows = TEAM_ORDER
    .filter(name => obMap[name] && name !== 'vincentyew')
    .map(name => {
      const ob = obMap[name] || {};
      const distR = ob.monthlyDistConvRate != null ? ob.monthlyDistConvRate + '%' : '-';
      const effR  = ob.monthlyEffConvRate  != null ? ob.monthlyEffConvRate  + '%' : '-';
      const salesPcBi = autoConsultPC?.weeklySales?.[name] ?? null;
      const salesPc   = salesPcBi !== null ? salesPcBi : ((ob.weeklyPC != null && ob.weeklyPC !== '-') ? ob.weeklyPC : 0);
      return { eff: toInt(ob.effectiveFollow), row: tr(name, ob.leadsAssigned || '-', ob.followCount || '-', ob.effectiveFollow || '-',
        salesPc,
        distR, effR) };
    })
    .sort((a, b) => b.eff - a.eff)
    .map(x => x.row);
  const obIndTable = tbl(
    th(b('客服','Agent'), b('分配Leads','Leads Assigned'), b('跟进量','Follow-up'), b('有效跟进','Eff. Follow'), b('周PC','Weekly PC'), b('分配转化率月','Dist. Conv%'), b('有效转化率月','Eff. Conv%')),
    obIndRows
  );

  // ── Monthly PC Breakdown table ──────────────────────────────────
  const monthlyPCSorted = [...agentSummaryData].sort((a, b) => b.monthlyPC - a.monthlyPC);
  const totalMTickets  = monthlyPCSorted.reduce((s, d) => s + d.monthlyTickets, 0);
  const totalMConsult  = monthlyPCSorted.reduce((s, d) => s + d.monthlyConsult, 0);
  const totalMSales    = monthlyPCSorted.reduce((s, d) => s + d.monthlySales, 0);
  const totalMPC       = monthlyPCSorted.reduce((s, d) => s + d.monthlyPC, 0);
  const monthlyPCRows  = monthlyPCSorted.map(d => tr(d.name, d.monthlyTickets || '-', d.monthlyConsult, d.monthlySales, d.monthlyPC));
  const monthlyPCTable = tbl(
    th(b('客服','Agent'), b('月工单量','Monthly Tickets'), b('月度咨询PC','Monthly Consult PC'), b('月度转化PC','Monthly Conv. PC'), b('月度总PC','Monthly Total PC')),
    [...monthlyPCRows, trB('合计 Total', totalMTickets || '-', totalMConsult, totalMSales, totalMPC)]
  );

  // ── Section II.E: Performance Analysis (no CSAT — covered in Section III) ──
  const analysisItems = [];
  const metricChecks = [
    { id: 'lc30s',      label: '在线 30s接通率 Live Chat 30s Rate',   val: lc.team.thirtySecRate,  target: 90 },
    { id: 'lcFcr',      label: '在线 FCR Live Chat FCR',              val: lc.team.fcr,            target: 95 },
    { id: 'phoneSla',   label: '电话 20s接通率 Phone 20s Rate',       val: phone.team.ans20s,      target: 95 },
    { id: 'phoneFcr',   label: '电话 FCR Phone FCR',                  val: phone.team.fcr,         target: 95 },
    { id: 'overallSla', label: '整体 SLA Overall SLA',                val: sla.overallSLA,         target: 90 },
  ];
  for (const { id, label, val, target } of metricChecks) {
    const n = parseFloat(val);
    if (!isNaN(n) && val !== '-' && n < target) {
      analysisItems.push({ id, label, val, target, type: n < target * 0.9 ? '异常' : '待提升' });
    }
  }
  // SLA 待提升卡片已永久移除（业绩分析不再提 SLA 异常）
  // Low omni utilization agents (< 70%)
  const lowUtilAgents = TEAM_ORDER.filter(name => {
    const d = agentSummaryData.find(x => x.name === name);
    const u = d ? parseFloat(d.omniRaw) : NaN;
    return !isNaN(u) && u < 70;
  }).map(name => {
    const d = agentSummaryData.find(x => x.name === name);
    return `${name}(${d.omniRaw})`;
  });
  if (lowUtilAgents.length > 0)
    analysisItems.push({ id: 'lowUtil', label: '工时利用率偏低 Omni Util below 70%', val: lowUtilAgents.join('、'), target: 70, type: '待提升' });

  // Highlights — efficiency & volume metrics only (no CSAT)
  const highlightItems = [];
  const highlightChecks = [
    { label: '在线 30s接通率 LC 30s Rate', val: lc.team.thirtySecRate,  target: 90 },
    { label: '在线 FCR LC FCR',            val: lc.team.fcr,            target: 95 },
    { label: '电话 20s接通率 Phone Rate',  val: phone.team.ans20s,      target: 95 },
    { label: '电话 FCR Phone FCR',         val: phone.team.fcr,         target: 95 },
    { label: '整体 SLA Overall SLA',       val: sla.overallSLA,         target: 90 },
  ];
  for (const { label, val, target } of highlightChecks) {
    const n = parseFloat(val);
    if (!isNaN(n) && val !== '-' && n >= target)
      highlightItems.push(`${label} <strong>${val}</strong>，达成目标 ≥${target}%`);
  }
  // Top PC agents this week
  const topPcAgents = [...agentSummaryData]
    .filter(d => parseInt(d.weeklyTotal) > 0)
    .sort((a, b) => (parseInt(b.weeklyTotal) || 0) - (parseInt(a.weeklyTotal) || 0))
    .slice(0, 3)
    .map(d => `${d.name}(<strong>${d.weeklyTotal}</strong>)`);
  if (topPcAgents.length > 0)
    highlightItems.push(`周 PC Top 3：${topPcAgents.join('、')}`);

  // Solution templates
  const SOLUTIONS = {
    lc30s:      ['排查高峰时段排班缺口，适时补充坐席', '复查接入技能组分配是否合理'],
    lcFcr:      ['梳理重复来电 Top 问题，补充标准话术', '识别转接率高的工单类型，减少不必要转接'],
    phoneSla:   ['分析漏接高峰时段，调整排班覆盖', '确认话机状态，排查坐席接通障碍'],
    phoneFcr:   ['提炼电话高频问题，强化一次性解决能力', '跟进需多步骤处理的案例，规范跟进流程'],
    overallSla: ['梳理超时工单分布，定位延误渠道', '建立优先级处理规范，缩短响应周期'],
    emailSla:   ['梳理个人超时工单，分析延误根因', '建立邮件优先级处理规范'],
    lowUtil:    ['核查坐席在线时长及空闲比例', '调整班次安排，提升工时有效覆盖'],
    zeroPc:     ['排查外呼记录，确认是否漏跟进', '针对高意向客户制定二次跟进计划'],
  };

  function issueCard(severity, titleHtml, solutions) {
    const colors = {
      high:   { bg: '#fef2f2', border: '#ef4444', tag: '#dc2626', tagBg: '#fee2e2', tagText: '重点关注' },
      medium: { bg: '#fffbeb', border: '#f59e0b', tag: '#b45309', tagBg: '#fef3c7', tagText: '待提升' },
    };
    const c = colors[severity] || colors.medium;
    const bullets = solutions.map(s =>
      `<div style="display:flex;align-items:flex-start;gap:6px;margin-bottom:3px">` +
      `<span style="color:#1456F0;font-size:12px;flex-shrink:0;margin-top:1px">→</span>` +
      `<span style="font-size:12px;color:#374151;line-height:1.5">${s}</span></div>`
    ).join('');
    return `<div style="background:${c.bg};border-left:3px solid ${c.border};border-radius:6px;padding:10px 14px;margin-bottom:10px">` +
      `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">` +
      `<span style="font-size:11px;font-weight:700;background:${c.tagBg};color:${c.tag};padding:1px 6px;border-radius:3px">${c.tagText}</span>` +
      `<span style="font-size:13px;font-weight:600;color:#1a1a2e">${titleHtml}</span></div>` +
      `<div style="margin-left:4px">${bullets}</div></div>`;
  }

  // 月度有效転化率 card — computed from outbound.agents.monthlyEffConvRate
  // Source: USCM marketing-work (monthly effective_follow_user_count) ÷ monthly total_pc
  const obRatesAll = (outbound.agents || [])
    .filter(a => a.name !== 'vincentyew' && a.monthlyEffConvRate !== null && a.monthlyEffConvRate !== undefined);
  if (obRatesAll.length >= 2) {
    const topA = obRatesAll.reduce((b, a) => a.monthlyEffConvRate > b.monthlyEffConvRate ? a : b);
    const botA = obRatesAll.reduce((b, a) => a.monthlyEffConvRate < b.monthlyEffConvRate ? a : b);
    if (topA.name !== botA.name) {
      const titleHtml = `月度有效转化率差距 Monthly Eff. Conv. Rate Gap ` +
        `<span style="color:#d97706;font-weight:700">${topA.name}(${topA.monthlyEffConvRate}%) vs ${botA.name}(${botA.monthlyEffConvRate}%)</span>`;
      issueCards_pre = issueCard('medium', titleHtml, [
        '复盘低转化率成员的有效跟进质量，对比高效成员跟进节点与话术',
        '推动低转化率成员参与 1-on-1 coaching，聚焦 objection handling',
      ]);
    }
  }

  // Build issue cards
  const issueCards_pre_html = typeof issueCards_pre !== 'undefined' ? issueCards_pre : '';
  const issueCards = [];
  for (const item of analysisItems) {
    const v = item.val, tgt = item.target;
    const severity = item.type === '异常' ? 'high' : 'medium';
    const gap = v && v !== '-' ? ` <span style="color:${severity==='high'?'#dc2626':'#d97706'};font-weight:700">${v}</span> <span style="font-size:11px;color:#9ca3af">目标≥${tgt}%</span>` : '';
    const titleHtml = `${item.label}${gap}`;

    const sols = SOLUTIONS[item.id] || ['排查根因，制定针对性改进措施'];

    issueCards.push(issueCard(severity, titleHtml, sols));
  }

  // Compact highlights line
  const highlightLine = highlightItems.length > 0
    ? `<div style="background:#f0fdf4;border-left:3px solid #22c55e;border-radius:6px;padding:8px 14px;margin-bottom:10px;font-size:12.5px;color:#15803d">` +
      `<strong>亮点</strong>　${highlightItems.join('　·　')}</div>`
    : '';

  const analysisHtml = (highlightItems.length === 0 && issueCards.length === 0 && !issueCards_pre_html)
    ? '<p style="color:#22c55e;font-size:13px;font-weight:500">本周各项指标均达标，团队表现良好。</p>'
    : highlightLine + issueCards_pre_html + issueCards.join('');

  // ── One-liner summary ─────────────────────────────────────────
  const _sat = (v) => { const n = parseFloat(v); return isNaN(n) ? null : n; };
  const _fmt = (label, val) => `${label}（${val}）`;
  const csatOk   = [], csatBad = [];
  if (_sat(lc.team.satisfaction)       != null) (_sat(lc.team.satisfaction)       >= 84 ? csatOk : csatBad).push(_fmt('在线', lc.team.satisfaction));
  if (_sat(phone.team.satisfaction)    != null) (_sat(phone.team.satisfaction)    >= 84 ? csatOk : csatBad).push(_fmt('电话', phone.team.satisfaction));
  if (_sat(emailSat.team.satisfaction) != null) (_sat(emailSat.team.satisfaction) >= 84 ? csatOk : csatBad).push(_fmt('邮件', emailSat.team.satisfaction));
  const wsSatVal = _sat(wsSat?.team?.satisfaction);
  const weeklyObPC = obPcTeam;
  const weeklyConsultPC = [lcPC, phonePC, emailPC].reduce((s, v) => s + (typeof v === 'number' ? v : 0), 0);
  const weeklyTotalPC = weeklyObPC + weeklyConsultPC;

  // Summary bar chips
  function chip(label, val, ok) {
    const c = ok === true ? '#16a34a' : ok === false ? '#dc2626' : '#1456F0';
    const bg = ok === true ? '#f0fdf4' : ok === false ? '#fef2f2' : '#f0f4ff';
    const bd = ok === true ? '#bbf7d0' : ok === false ? '#fecaca' : '#c7d6f7';
    return `<span style="font-size:12px;padding:3px 9px;border-radius:4px;border:1px solid ${bd};background:${bg};color:${c};white-space:nowrap"><strong>${label}</strong> ${val}</span>`;
  }
  const chips = [];
  chips.push(chip('周咨询PC', `${weeklyConsultPC} 单`, null));
  if (weeklyTotalPC > 0) chips.push(chip('周总PC', `${weeklyTotalPC} 单`, null));
  chips.push(chip('月度PC', `${indTotalMonthlyPC} 单`, null));
  if (wsSatVal != null) chips.push(chip('综合满意度', wsSat.team.satisfaction, wsSatVal >= 84));
  for (const x of csatOk)  chips.push(chip(x.split('（')[0] + ' CSAT', x.match(/（(.+)）/)?.[1] || x, true));
  for (const x of csatBad) chips.push(chip(x.split('（')[0] + ' CSAT', x.match(/（(.+)）/)?.[1] || x, false));
  const oneLinerSummary = chips.length > 0
    ? `<div style="display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:16px;padding:10px 14px;background:#f8faff;border:1.5px solid #c7d6f7;border-radius:6px"><span style="font-size:11px;font-weight:700;color:#6b7280;letter-spacing:.05em;margin-right:2px">本周概览</span>${chips.join('')}</div>`
    : '';

  // ── Full HTML ──────────────────────────────────────────────────
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>US CSS Weekly Report — ${weekStart} ~ ${weekEnd}</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, "Segoe UI", Arial, sans-serif; background: #f5f7fa; color: #1a1a2e; padding: 32px 28px; max-width: 1480px; margin: 0 auto; }
h1 { font-size: 24px; font-weight: 700; color: #1456F0; margin-bottom: 6px; border-bottom: 3px solid #1456F0; padding-bottom: 12px; text-align: center; letter-spacing: .3px; }
.subtitle { font-size: 13px; color: #666; margin-bottom: 28px; text-align: center; }
h2 { font-size: 15px; font-weight: 700; color: #fff; margin-bottom: 16px; padding: 10px 18px;
     background: linear-gradient(135deg, #1456F0, #3d7ff5); border-radius: 8px; display: flex; align-items: center; gap: 8px; }
.sect-num { background: rgba(255,255,255,.25); border-radius: 4px; padding: 2px 8px; font-size: 13px; }
h3 { font-size: 11.5px; font-weight: 700; color: #1456F0; margin: 18px 0 8px; text-transform: uppercase; letter-spacing: .8px; }
.section { background: #fff; border-radius: 12px; padding: 26px 28px; margin-bottom: 24px; box-shadow: 0 2px 8px rgba(0,0,0,.07); }
.cols2 { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
.cols-wide { display: grid; grid-template-columns: 1fr 1fr; gap: 28px; }
.cols-wide > div { min-width: 0; overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
th { background: #eef2ff; color: #1456F0; text-align: center; padding: 10px 10px; border-bottom: 2px solid #c0d0f0; white-space: nowrap; }
th:first-child { text-align: left; }
td { padding: 8px 10px; border-bottom: 1px solid #eef0f5; white-space: nowrap; text-align: center; vertical-align: middle; }
td:first-child { text-align: left; }
.team-summary { table-layout: fixed; }
.team-summary th { text-align: center; }
.team-summary th:first-child { text-align: left; }
.team-summary td { white-space: normal; overflow-wrap: break-word; vertical-align: middle; padding: 8px 10px; text-align: center; }
.team-summary td:first-child { text-align: left; }
.subsect-title { font-size: 13.5px; font-weight: 700; color: #1456F0; margin: 0 0 10px 0; padding: 5px 0 7px; border-bottom: 1px solid #d0daf8; letter-spacing: .2px; }
.bold-row td { font-weight: 700; background: #eef2ff; }
.consult-total-row td { font-weight: 700; background: #dce6ff; border-top: 2px solid #1456F0; border-bottom: 2px solid #1456F0; }
tr:hover td { background: #f8f9ff; }
.team-row td { font-weight: 600; background: #f0f4ff; padding: 5px 8px; line-height: 1.25; }
td.empty { color: #aaa; text-align: center; }
.en { font-size: 11px; color: #999; font-weight: 400; }
.lbl { font-size: 11px; color: #aaa; font-weight: 400; }
.editable-area { min-height: 130px; border: 1px solid #e0e4f0; border-radius: 8px; padding: 14px 18px;
                 font-size: 13px; color: #333; line-height: 1.8; outline: none;
                 background: #fafbff; }
.editable-area:focus { border-color: #1456F0; box-shadow: 0 0 0 2px rgba(20,86,240,.1); }
.editable-hint { font-size: 11px; color: #aaa; margin-bottom: 8px; }
.meta { font-size: 11px; color: #aaa; margin-top: 12px; text-align: center; }
.dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-left:4px; vertical-align:middle; }
.val-wrap { position:relative; display:inline-block; }
.val-wrap .dot { position:absolute; left:calc(100% + 3px); top:50%; transform:translateY(-50%); margin:0; }
.sub-lbl { display:block; font-size:10px; color:#bbb; font-weight:400; margin-top:2px; }
.dot-green { background:#22c55e; }
.dot-red { background:#ef4444; }
.cell-fail { color:#ef4444; }
.tgt { font-size:10px; color:#bbb; font-weight:400; margin-left:4px; }
.zone-weekly  { background:#dbeafe; color:#1456F0; border-right:2px solid #bfdbfe; }
.zone-monthly { background:#ede9fe; color:#6d28d9; border-right:2px solid #ddd6fe; }
.zone-csat    { background:#cffafe; color:#0e7490; border-right:2px solid #a5f3fc; }
.zone-util    { background:#d1fae5; color:#065f46; }
.group-header th { padding:6px 10px; font-size:12px; letter-spacing:.2px; }
td.zone-end   { border-right:2px solid #c0cadf; }
td.rank-top   { color:#15803d !important; font-weight:700; }
td.rank-bot   { color:#dc2626 !important; font-weight:700; }
.breakdown-grid table { font-size: 11px; }
.breakdown-grid th { padding: 6px 6px; font-size: 10.5px; }
.breakdown-grid td { padding: 5px 6px; }
@media (max-width: 800px) { .cols2, .cols-wide { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<h1>US CSS Weekly Report</h1>
<p class="subtitle">${obStartArg ? obStartArg.slice(5) + ' ~ ' + weekEnd.slice(5) : weekStart + ' ~ ' + weekEnd} &nbsp;|&nbsp; Conversion CS Team (${TEAM_ORDER.length} agents)</p>

${sect('一', '业绩情况', 'Performance Overview', `
  ${oneLinerSummary}
  <h3>Channel Team Summary</h3>
  ${teamSummaryTable}
  <h3 style="margin-top:18px">Individual Summary</h3>
  ${individualSummaryTable}
`)}

${sect('二', '个人业绩分析', 'Individual Breakdown', `
  <div class="breakdown-grid" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
    <div>
      <div style="display:inline-flex;align-items:center;gap:6px;background:#1456F0;color:#fff;border-radius:5px;padding:4px 11px;font-size:11.5px;font-weight:700;letter-spacing:.6px;margin-bottom:10px">在线 <span style="opacity:.8;font-weight:400">Live Chat</span></div>
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:8px 8px">${lcIndTable}</div>
    </div>
    <div>
      <div style="display:inline-flex;align-items:center;gap:6px;background:#0ea5e9;color:#fff;border-radius:5px;padding:4px 11px;font-size:11.5px;font-weight:700;letter-spacing:.6px;margin-bottom:10px">电话 <span style="opacity:.8;font-weight:400">Phone</span></div>
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:8px 8px">${phIndTable}</div>
    </div>
    <div>
      <div style="display:inline-flex;align-items:center;gap:6px;background:#8b5cf6;color:#fff;border-radius:5px;padding:4px 11px;font-size:11.5px;font-weight:700;letter-spacing:.6px;margin-bottom:10px">邮件 <span style="opacity:.8;font-weight:400">Email</span></div>
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:8px 8px">${emIndTable}</div>
    </div>
  </div>
  <div style="margin-top:20px">
    <div style="display:inline-flex;align-items:center;gap:6px;background:#f59e0b;color:#fff;border-radius:5px;padding:4px 11px;font-size:11.5px;font-weight:700;letter-spacing:.6px;margin-bottom:6px">外呼 <span style="opacity:.8;font-weight:400">Outbound</span></div>
    <p class="meta" style="margin:2px 0 8px">Calendar day: ${obStartArg || weekStart} ~ ${obEndArg || weekEnd} BT</p>
    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px;overflow-x:auto">${obIndTable}</div>
  </div>
  <div style="margin-top:20px">
    <div class="subsect-title">业绩分析 <span class="en">Performance Analysis</span></div>
    <div style="margin-top:8px">${analysisHtml}</div>
  </div>
`)}

${sect('三', '满意度分析', 'Satisfaction Analysis', `
  ${buildCsatSection(wsSat, lc.team.satisfaction, phone.team.satisfaction, emailSat.team.satisfaction, fullHistTrend)}
  ${csatRankSection}
  ${topCatSection}
`)}

${sect('四', '本周重点工作', 'Key Work This Week', `
  <div class="editable-hint">点击编辑 / Click to edit</div>
  <div class="editable-area" contenteditable="true">请填写本周重点工作...</div>
`)}

${sect('五', '下周计划', 'Next Week Plans', `
  <div class="editable-hint">点击编辑 / Click to edit</div>
  <div class="editable-area" contenteditable="true">请填写下周安排...</div>
`)}

<p class="meta">Generated: ${new Date().toISOString()} &nbsp;|&nbsp; Week: ${weekStart} ~ ${weekEnd}</p>
<script>
function togGroup(id,btn){
  var g=document.getElementById(id);if(!g)return;
  var hide=g.style.display!=='none';
  g.style.display=hide?'none':'';
  btn.style.opacity=hide?'0.3':'1';
}
function togFill(chartId,color,btn){
  var chart=document.getElementById(chartId);if(!chart)return;
  var els=Array.from(chart.querySelectorAll('[fill="'+color+'"]')).filter(function(el){
    return el.closest('[id^="leg-"]')===null;
  });
  var hide=els.length>0&&els[0].style.display!=='none';
  els.forEach(function(el){el.style.display=hide?'none':'';});
  btn.style.opacity=hide?'0.3':'1';
}
function togClass(cls,btn){
  var els=document.querySelectorAll('.'+cls);
  var hide=els.length>0&&els[0].style.display!=='none';
  els.forEach(function(el){el.style.display=hide?'none':'';});
  btn.style.opacity=hide?'0.3':'1';
}
</script>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────
// MONTHLY HTML TEMPLATE
// ─────────────────────────────────────────────────────────────────
function generateMonthlyHTML(data, start, end) {
  const { lc, phone, email, emailSat, sla, outbound, wsSat, qcSat,
          monthlyQcFaults, lcTopCats, phoneTopCats, emailTopCats, prev } = data;

  const monthLabel = start.slice(0, 7);

  const lcMap      = {}; (lc.agents      || []).forEach(a => { lcMap[a.name]      = a; });
  const phoneMap   = {}; (phone.agents   || []).forEach(a => { phoneMap[a.name]   = a; });
  const emailMap   = {}; (email.agents   || []).forEach(a => { emailMap[a.name]   = a; });
  const emailSatMap= {}; (emailSat.agents|| []).forEach(a => { emailSatMap[a.name]= a; });
  const obMap      = {}; (outbound.agents|| []).forEach(a => { obMap[a.name]      = a; });
  const wsSatMap   = {}; (wsSat?.agents  || []).forEach(a => { wsSatMap[a.name]   = a; });
  const qcFaultsMap= {}; (monthlyQcFaults?.agents || []).forEach(a => { qcFaultsMap[a.name] = a; });

  const obTotalFollow    = outbound.agents.reduce((s,a) => s + (parseInt(a.followCount)    || 0), 0);
  const obTotalEffective = outbound.agents.reduce((s,a) => s + (parseInt(a.effectiveFollow) || 0), 0);
  const obEffectiveRate  = obTotalFollow > 0 ? (obTotalEffective / obTotalFollow * 100).toFixed(1) + '%' : '-';
  const totalFatal       = (monthlyQcFaults?.agents || []).reduce((s,a) => s + (a.fatal    || 0), 0);
  const totalNonfatal    = (monthlyQcFaults?.agents || []).reduce((s,a) => s + (a.nonfatal || 0), 0);

  function momDelta(curr, prevVal, higherBetter = true, isInt = false) {
    const c = parseFloat(curr), p = parseFloat(prevVal);
    if (isNaN(c) || isNaN(p)) return '';
    const d = c - p;
    if (Math.abs(d) < (isInt ? 0.5 : 0.05)) return '';
    const better = higherBetter ? d > 0 : d < 0;
    const color = better ? '#16a34a' : '#dc2626';
    const arrow = d > 0 ? '↑' : '↓';
    const fmt = isInt ? String(Math.abs(Math.round(d))) : Math.abs(d).toFixed(1).replace(/\.0$/, '') + '%';
    return `<span class="mom-delta" style="color:${color}">${arrow}${fmt} <span style="color:#9ca3af">vs上月</span></span>`;
  }

  function kpiCard(label, en, val, opts = {}) {
    const { target, higherBetter = true, prevVal, isInt = false } = opts;
    const v = parseFloat(val);
    const ok = (!isNaN(v) && val !== '-' && target != null) ? (higherBetter ? v >= target : v <= target) : null;
    const vColor = ok === true ? '#16a34a' : ok === false ? '#dc2626' : '#1a1a2e';
    const topBorder = ok === true ? '#16a34a' : ok === false ? '#dc2626' : '#1456F0';
    const bgColor   = ok === true ? '#f0fdf4' : ok === false ? '#fef2f2' : '#fff';
    const changeHtml = prevVal != null ? momDelta(val, prevVal, higherBetter, isInt) : '';
    const targetHtml = target != null ? `<div class="kpi-tgt">目标 ${higherBetter?'≥':'≤'}${target}%</div>` : '';
    return `<div class="kpi-card" style="border-top:3px solid ${topBorder};background:${bgColor}">` +
      `<div class="kpi-lbl">${label}<span class="kpi-en-lbl">${en}</span></div>` +
      `<div class="kpi-val" style="color:${vColor}">${val||'-'} ${changeHtml}</div>` +
      targetHtml + `</div>`;
  }

  function kpiRow(cards) { return `<div class="kpi-row">${cards.join('')}</div>`; }

  function sectHdr(icon, zh, en) {
    return `<div class="sect-hdr"><span class="sect-icon">${icon}</span>` +
      `<span class="sect-zh">${zh}</span><span class="sect-en">${en}</span></div>`;
  }

  function subTitle(zh, en = '') {
    return `<div class="subsect-title">${zh}${en ? ` <span class="en">${en}</span>` : ''}</div>`;
  }

  function topCatTbl(cats) {
    if (!cats || cats.length === 0) return '<p style="color:#aaa;font-size:12px;margin:8px 0">暂无数据</p>';
    const total = cats.reduce((s,c) => s + c.count, 0);
    return `<table style="font-size:12px"><thead><tr>` +
      `<th style="width:22px;text-align:center">#</th><th style="text-align:left">分类</th><th>工单数</th><th>占比</th>` +
      `</tr></thead><tbody>` +
      cats.map((c,i) =>
        `<tr><td style="color:#9ca3af;font-size:11px;text-align:center">${i+1}</td>` +
        `<td style="text-align:left">${esc(c.name)}</td><td>${c.count}</td>` +
        `<td>${total>0?(c.count/total*100).toFixed(1)+'%':'-'}</td></tr>`
      ).join('') + `</tbody></table>`;
  }

  // ── Section 1: Live Chat ─────────────────────────────────────
  const lcAgents = TEAM_ORDER.filter(n => lcMap[n]).map(n => lcMap[n]);
  const lc30sB = colBounds(lcAgents, a => a.thirtySecRate);
  const lcSatB = colBounds(lcAgents, a => a.satisfaction);
  const lcFcrB = colBounds(lcAgents, a => a.fcr);
  const lcRows = lcAgents.map(a => tr(a.name, a.tickets||'-', rankTd(a.thirtySecRate, lc30sB), rankTd(a.satisfaction, lcSatB), rankTd(a.fcr, lcFcrB), a.avgHandle||'-'));
  const lcTable = tbl(
    th(b('客服','Agent'), b('工单量','Tickets'), b('30s接通率','30s Rate'), b('满意度','CSAT'), b('FCR','FCR'), b('平均处理时长','Avg Handle')),
    lcRows
  );
  const lcSection = sectHdr('💬','在线客服','Live Chat') +
    kpiRow([
      kpiCard('工单量','Tickets', String(lc.team.tickets||'-'), {prevVal:prev?.lc?.tickets, isInt:true}),
      kpiCard('30s接通率','30s Answer Rate', lc.team.thirtySecRate||'-', {target:90}),
      kpiCard('满意度','CSAT', lc.team.satisfaction||'-', {target:84, prevVal:prev?.lc?.satisfaction}),
      kpiCard('FCR','First Contact Res.', lc.team.fcr||'-', {target:95}),
      kpiCard('平均处理时长','Avg Handle Time', lc.team.avgHandle||'-'),
    ]) +
    subTitle('个人明细','Agent Breakdown') + lcTable +
    (lcTopCats?.length ? subTitle('业务分类 TOP 10') + topCatTbl(lcTopCats) : '');

  // ── Section 2: Phone ─────────────────────────────────────────
  const phAgents = TEAM_ORDER.filter(n => phoneMap[n] && toInt(phoneMap[n].inbound) > 0).map(n => phoneMap[n]);
  const ph20sB = colBounds(phAgents, a => a.ans20s);
  const phSatB = colBounds(phAgents, a => a.satisfaction);
  const phFcrB = colBounds(phAgents, a => a.fcr);
  const phRows = phAgents.map(a => tr(a.name, a.inbound||'-', rankTd(a.ans20s, ph20sB), a.avgDuration||'-', rankTd(a.satisfaction, phSatB), rankTd(a.fcr, phFcrB)));
  const phTable = tbl(
    th(b('客服','Agent'), b('呼入量','Inbound'), b('20s接通率','20s Rate'), b('通话时长','Call Dur.'), b('满意度','CSAT'), b('FCR','FCR')),
    phRows
  );
  const phoneSection = sectHdr('📞','电话','Phone') +
    kpiRow([
      kpiCard('呼入量','Inbound Calls', String(phone.team.inbound||'-'), {prevVal:prev?.phone?.tickets, isInt:true}),
      kpiCard('20s接通率','20s Answer Rate', phone.team.ans20s||'-', {target:95}),
      kpiCard('满意度','CSAT', phone.team.satisfaction||'-', {target:84, prevVal:prev?.phone?.satisfaction}),
      kpiCard('FCR','First Contact Res.', phone.team.fcr||'-', {target:95}),
      kpiCard('平均通话时长','Avg Call Duration', phone.team.avgDuration||'-'),
    ]) +
    subTitle('个人明细','Agent Breakdown') + phTable +
    (phoneTopCats?.length ? subTitle('业务分类 TOP 10') + topCatTbl(phoneTopCats) : '');

  // ── Section 3: Email ─────────────────────────────────────────
  const emAgentNames = TEAM_ORDER.filter(n => emailMap[n]);
  const emSlaB = colBounds(emAgentNames.map(n => emailMap[n]), a => a.slaRate);
  const emSatB = colBounds(emAgentNames.map(n => emailSatMap[n]||{}), a => a.satisfaction);
  const emRows = emAgentNames.map(n => {
    const em = emailMap[n], esa = emailSatMap[n]||{};
    return tr(n, em.tickets||'-', rankTd(em.slaRate, emSlaB), rankTd(esa.satisfaction, emSatB), em.avgRespTime||'-');
  });
  const emTable = tbl(
    th(b('客服','Agent'), b('工单量','Tickets'), b('SLA达标率','SLA Rate'), b('满意度','CSAT'), b('平均回复时长','Avg Reply')),
    emRows
  );
  const emailSection = sectHdr('📧','邮件','Email') +
    kpiRow([
      kpiCard('工单量','Tickets', String(email.team.replied||'-'), {prevVal:prev?.email?.tickets, isInt:true}),
      kpiCard('整体SLA','Overall SLA', sla.overallSLA||'-', {target:90}),
      kpiCard('满意度','CSAT', emailSat.team.satisfaction||'-', {target:84, prevVal:prev?.email?.satisfaction}),
      kpiCard('平均回复时长','Avg Reply Time', email.team.avgRespTime||'-'),
    ]) +
    subTitle('个人明细','Agent Breakdown') + emTable +
    (emailTopCats?.length ? subTitle('业务分类 TOP 10') + topCatTbl(emailTopCats) : '');

  // ── Section 4: Outbound ──────────────────────────────────────
  const obRows = TEAM_ORDER.filter(n => obMap[n]).map(n => {
    const ob = obMap[n];
    const mpc = (ob.monthlyPC != null && ob.monthlyPC !== '-') ? ob.monthlyPC : (ob.weeklyPC ?? '-');
    return tr(n, ob.leadsAssigned||'-', ob.followCount||'-', ob.effectiveFollow||'-', mpc);
  });
  const obTable = tbl(
    th(b('客服','Agent'), b('分配Leads','Leads'), b('外呼跟进量','Follow-up'), b('有效跟进','Eff. Follow'), b('月度转化PC','Monthly PC')),
    obRows
  );
  const outboundSection = sectHdr('📤','外呼','Outbound') +
    kpiRow([
      kpiCard('外呼跟进量','Outbound Contacts', String(obTotalFollow||'-'), {isInt:true}),
      kpiCard('有效跟进量','Effective (≥40s)', String(obTotalEffective||'-'), {isInt:true}),
      kpiCard('有效跟进率','Effective Rate', obEffectiveRate),
      kpiCard('月度转化PC','Monthly Conv. PC', String(outbound.team?.monthlyPC||'-'), {isInt:true}),
    ]) +
    subTitle('个人明细','Agent Breakdown') + obTable;

  // ── Section 5: Satisfaction ───────────────────────────────────
  const wsTeam = wsSat?.team || {};
  const wsAgents = (wsSat?.agents || []).filter(a => a.total > 0);
  const wsTeamSatV = parseFloat(wsTeam.satisfaction);

  const csatColgroup = '<colgroup>'
    + '<col style="width:11%"><col style="width:7%"><col style="width:7%"><col style="width:6%"><col style="width:7%">'
    + '<col style="width:8%"><col style="width:8%"><col style="width:8%"><col style="width:9%"><col style="width:8%">'
    + '<col style="width:10%"></colgroup>';
  const csatHdr = '<tr class="group-header">'
    + '<th rowspan="2" style="vertical-align:middle">客服<br><span class="en">Agent</span></th>'
    + '<th rowspan="2" style="vertical-align:middle;text-align:center">总评价<br><span class="en">Total</span></th>'
    + '<th colspan="3" class="zone-weekly" style="text-align:center">渠道评价数</th>'
    + '<th colspan="5" class="zone-csat" style="text-align:center">评价分布</th>'
    + '<th rowspan="2" style="vertical-align:middle">满意度<br><span class="en">CSAT</span></th></tr>'
    + '<tr>'
    + '<th class="zone-weekly" style="text-align:center">在线</th>'
    + '<th class="zone-weekly" style="text-align:center">电话</th>'
    + '<th class="zone-weekly" style="border-right:2px solid #bfdbfe;text-align:center">邮件</th>'
    + '<th class="zone-csat">超赞</th><th class="zone-csat">满意</th><th class="zone-csat">一般</th>'
    + '<th class="zone-csat">不满意</th><th class="zone-csat" style="border-right:2px solid #a5f3fc">糟糕</th>'
    + '</tr>';

  function csatValCell(s) {
    if (!s || s === '-') return '-';
    const v = parseFloat(s);
    return v < 84 ? `<span style="color:#dc2626;font-weight:700">${s}</span>` : s;
  }
  function zo(n) { return (n && n > 0) ? n : '-'; }

  const csatAgentRows = wsAgents.map(a =>
    `<tr><td>${esc(a.name)}</td><td>${a.total}</td>` +
    `<td>${zo(a.lc)}</td><td>${zo(a.phone)}</td><td>${zo(a.email)}</td>` +
    `<td>${zo(a.superb)}</td><td>${zo(a.good)}</td><td>${zo(a.avg)}</td>` +
    `<td>${zo(a.dissatisfied)}</td><td>${zo(a.bad)}</td>` +
    `<td>${csatValCell(a.satisfaction)}</td></tr>`
  );
  const csatTeamCell = wsTeam.total
    ? (wsTeamSatV >= 84
        ? `<strong>${wsTeam.satisfaction||'-'}</strong> <span class="tgt">≥84%</span>`
        : `<strong><span style="color:#dc2626;font-weight:700">${wsTeam.satisfaction||'-'}</span></strong> <span class="tgt">≥84%</span>`)
    : '-';
  const csatTotalRow = `<tr class="consult-total-row">` +
    `<td><strong>合计 Total</strong></td><td><strong>${wsTeam.total||0}</strong></td>` +
    `<td><strong>${wsTeam.lc||0}</strong></td><td><strong>${wsTeam.phone||0}</strong></td><td><strong>${wsTeam.email||0}</strong></td>` +
    `<td><strong>${wsTeam.superb||0}</strong></td><td><strong>${wsTeam.good||0}</strong></td><td><strong>${wsTeam.avg||0}</strong></td>` +
    `<td><strong>${wsTeam.dissatisfied||0}</strong></td><td><strong>${wsTeam.bad||0}</strong></td>` +
    `<td>${csatTeamCell}</td></tr>`;
  const csatAgentTable = `<table>${csatColgroup}<thead>${csatHdr}</thead><tbody>${csatAgentRows.join('')}${csatTotalRow}</tbody></table>`;

  const lowChans = [
    { name: '在线 Live Chat', sat: lc.team.satisfaction },
    { name: '电话 Phone',     sat: phone.team.satisfaction },
    { name: '邮件 Email',     sat: emailSat.team.satisfaction },
  ].filter(c => c.sat && c.sat !== '-' && parseFloat(c.sat) < 84)
   .sort((a,b) => parseFloat(a.sat) - parseFloat(b.sat));

  const csatImprovHtml = lowChans.length > 0
    ? `<div style="background:#eff6ff;border-left:4px solid #1456F0;border-radius:6px;padding:12px 16px;margin-top:14px">` +
      `<div style="font-size:11px;font-weight:700;color:#1456F0;letter-spacing:1px;margin-bottom:8px">改善方向</div>` +
      lowChans.map(c =>
        `<div style="font-size:12.5px;color:#374151;margin-bottom:6px">› <strong>${c.name}</strong> CSAT ` +
        `<span style="color:#dc2626;font-weight:700">${c.sat}</span>，目标 ≥84%</div>`
      ).join('') + `</div>`
    : `<div style="background:#f0fdf4;border-left:4px solid #22c55e;border-radius:6px;padding:10px 14px;margin-top:14px;font-size:13px;color:#15803d">本月各渠道满意度均达标</div>`;

  const negCats = (wsSat?.negCategories || []).filter(c => c.count > 0);
  const negCatHtml = negCats.length > 0
    ? subTitle('不满意工单分类分布','Dissatisfied Ticket Categories') +
      `<table style="width:auto;min-width:320px;font-size:12.5px"><thead><tr>` +
      `<th style="text-align:left">分类</th><th style="text-align:center">工单数</th><th style="text-align:center">占比</th>` +
      `</tr></thead><tbody>` +
      (() => {
        const t = negCats.reduce((s,x)=>s+x.count,0);
        return negCats.map(c =>
          `<tr><td>${esc(c.name)}</td><td style="text-align:center">${c.count}</td>` +
          `<td style="text-align:center">${t>0?(c.count/t*100).toFixed(1)+'%':'-'}</td></tr>`
        ).join('');
      })() + `</tbody></table>`
    : '';

  const csatSection = sectHdr('⭐','满意度分析','Satisfaction Analysis') +
    kpiRow([
      kpiCard('综合满意度','Overall CSAT',  wsTeam.satisfaction||'-',       {target:84}),
      kpiCard('在线 CSAT', 'Live Chat CSAT', lc.team.satisfaction||'-',     {target:84}),
      kpiCard('电话 CSAT', 'Phone CSAT',    phone.team.satisfaction||'-',   {target:84}),
      kpiCard('邮件 CSAT', 'Email CSAT',    emailSat.team.satisfaction||'-', {target:84}),
    ]) +
    (wsTeam.total > 0
      ? subTitle('个人满意度明细','Agent CSAT Detail') + csatAgentTable + csatImprovHtml + negCatHtml
      : '<p style="color:#94a3b8;font-size:13px;margin-top:16px">无满意度数据（WS_COOKIE 未配置或本月无评价）</p>');

  // ── Section 6: QA ────────────────────────────────────────────
  const qaRows = TEAM_ORDER.map(n => {
    const d = qcFaultsMap[n] || { fatal: 0, nonfatal: 0 };
    return `<tr><td>${esc(n)}</td>` +
      `<td style="text-align:center;color:${d.fatal>0?'#dc2626':'#6b7280'};font-weight:${d.fatal>0?'700':'400'}">${d.fatal}</td>` +
      `<td style="text-align:center">${d.nonfatal}</td>` +
      `<td style="text-align:center;font-weight:${(d.fatal+d.nonfatal)>0?'600':'400'}">${d.fatal+d.nonfatal}</td></tr>`;
  });
  const qaTotalRow = `<tr class="consult-total-row">` +
    `<td><strong>合计 Total</strong></td>` +
    `<td style="text-align:center;color:${totalFatal>0?'#dc2626':'inherit'};font-weight:700">${totalFatal}</td>` +
    `<td style="text-align:center;font-weight:700">${totalNonfatal}</td>` +
    `<td style="text-align:center;font-weight:700">${totalFatal+totalNonfatal}</td></tr>`;
  const qaTable = `<table><thead><tr>` +
    `<th style="text-align:left">客服 Agent</th>` +
    `<th style="text-align:center">致命差错<br><span class="en">Fatal</span></th>` +
    `<th style="text-align:center">非致命差错<br><span class="en">Non-Fatal</span></th>` +
    `<th style="text-align:center">合计<br><span class="en">Total</span></th>` +
    `</tr></thead><tbody>${qaRows.join('')}${qaTotalRow}</tbody></table>`;
  const qaQcSat = qcSat?.team?.satisfaction || '-';
  const qaSection = sectHdr('🔍','质检差错','QA / Quality') +
    kpiRow([
      kpiCard('致命差错','Fatal Errors',   String(totalFatal),   {higherBetter:false}),
      kpiCard('非致命差错','Non-Fatal',    String(totalNonfatal),{higherBetter:false}),
      kpiCard('差错合计','Total Errors',   String(totalFatal+totalNonfatal), {higherBetter:false}),
      ...(qaQcSat!=='-' ? [kpiCard('质检满意度','QC Satisfaction', qaQcSat, {target:84})] : []),
    ]) +
    subTitle('个人差错明细','Agent Error Detail') + qaTable;

  // ── Section 7: Monthly Summary ────────────────────────────────
  const consultTotal = toInt(lc.team.tickets) + toInt(phone.team.inbound) + toInt(email.team.replied);
  const obMonthlyPC  = parseInt(outbound.team?.monthlyPC) || 0;
  const wsTeamSat2   = wsTeam.satisfaction || '-';

  function chip(label, val, ok) {
    const c  = ok===true?'#16a34a':ok===false?'#dc2626':'#1456F0';
    const bg = ok===true?'#f0fdf4':ok===false?'#fef2f2':'#f0f4ff';
    const bd = ok===true?'#bbf7d0':ok===false?'#fecaca':'#c7d6f7';
    return `<span style="font-size:12px;padding:3px 9px;border-radius:4px;border:1px solid ${bd};background:${bg};color:${c};white-space:nowrap"><strong>${label}</strong> ${val}</span>`;
  }
  const chips2 = [];
  chips2.push(chip('总工单量', `${consultTotal||'-'} 条`, null));
  if (obTotalFollow > 0) chips2.push(chip('外呼跟进量', `${obTotalFollow} 条`, null));
  if (obMonthlyPC  > 0) chips2.push(chip('月度转化PC', `${obMonthlyPC} 单`, null));
  if (wsTeamSat2 !== '-') { const sv=parseFloat(wsTeamSat2); chips2.push(chip('综合满意度', wsTeamSat2, !isNaN(sv)?sv>=84:null)); }
  if (totalFatal  > 0) chips2.push(chip('致命差错', `${totalFatal} 条`, false));

  const summarySection = sectHdr('📋','月度总结','Monthly Summary') +
    (chips2.length ? `<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:20px;padding:10px 14px;background:#f8faff;border:1.5px solid #c7d6f7;border-radius:6px">` +
      `<span style="font-size:11px;font-weight:700;color:#6b7280;margin-right:4px;align-self:center">月度概览</span>` +
      chips2.join('') + `</div>` : '') +
    subTitle('月度重点工作','Key Work This Month') +
    `<div class="editable-hint">点击编辑 / Click to edit</div>` +
    `<div class="editable-area" contenteditable="true">请填写本月重点工作...</div>` +
    `<div style="margin-top:20px">` + subTitle('下月计划','Next Month Plans') + `</div>` +
    `<div class="editable-hint">点击编辑 / Click to edit</div>` +
    `<div class="editable-area" contenteditable="true">请填写下月安排...</div>`;

  // ── Full HTML ─────────────────────────────────────────────────
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>US CSS Monthly Report — ${monthLabel}</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, "Segoe UI", Arial, sans-serif; background: #f0f4fa; color: #1a1a2e; padding: 0; }
.page-header { background: linear-gradient(135deg, #1456F0, #3d7ff5); color: #fff; padding: 24px 36px 20px; text-align: center; }
h1 { font-size: 22px; font-weight: 700; letter-spacing: .3px; margin-bottom: 4px; }
.subtitle { font-size: 12px; color: rgba(255,255,255,.8); }
.tab-nav { position: sticky; top: 0; z-index: 100; background: #fff; border-bottom: 2px solid #e2e8f0; display: flex; gap: 0; overflow-x: auto; padding: 0 24px; box-shadow: 0 2px 8px rgba(0,0,0,.06); }
.tab-btn { padding: 12px 18px; font-size: 13px; font-weight: 500; color: #6b7280; border: none; background: none; cursor: pointer; white-space: nowrap; border-bottom: 3px solid transparent; margin-bottom: -2px; transition: color .15s, border-color .15s; }
.tab-btn:hover { color: #1456F0; }
.tab-btn.active { color: #1456F0; font-weight: 700; border-bottom-color: #1456F0; }
.tab-pane { display: none; padding: 28px 32px; max-width: 1480px; margin: 0 auto; }
.tab-pane.active { display: block; }
.sect-hdr { display: flex; align-items: center; gap: 10px; margin-bottom: 20px; padding-bottom: 12px; border-bottom: 2px solid #e2e8f0; }
.sect-icon { font-size: 20px; }
.sect-zh { font-size: 16px; font-weight: 700; color: #1456F0; }
.sect-en { font-size: 12px; color: #9ca3af; margin-left: 4px; }
.kpi-row { display: flex; gap: 14px; flex-wrap: wrap; margin-bottom: 24px; }
.kpi-card { flex: 1; min-width: 140px; background: #fff; border-radius: 10px; padding: 14px 16px; box-shadow: 0 1px 4px rgba(0,0,0,.08); }
.kpi-lbl { font-size: 12px; font-weight: 600; color: #6b7280; margin-bottom: 6px; }
.kpi-en-lbl { display: block; font-size: 10px; color: #9ca3af; font-weight: 400; margin-top: 1px; }
.kpi-val { font-size: 20px; font-weight: 700; line-height: 1.2; }
.kpi-tgt { font-size: 10px; color: #9ca3af; margin-top: 4px; }
.mom-delta { font-size: 10px; font-weight: 500; margin-left: 4px; }
h2 { font-size: 15px; font-weight: 700; color: #fff; margin-bottom: 16px; padding: 10px 18px;
     background: linear-gradient(135deg, #1456F0, #3d7ff5); border-radius: 8px; display: flex; align-items: center; gap: 8px; }
h3 { font-size: 11.5px; font-weight: 700; color: #1456F0; margin: 18px 0 8px; text-transform: uppercase; letter-spacing: .8px; }
table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
th { background: #eef2ff; color: #1456F0; text-align: center; padding: 10px 10px; border-bottom: 2px solid #c0d0f0; white-space: nowrap; }
th:first-child { text-align: left; }
td { padding: 8px 10px; border-bottom: 1px solid #eef0f5; white-space: nowrap; text-align: center; vertical-align: middle; }
td:first-child { text-align: left; }
.bold-row td { font-weight: 700; background: #eef2ff; }
.consult-total-row td { font-weight: 700; background: #dce6ff; border-top: 2px solid #1456F0; border-bottom: 2px solid #1456F0; }
tr:hover td { background: #f8f9ff; }
td.empty { color: #aaa; text-align: center; }
.en { font-size: 11px; color: #999; font-weight: 400; }
.editable-area { min-height: 130px; border: 1px solid #e0e4f0; border-radius: 8px; padding: 14px 18px;
                 font-size: 13px; color: #333; line-height: 1.8; outline: none; background: #fafbff; }
.editable-area:focus { border-color: #1456F0; box-shadow: 0 0 0 2px rgba(20,86,240,.1); }
.editable-hint { font-size: 11px; color: #aaa; margin-bottom: 8px; }
.dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-left:4px; vertical-align:middle; }
.val-wrap { position:relative; display:inline-block; }
.val-wrap .dot { position:absolute; left:calc(100% + 3px); top:50%; transform:translateY(-50%); margin:0; }
.dot-green { background:#22c55e; }
.dot-red { background:#ef4444; }
.tgt { font-size:10px; color:#bbb; font-weight:400; margin-left:4px; }
.subsect-title { font-size: 13.5px; font-weight: 700; color: #1456F0; margin: 0 0 10px 0; padding: 5px 0 7px; border-bottom: 1px solid #d0daf8; letter-spacing: .2px; }
.zone-weekly { background:#dbeafe; color:#1456F0; border-right:2px solid #bfdbfe; }
.zone-csat   { background:#cffafe; color:#0e7490; border-right:2px solid #a5f3fc; }
.group-header th { padding:6px 10px; font-size:12px; }
</style>
</head>
<body>
<div class="page-header">
  <h1>US CSS Monthly Report</h1>
  <p class="subtitle">${start} ~ ${end} &nbsp;|&nbsp; Conversion CS Team &nbsp;(${TEAM_ORDER.length} agents)</p>
</div>
<nav class="tab-nav" id="tabNav">
  <button class="tab-btn active" onclick="switchTab('lc',this)">💬 在线客服</button>
  <button class="tab-btn" onclick="switchTab('phone',this)">📞 电话</button>
  <button class="tab-btn" onclick="switchTab('email',this)">📧 邮件</button>
  <button class="tab-btn" onclick="switchTab('outbound',this)">📤 外呼</button>
  <button class="tab-btn" onclick="switchTab('csat',this)">⭐ 满意度</button>
  <button class="tab-btn" onclick="switchTab('qa',this)">🔍 质检</button>
  <button class="tab-btn" onclick="switchTab('summary',this)">📋 月度总结</button>
</nav>
<div id="tab-lc"       class="tab-pane active">${lcSection}</div>
<div id="tab-phone"    class="tab-pane">${phoneSection}</div>
<div id="tab-email"    class="tab-pane">${emailSection}</div>
<div id="tab-outbound" class="tab-pane">${outboundSection}</div>
<div id="tab-csat"     class="tab-pane">${csatSection}</div>
<div id="tab-qa"       class="tab-pane">${qaSection}</div>
<div id="tab-summary"  class="tab-pane">${summarySection}</div>
<p style="font-size:11px;color:#aaa;text-align:center;padding:16px">Generated: ${new Date().toISOString()}</p>
<script>
function switchTab(id,btn){
  document.querySelectorAll('.tab-pane').forEach(function(el){el.classList.remove('active');});
  document.querySelectorAll('.tab-btn').forEach(function(el){el.classList.remove('active');});
  document.getElementById('tab-'+id).classList.add('active');
  btn.classList.add('active');
}
</script>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────
const GITHUB_REPORT_BASE = 'https://irisding001.github.io/us-css-weeklyreport';

function parsePrevReport(html) {
  const stripHtml = s => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  const rows = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = trRe.exec(html)) !== null) {
    const cells = [];
    const tdRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g;
    let tm;
    while ((tm = tdRe.exec(m[1])) !== null) cells.push(stripHtml(tm[1]));
    if (cells.length >= 2) rows.push(cells);
  }
  const findRow = label => rows.find(r => r[0]?.includes(label));
  const firstNum = s => { const m = s?.match(/(\d[\d,]*)/); return m ? parseInt(m[1].replace(',','')) : null; };
  const firstPct = s => { const m = s?.match(/([\d.]+)%/); return m ? m[1] + '%' : null; };

  const lcRow    = findRow('在线 Live Chat');
  const phoneRow = findRow('电话 Phone');
  const emailRow = findRow('邮件 Email');
  const totalRow = findRow('合计 Total');
  // Outbound row: find row where first cell is a pure number >= 100 (follow count)
  const obRow = rows.find(r => /^\d{2,}$/.test(r[0]) && r.length >= 4);

  return {
    lc:    { tickets: firstNum(lcRow?.[1]),    satisfaction: firstPct(lcRow?.[3]) },
    phone: { tickets: firstNum(phoneRow?.[1]), satisfaction: firstPct(phoneRow?.[3]) },
    email: { tickets: firstNum(emailRow?.[1]), satisfaction: firstPct(emailRow?.[3]) },
    total: { tickets: firstNum(totalRow?.[1]), satisfaction: firstPct(totalRow?.[3]) },
    ob:    { follow: firstNum(obRow?.[0]), weeklyPC: firstNum(obRow?.[3]) },
  };
}

async function fetchPrevWeekReport(weekStart) {
  try {
    const d = new Date(weekStart + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - 7);
    const prevStart = d.toISOString().slice(0, 10);
    const prevEnd   = new Date(d.getTime() + 6 * 86400000).toISOString().slice(0, 10);
    const mmdd      = prevEnd.slice(5).replace('-', '');
    // Try new format first, then fall back to old format (without end-date suffix)
    const urls = [
      `${GITHUB_REPORT_BASE}/weekly_report_${prevStart}_${mmdd}.html`,
      `${GITHUB_REPORT_BASE}/weekly_report_${prevStart}.html`,
    ];
    for (const url of urls) {
      try {
        console.log(`[INFO] Fetching prev week report: ${url}`);
        const html = await httpGetPlain(url);
        const parsed = parsePrevReport(html);
        console.log(`[INFO] Prev week parsed: LC ${parsed.lc.tickets}, Phone ${parsed.phone.tickets}, Email ${parsed.email.tickets}`);
        return parsed;
      } catch (e2) {
        console.warn(`[WARN] ${url} → ${e2.message}`);
      }
    }
    return null;
  } catch (e) {
    console.warn(`[WARN] Prev week report unavailable: ${e.message}`);
    return null;
  }
}

async function discoverPage(pageId) {
  console.log(`\nDiscovering page: ${pageId}`);
  let cfg;
  try { cfg = await guandataGet(`/api/page/${pageId}`); }
  catch (e) { console.error(`GET /api/page failed: ${e.message}`); cfg = null; }
  if (cfg) {
    const ids = new Set();
    const walk = (o) => {
      if (!o || typeof o !== 'object') return;
      for (const [k, v] of Object.entries(o)) {
        if ((k === 'cdId' || k === 'cardId') && typeof v === 'string' && /^[a-z0-9]{24}$/.test(v)) ids.add(v);
        walk(v);
      }
    };
    walk(cfg);
    console.log(`\nFound ${ids.size} card IDs:`);
    for (const id of ids) {
      try { await discoverCard(id, id); } catch (e) { console.error(`  ${id}: ${e.message}`); }
    }
  }
  // Also print raw truncated response for inspection
  if (cfg) console.log('\nRaw (truncated):', JSON.stringify(cfg).slice(0, 2000));
}

async function main() {
  if (DISCOVER_PAGE) { await discoverPage(DISCOVER_PAGE); return; }
  if (DISCOVER) { await runDiscover(); return; }

  const { start, end } = getWeekRange();
  const dataStart = dataStartArg || (start < DATA_FLOOR ? DATA_FLOOR : start);
  console.log(`Generating weekly report: ${start} ~ ${end}${dataStart !== start ? ` (channel data from ${dataStart})` : ''}`);

  const mFloor = monthStart(end) < DATA_FLOOR ? DATA_FLOOR : monthStart(end);
  const h1Start = addDays(start, -21); const h1End = addDays(start, -15);
  const h2Start = addDays(start, -14); const h2End = addDays(start, -8);
  const h3Start = addDays(start, -7);  const h3End = addDays(start, -1);
  const [lcR, utilR, phoneR, puR, emailR, emailSatR, slaR, obR, qcSatR, wsSatR, mLcR, mPhoneR, mEmailR, mEmailSatR, mQcFaultsR, lcTopR, phoneTopR, emailTopR, consultPCR, mWsSatR, h1SatR, h2SatR, h3SatR, h1VolR, h2VolR, h3VolR, h1ObR, h2ObR, h3ObR, chPCR] = await Promise.allSettled([
    fetchLiveChatQueue(dataStart, end),
    fetchLiveChatUtil(dataStart, end),
    fetchPhone(dataStart, end),
    fetchPhoneUtil(start, end),
    fetchEmail(dataStart, end),
    fetchEmailSat(dataStart, end),
    fetchSLA(dataStart, end),
    fetchOutbound(start, end),
    fetchQcSat(dataStart, end),
    fetchWsSat(dataStart, end),
    fetchLiveChatQueue(mFloor, end),
    fetchPhone(mFloor, end),
    fetchEmail(mFloor, end),
    fetchEmailSat(mFloor, end),
    fetchQcFaults(mFloor, end),
    fetchLcTopCategories(dataStart, end),
    fetchPhoneTopCategories(dataStart, end),
    fetchEmailTopCategories(dataStart, end),
    fetchConsultPC(start, end, mFloor),
    fetchWsSat(mFloor, end),
    fetchWsSat(h1Start, h1End),
    fetchWsSat(h2Start, h2End),
    fetchWsSat(h3Start, h3End),
    fetchTeamVolSummary(h1Start, h1End),
    fetchTeamVolSummary(h2Start, h2End),
    fetchTeamVolSummary(h3Start, h3End),
    fetchOutboundFollowSummary(h1Start, h1End),
    fetchOutboundFollowSummary(h2Start, h2End),
    fetchOutboundFollowSummary(h3Start, h3End),
    fetchChannelPCDetail(start, end),
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
    outbound: unwrap(obR,    '外呼',       { team: { weeklyPC: '-', monthlyPC: '-', lcPC: '-', phonePC: '-', emailPC: '-', consultPC: '-' }, agents: [] }),
    qcSat:    unwrap(qcSatR, '质检满意度', { team: { satisfaction: '-' }, agents: [] }),
    wsSat:    unwrap(wsSatR, 'WS满意度',   { team: { satisfaction: '-' }, agents: [] }),
    monthlyLc:      unwrap(mLcR,      '月度LC',       { team: {}, agents: [] }),
    monthlyPhone:   unwrap(mPhoneR,   '月度Phone',    { team: {}, agents: [] }),
    monthlyEmail:   unwrap(mEmailR,   '月度Email',    { team: {}, agents: [] }),
    monthlyEmailSat:unwrap(mEmailSatR,  '月度Email满意度', { team: { satisfaction: '-' }, agents: [] }),
    monthlyQcFaults:unwrap(mQcFaultsR, '月度质检差错',   { agents: [] }),
    lcTopCats:    unwrap(lcTopR,    'LC Top Cat',    []),
    phoneTopCats: unwrap(phoneTopR, 'Phone Top Cat', []),
    emailTopCats: unwrap(emailTopR, 'Email Top Cat', []),
    autoConsultPC: unwrap(consultPCR, '咨询PC(BI)', { weekly: {}, monthly: {} }),
    channelPC:     unwrap(chPCR,      '渠道PC',     { lc: '-', phone: '-', email: '-', byAgent: {} }),
    monthlyWsSat:  unwrap(mWsSatR,    '月度WS满意度', { team: { satisfaction: '-' }, agents: [] }),
    histWsSat: [
      { start: h1Start, end: h1End, data: unwrap(h1SatR, 'CSAT W-3', { team: {}, agents: [] }) },
      { start: h2Start, end: h2End, data: unwrap(h2SatR, 'CSAT W-2', { team: {}, agents: [] }) },
      { start: h3Start, end: h3End, data: unwrap(h3SatR, 'CSAT W-1', { team: {}, agents: [] }) },
    ],
    histTrend: [
      { label: weekLabel(h1Start, h1End), vol: unwrap(h1VolR, 'Vol W-3', {vol:0}).vol, followCount: unwrap(h1ObR, 'OB W-3', {followCount:0}).followCount, csat: unwrap(h1SatR, 'CSAT W-3', {team:{satisfaction:'-'}}).team?.satisfaction || '-' },
      { label: weekLabel(h2Start, h2End), vol: unwrap(h2VolR, 'Vol W-2', {vol:0}).vol, followCount: unwrap(h2ObR, 'OB W-2', {followCount:0}).followCount, csat: unwrap(h2SatR, 'CSAT W-2', {team:{satisfaction:'-'}}).team?.satisfaction || '-' },
      { label: weekLabel(h3Start, h3End), vol: unwrap(h3VolR, 'Vol W-1', {vol:0}).vol, followCount: unwrap(h3ObR, 'OB W-1', {followCount:0}).followCount, csat: unwrap(h3SatR, 'CSAT W-1', {team:{satisfaction:'-'}}).team?.satisfaction || '-' },
    ],
  };

  function toCSAT(v) { return v.includes('%') ? v : v + '%'; }
  if (lcCSATArg)    data.lc.team.satisfaction       = toCSAT(lcCSATArg);
  if (phoneCSATArg) data.phone.team.satisfaction    = toCSAT(phoneCSATArg);
  if (emailCSATArg) data.emailSat.team.satisfaction = toCSAT(emailCSATArg);

  data.prev = await fetchPrevWeekReport(start);

  // Manual prev-week override (takes precedence over GitHub fetch)
  const hasPrevArgs = prevLcTickets || prevLcCsat || prevPhoneTickets || prevPhoneCsat || prevEmailTickets || prevEmailCsat;
  if (hasPrevArgs) {
    data.prev = data.prev || {};
    if (prevLcTickets || prevLcCsat) {
      data.prev.lc = data.prev.lc || {};
      if (prevLcTickets) data.prev.lc.tickets    = prevLcTickets;
      if (prevLcCsat)    data.prev.lc.satisfaction = prevLcCsat.includes('%') ? prevLcCsat : prevLcCsat + '%';
    }
    if (prevPhoneTickets || prevPhoneCsat) {
      data.prev.phone = data.prev.phone || {};
      if (prevPhoneTickets) data.prev.phone.tickets    = prevPhoneTickets;
      if (prevPhoneCsat)    data.prev.phone.satisfaction = prevPhoneCsat.includes('%') ? prevPhoneCsat : prevPhoneCsat + '%';
    }
    if (prevEmailTickets || prevEmailCsat) {
      data.prev.email = data.prev.email || {};
      if (prevEmailTickets) data.prev.email.tickets    = prevEmailTickets;
      if (prevEmailCsat)    data.prev.email.satisfaction = prevEmailCsat.includes('%') ? prevEmailCsat : prevEmailCsat + '%';
    }
    if (prevObPc)      { data.prev.ob = data.prev.ob || {}; data.prev.ob.weeklyPC = prevObPc; }
    if (prevWeeklyPc)  { data.prev.total = data.prev.total || {}; data.prev.total.weeklyPC = prevWeeklyPc; }
  }

  const html = IS_MONTHLY ? generateMonthlyHTML(data, start, end) : generateHTML(data, start, end);
  const outFile = outArg || path.join(
    process.env.USERPROFILE || process.env.HOME || '.',
    IS_MONTHLY
      ? `monthly_report_${start.slice(0,7)}.html`
      : `weekly_report_${start}_${end.slice(5).replace('-', '')}.html`
  );
  fs.writeFileSync(outFile, html, 'utf8');
  console.log(`Report saved: ${outFile}`);
}

main().catch(e => { console.error(e); process.exit(1); });
