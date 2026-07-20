/**
 * auto-report.js
 * 周五 20:00 BT 自动执行：刷新 session → 读取飞书回复 → 生成报告 → 推 GitHub Pages → 飞书通知
 * 由 Windows 任务计划触发
 */
const { execSync, spawnSync } = require('child_process');
const path = require('path');
const fs   = require('fs');

const DIR         = __dirname;
const ENV_FILE    = path.join(DIR, '.env');
const MARKER_FILE = path.join(DIR, '.reply-marker.json');
const REPO_DIR    = 'C:/Users/irisding/US-CSS-weekly-report';
const USER_OPEN_ID = 'ou_423989c914515582660dfef99848b0e7';
const LARK_CLI_JS  = path.join(
  process.env.APPDATA, 'npm', 'node_modules', '@futu', 'ft-lark-cli', 'scripts', 'run.js'
);

// ── 飞书通知 ─────────────────────────────────────────────────────────────────
function sendFeishuAlert(title, body, template = 'red') {
  const content = JSON.stringify({
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: title }, template },
    elements: [{ tag: 'div', text: { tag: 'lark_md', content: body } }],
  });
  try {
    const r = spawnSync(process.execPath, [
      LARK_CLI_JS, '--profile', 'us-ccs', 'im', '+messages-send',
      '--user-id', USER_OPEN_ID, '--as', 'bot',
      '--msg-type', 'interactive', '--content', content,
    ], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  } catch (e) {
    console.error('[WARN] 飞书通知发送失败:', e.message);
  }
}

// ── .env 读取 ─────────────────────────────────────────────────────────────────
function readEnv() {
  const env = {};
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
    if (m) env[m[1].trim()] = m[2].trim();
  }
  return env;
}

// ── 日期计算（北京时间） ────────────────────────────────────────────────────────
function getWeekRange() {
  const now = new Date();
  const bt  = new Date(now.getTime() + 8 * 3600000);
  const dow = bt.getUTCDay();

  const daysToLastFri = (dow >= 5) ? (dow - 5) : (dow + 2);
  const fri = new Date(bt);
  fri.setUTCDate(bt.getUTCDate() - daysToLastFri);
  const weekStart = fri.toISOString().slice(0, 10);

  const thu = new Date(fri);
  thu.setUTCDate(fri.getUTCDate() + 6);
  const weekEnd = thu.toISOString().slice(0, 10);

  return { weekStart, weekEnd };
}

function run(cmd, opts = {}) {
  console.log(`$ ${cmd}`);
  return execSync(cmd, { stdio: 'inherit', shell: true, ...opts });
}

// ── 读取飞书回复（四/五节） ───────────────────────────────────────────────────
function readFeishuReply() {
  if (!fs.existsSync(MARKER_FILE)) {
    console.log('[INFO] 未找到 17:00 收集标记，跳过内容读取');
    return null;
  }

  let sentAt;
  try {
    ({ sentAt } = JSON.parse(fs.readFileSync(MARKER_FILE, 'utf8')));
  } catch {
    return null;
  }

  let raw;
  try {
    const lr = spawnSync(process.execPath, [
      LARK_CLI_JS, '--profile', 'us-ccs', 'im', '+chat-messages-list',
      '--user-id', USER_OPEN_ID, '--as', 'bot',
      '--start', sentAt, '--sort', 'asc', '--page-size', '20', '--format', 'json',
    ], { encoding: 'utf8' });
    if (lr.status !== 0) throw new Error(lr.stderr || lr.stdout);
    raw = lr.stdout;
  } catch (e) {
    console.error('[WARN] 读取飞书回复失败:', e.message);
    return null;
  }

  let data;
  try { data = JSON.parse(raw); } catch { return null; }

  const items = Array.isArray(data) ? data : (data.items || data.data?.items || []);

  // 只取用户发送的消息（排除 bot 自身）
  const userMsgs = items.filter(m => m.sender?.sender_type === 'user');
  if (!userMsgs.length) {
    console.log('[INFO] 未收到用户回复，四/五节保留空白占位');
    return null;
  }

  // 取最新一条
  const last = userMsgs[userMsgs.length - 1];
  let text = '';
  try {
    const parsed = JSON.parse(last.body?.content || '{}');
    text = parsed.text || '';
  } catch {
    text = last.body?.content || '';
  }

  const highlights = extractSection(text, '【本周重点工作】', '【下周安排】');
  const plans      = extractSection(text, '【下周安排】', null);

  if (!highlights && !plans) {
    console.log('[INFO] 回复未匹配格式，四/五节保留空白占位');
    return null;
  }

  // 清理标记文件
  try { fs.unlinkSync(MARKER_FILE); } catch {}

  console.log('[OK] 已读取四/五节用户回复');
  return { highlights, plans };
}

function extractSection(text, startMarker, endMarker) {
  const si = text.indexOf(startMarker);
  if (si === -1) return '';
  const after = text.slice(si + startMarker.length);
  if (!endMarker) return after.trim();
  const ei = after.indexOf(endMarker);
  return (ei === -1 ? after : after.slice(0, ei)).trim();
}

