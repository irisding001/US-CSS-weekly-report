/**
 * collect-input.js
 * 周五 17:00 BT 自动执行：通过飞书 bot 向用户询问本周三/四节内容
 * 由 Windows 任务计划触发
 */
const { spawnSync } = require('child_process');
const path = require('path');
const fs   = require('fs');

const LARK_CLI_JS = path.join(
  process.env.APPDATA, 'npm', 'node_modules', '@futu', 'ft-lark-cli', 'scripts', 'run.js'
);

const DIR         = __dirname;
const MARKER_FILE = path.join(DIR, '.reply-marker.json');
const USER_OPEN_ID = 'ou_423989c914515582660dfef99848b0e7';

function main() {
  const now = new Date();

  const card = JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: 'US CSS 周报 — 请填写本周三/四节内容' },
      template: 'blue',
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: '本周报告将于今晚 **20:00 BT** 自动生成并发送。\n\n请直接回复此消息，按以下格式填写：\n\n【本周重点工作】\n1. \n2. \n\n【下周安排】\n1. \n2. ',
        },
      },
      {
        tag: 'note',
        elements: [{ tag: 'plain_text', content: '若 20:00 前未收到回复，三/四节将保留空白，可在浏览器中直接编辑。' }],
      },
    ],
  });

  const r = spawnSync(process.execPath, [
    LARK_CLI_JS,
    '--profile', 'us-ccs',
    'im', '+messages-send',
    '--user-id', USER_OPEN_ID,
    '--as', 'bot',
    '--msg-type', 'interactive',
    '--content', card,
  ], { encoding: 'utf8' });

  if (r.stdout) console.log(r.stdout);
  if (r.stderr) console.error(r.stderr);

  if (r.status !== 0) {
    console.error(`[ERROR] 飞书消息发送失败 (exit ${r.status})`);
    if (r.error) console.error(r.error);
    process.exit(1);
  }

  fs.writeFileSync(MARKER_FILE, JSON.stringify({ sentAt: now.toISOString() }), 'utf8');

  const ts = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  console.log(`[OK] 三/四节收集消息已发送 @ ${ts}`);
}

main();
