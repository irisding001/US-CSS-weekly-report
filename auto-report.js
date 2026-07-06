/**
 * auto-report.js
 * 周五 20:00 BT 自动执行：刷新 session → 生成报告 → 推 GitHub Pages → 飞书通知
 * 由 Windows 任务计划触发
 */
const { execSync, spawnSync } = require('child_process');
const path = require('path');
const fs   = require('fs');

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

const DIR      = __dirname;
const ENV_FILE = path.join(DIR, '.env');
const REPO_DIR = 'C:/Users/irisding/us-css-weeklyreport';

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
  const bt  = new Date(now.getTime() + 8 * 3600000); // UTC → BT
  const dow = bt.getUTCDay(); // 0=Sun … 5=Fri … 6=Sat

  // 上一个（或当前）周五
  const daysToLastFri = (dow >= 5) ? (dow - 5) : (dow + 2);
  const fri = new Date(bt);
  fri.setUTCDate(bt.getUTCDate() - daysToLastFri);
  const weekStart = fri.toISOString().slice(0, 10);

  // 周四 = weekStart + 6 天
  const thu = new Date(fri);
  thu.setUTCDate(fri.getUTCDate() + 6);
  const weekEnd = thu.toISOString().slice(0, 10);

  return { weekStart, weekEnd };
}

function run(cmd, opts = {}) {
  console.log(`$ ${cmd}`);
  return execSync(cmd, { stdio: 'inherit', shell: true, ...opts });
}

// ── 主流程 ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== US CSS Auto Report ===');

  // 1. 刷新 session
  console.log('\n[1/4] 刷新 Session...');
  const r = spawnSync('node', [path.join(DIR, 'refresh-session.js')], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error('[ERROR] Session 刷新失败，请检查 .env 中的凭证');
    process.exit(1);
  }

  // 2. 读取最新凭证并生成报告
  const env = readEnv();
  const { DATA_COOKIE, USCM_COOKIE, USCM_CSRF } = env;

  if (!DATA_COOKIE) {
    const msg = '**DATA_COOKIE 为空**，本周报告无法生成。\n\n请前往 `us.data.futuoa.com`，F12 → Network → Cookie，复制 `uIdToken=...` 到 `.env` 文件，重新运行即可。';
    sendFeishuAlert('🚨 US CSS 周报自动发送失败 — DATA_COOKIE 未配置', msg, 'red');
    console.error('[ERROR] DATA_COOKIE 为空');
    process.exit(1);
  }

  // 检查 DATA_COOKIE 是否即将过期
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

  const { weekStart, weekEnd } = getWeekRange();
  const endTag  = weekEnd.slice(5).replace('-', '');
  const outFile = `C:/Users/irisding/weekly_report_${weekStart}_${endTag}.html`;

  console.log(`\n[2/4] 生成报告 ${weekStart} ~ ${weekEnd}...`);
  run(
    `DATA_COOKIE="${DATA_COOKIE}" USCM_COOKIE="${USCM_COOKIE}" USCM_CSRF="${USCM_CSRF}" ` +
    `node "${path.join(DIR, 'run.js')}" --week-start ${weekStart} --out "${outFile}"`
  );

  // 3. 推送 GitHub Pages
  console.log('\n[3/4] 推送 GitHub Pages...');
  const filename = path.basename(outFile);
  run(`cp "${outFile}" "${REPO_DIR}/"`);
  run(`cd "${REPO_DIR}" && git add "${filename}" && git commit -m "Add US CSS weekly report ${weekStart} ~ ${weekEnd}" && git push origin main`);

  // 4. 飞书通知
  console.log('\n[4/4] 飞书通知...');
  const startMD = weekStart.slice(5).replace('-', '-');
  const endMD   = weekEnd.slice(5).replace('-', '-');
  const pageUrl = `https://irisding001.github.io/us-css-weeklyreport/${filename}`;
  const histUrl = 'https://irisding001.github.io/us-css-weeklyreport/';

  const content = JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `US CSS Weekly Report | ${startMD} ~ ${endMD}` },
      template: 'blue',
    },
    elements: [{
      tag: 'action',
      actions: [
        { tag: 'button', text: { tag: 'plain_text', content: '点击查看' }, type: 'primary', url: pageUrl },
        { tag: 'button', text: { tag: 'plain_text', content: '查看历史周报' }, type: 'default', url: histUrl },
      ],
    }],
  });

  run(
    `lark-cli --profile us-ccs im +messages-send ` +
    `--user-id ou_423989c914515582660dfef99848b0e7 ` +
    `--as bot --msg-type interactive --content '${content}'`
  );

  console.log(`\n✓ 完成！报告已发布：${pageUrl}`);
  console.log('提示：第三、四节可在浏览器中直接编辑');
}

main().catch(e => { console.error(e); process.exit(1); });