// ── 主流程 ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== US CSS Auto Report ===');

  // 1. 刷新 session
  console.log('\n[1/5] 刷新 Session...');
  const r = spawnSync(process.execPath, [path.join(DIR, 'refresh-session.js')], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error('[ERROR] Session 刷新失败，请检查 .env 中的凭证');
    process.exit(1);
  }

  // 2. 验证 DATA_COOKIE
  const env = readEnv();
  const { DATA_COOKIE, USCM_COOKIE, USCM_CSRF } = env;

  if (!DATA_COOKIE) {
    sendFeishuAlert(
      '🚨 US CSS 周报自动发送失败 — DATA_COOKIE 未配置',
      '**DATA_COOKIE 为空**，本周报告无法生成。\n\n请前往 `us.data.futuoa.com`，F12 → Network → Cookie，复制 `uIdToken=...` 到 `.env` 文件，重新运行即可。',
      'red'
    );
    console.error('[ERROR] DATA_COOKIE 为空');
    process.exit(1);
  }

  const jwtMatch = DATA_COOKIE.match(/uIdToken=([^;]+)/);
  if (jwtMatch) {
    try {
      const [, payload] = jwtMatch[1].split('.');
      const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      const daysLeft = exp ? Math.floor((exp - Date.now() / 1000) / 86400) : Infinity;
      if (daysLeft < 0) {
        const expDate = new Date(exp * 1000).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
        sendFeishuAlert(
          '🚨 US CSS 周报自动发送失败 — DATA_COOKIE 已过期',
          `**uIdToken 已于 ${expDate} 过期**，本周报告无法生成。\n\n请立即更新 \`.env\` 中的 \`DATA_COOKIE\`。`,
          'red'
        );
        console.error('[ERROR] DATA_COOKIE 已过期');
        process.exit(1);
      }
    } catch {}
  }

  // 3. 读取飞书四/五节回复
  console.log('\n[2/5] 读取飞书四/五节回复...');
  const reply = readFeishuReply();

  // 4. 生成报告
  const { weekStart, weekEnd } = getWeekRange();
  const endTag  = weekEnd.slice(5).replace('-', '');
  const outFile = `C:/Users/irisding/weekly_report_${weekStart}_${endTag}.html`;

  console.log(`\n[3/5] 生成报告 ${weekStart} ~ ${weekEnd}...`);
  run(
    `DATA_COOKIE="${DATA_COOKIE}" USCM_COOKIE="${USCM_COOKIE}" USCM_CSRF="${USCM_CSRF}" ` +
    `node "${path.join(DIR, 'run.js')}" --week-start ${weekStart} --out "${outFile}"`
  );

  // 注入四/五节
  if (reply && (reply.highlights || reply.plans)) {
    let html = fs.readFileSync(outFile, 'utf8');
    if (reply.highlights) html = html.replace('请填写本周重点工作...', reply.highlights);
    if (reply.plans)      html = html.replace('请填写下周安排...', reply.plans);
    fs.writeFileSync(outFile, html, 'utf8');
    console.log('[OK] 四/五节内容已写入报告');
  }

  // 5. 推送 GitHub Pages
  console.log('\n[4/5] 推送 GitHub Pages...');
  const filename = path.basename(outFile);
  run(`cp "${outFile}" "${REPO_DIR}/"`);
  run(`cd "${REPO_DIR}" && git add "${filename}" && git commit -m "Add US CSS weekly report ${weekStart} ~ ${weekEnd}" && git push origin main`);

  // 6. 飞书通知
  console.log('\n[5/5] 飞书通知...');
  const startMD  = weekStart.slice(5).replace('-', '-');
  const endMD    = weekEnd.slice(5).replace('-', '-');
  const pageUrl  = `https://irisding001.github.io/US-CSS-weekly-report/${filename}`;
  const histUrl  = 'https://irisding001.github.io/US-CSS-weekly-report/';
  const hasReply = !!(reply?.highlights || reply?.plans);

  const card = JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `US CSS Weekly Report | ${startMD} ~ ${endMD}` },
      template: 'blue',
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: hasReply
            ? '✅ 四/五节内容已自动填入'
            : '⚠️ 未收到四/五节回复，可在浏览器中直接编辑',
        },
      },
      {
        tag: 'action',
        actions: [
          { tag: 'button', text: { tag: 'plain_text', content: '点击查看' }, type: 'primary', url: pageUrl },
          { tag: 'button', text: { tag: 'plain_text', content: '查看历史周报' }, type: 'default', url: histUrl },
        ],
      },
    ],
  });

  const nr = spawnSync(process.execPath, [
    LARK_CLI_JS, '--profile', 'us-ccs', 'im', '+messages-send',
    '--user-id', USER_OPEN_ID, '--as', 'bot',
    '--msg-type', 'interactive', '--content', card,
  ], { encoding: 'utf8', stdio: 'inherit' });
  if (nr.status !== 0) throw new Error('飞书通知发送失败');

  console.log(`\n✓ 完成！报告已发布：${pageUrl}`);
}

main().catch(e => { console.error(e); process.exit(1); });
