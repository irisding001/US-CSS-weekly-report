/**
 * refresh-session.js
 * 每日运行：用 PASSPORT_SUPERSIG 走 SSO 流程，刷新 PASSPORT_SUPERSIG + EGG_SESS
 * Windows 任务计划每天中午执行
 */
const https   = require('https');
const path    = require('path');
const fs      = require('fs');
const { execSync } = require('child_process');

const ENV_FILE = path.join(__dirname, '.env');

// ── .env 读写 ────────────────────────────────────────────────────────────────
function readEnv() {
  const env = {};
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
    if (m) env[m[1].trim()] = m[2].trim();
  }
  return env;
}

function writeEnv(updates) {
  let src = fs.readFileSync(ENV_FILE, 'utf8');
  for (const [key, val] of Object.entries(updates)) {
    const re = new RegExp(`^(${key}=).*$`, 'm');
    if (re.test(src)) src = src.replace(re, `$1${val}`);
    else src += `\n${key}=${val}`;
  }
  fs.writeFileSync(ENV_FILE, src, 'utf8');
}

// ── HTTP 辅助 ─────────────────────────────────────────────────────────────────
function httpGet(url, cookies) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      headers: { Cookie: cookies, 'User-Agent': 'Mozilla/5.0' },
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function extractCookie(setCookieArr, name) {
  if (!setCookieArr) return null;
  const list = Array.isArray(setCookieArr) ? setCookieArr : [setCookieArr];
  for (const c of list) {
    const m = c.match(new RegExp(`^${name}=([^;]+)`));
    if (m) return m[1];
  }
  return null;
}

// ── 飞书通知 ─────────────────────────────────────────────────────────────────
function sendFeishuAlert(title, body, template = 'red') {
  const content = JSON.stringify({
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: title }, template },
    elements: [{ tag: 'div', text: { tag: 'lark_md', content: body } }],
  });
  try {
    execSync(
      `lark-cli --profile us-ccs im +messages-send ` +
      `--user-id ou_423989c914515582660dfef99848b0e7 ` +
      `--as bot --msg-type interactive --content '${content}'`,
      { stdio: 'pipe' }
    );
  } catch (e) {
    console.error('[WARN] 飞书通知发送失败:', e.message);
  }
}

// ── JWT 到期检测 ───────────────────────────────────────────────────────────────
function checkDataCookieExpiry(dataCookie) {
  if (!dataCookie) {
    sendFeishuAlert(
      '⚠️ US CSS 周报 — DATA_COOKIE 未配置',
      '**DATA_COOKIE 为空**，自动周报将无法运行。\n\n请前往 `us.data.futuoa.com`，F12 → Network → Cookie，复制 `uIdToken=...; uIdToken.sig=...` 到 `.env` 文件。',
      'orange'
    );
    return;
  }

  // 从 Cookie 字符串提取 uIdToken 的 JWT
  const m = dataCookie.match(/uIdToken=([^;]+)/);
  if (!m) return;

  try {
    const [, payload] = m[1].split('.');
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!exp) return;

    const nowSec  = Math.floor(Date.now() / 1000);
    const daysLeft = Math.floor((exp - nowSec) / 86400);
    const expDate  = new Date(exp * 1000).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });

    if (daysLeft < 0) {
      sendFeishuAlert(
        '🚨 US CSS 周报 — DATA_COOKIE 已过期',
        `**uIdToken 已于 ${expDate} 过期**，自动周报将失败。\n\n请立即前往 \`us.data.futuoa.com\`，F12 → Network → Cookie，复制最新 \`uIdToken\` 到 \`.env\`。`,
        'red'
      );
      console.error(`[ERROR] DATA_COOKIE 已过期 (${expDate})`);
    } else if (daysLeft <= 3) {
      sendFeishuAlert(
        `⏰ US CSS 周报 — DATA_COOKIE 还有 ${daysLeft} 天过期`,
        `**uIdToken 将于 ${expDate} 过期**（剩余 ${daysLeft} 天）。\n\n请前往 \`us.data.futuoa.com\`，F12 → Network → Cookie，提前更新 \`.env\` 中的 \`DATA_COOKIE\`。`,
        'orange'
      );
      console.warn(`[WARN] DATA_COOKIE 将于 ${expDate} 过期（还有 ${daysLeft} 天）`);
    } else {
      console.log(`[OK] DATA_COOKIE 有效，到期日: ${expDate}（还有 ${daysLeft} 天）`);
    }
  } catch {}
}

// ── SSO 流程 ──────────────────────────────────────────────────────────────────
async function refreshSession() {
  const env = readEnv();
  const { PASSPORT_SESS_ID, PASSPORT_SUPERSIG } = env;

  if (!PASSPORT_SESS_ID || !PASSPORT_SUPERSIG) {
    console.error('[ERROR] .env 缺少 PASSPORT_SESS_ID 或 PASSPORT_SUPERSIG');
    process.exit(1);
  }

  // Step 1: passport SSO → AUTH_TICKET + new SUPERSIG
  const passportCookies = [
    `PASSPORT_SESS_ID=${PASSPORT_SESS_ID}`,
    `PASSPORT_SUPERSIG=${PASSPORT_SUPERSIG}`,
    'FUTUOA_LANG=zh-cn',
  ].join('; ');

  const returnUrl = encodeURIComponent(
    'https://uscm.futuoa.com/login/oa-callback?ref=' +
    encodeURIComponent('https://uscm.futuoa.com/')
  );

  const r1 = await httpGet(
    `https://passport.futuoa.com/site/login?returnUrl=${returnUrl}`,
    passportCookies
  );

  if (r1.status !== 302) {
    console.error(`[ERROR] Passport SSO 失败 (${r1.status})，SUPERSIG 可能已过期`);
    console.error('请手动从浏览器重新粘贴 PASSPORT_SUPERSIG 到 .env 文件');
    process.exit(1);
  }

  const newSuperSig = extractCookie(r1.headers['set-cookie'], 'PASSPORT_SUPERSIG');
  const location    = r1.headers['location'];

  if (!location || !location.includes('AUTH_TICKET')) {
    console.error('[ERROR] 未获取到 AUTH_TICKET');
    process.exit(1);
  }

  // Step 2: uscm callback → EGG_SESS + csrfToken
  const r2 = await httpGet(location, '');

  const eggSess   = extractCookie(r2.headers['set-cookie'], 'EGG_SESS');
  const csrfToken = extractCookie(r2.headers['set-cookie'], 'csrfToken');
  const staffIdSig = extractCookie(r2.headers['set-cookie'], 'staff_id.sig');

  if (!eggSess || !csrfToken) {
    console.error('[ERROR] 未获取到 EGG_SESS / csrfToken');
    process.exit(1);
  }

  // 写回 .env
  const updates = {
    USCM_COOKIE: `EGG_SESS=${eggSess}; csrfToken=${csrfToken}; staff_id=7328; staff_id.sig=${staffIdSig}`,
    USCM_CSRF:   csrfToken,
  };
  if (newSuperSig) updates.PASSPORT_SUPERSIG = newSuperSig;

  writeEnv(updates);

  const ts = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  console.log(`[OK] Session 刷新成功 @ ${ts}`);
  if (newSuperSig) console.log('[OK] PASSPORT_SUPERSIG 已更新');
  console.log(`[OK] EGG_SESS 已更新 (csrfToken=${csrfToken})`);

  // 检查 DATA_COOKIE 到期，提前提醒
  const latestEnv = readEnv();
  checkDataCookieExpiry(latestEnv.DATA_COOKIE);
}

refreshSession().catch(e => { console.error(e); process.exit(1); });
