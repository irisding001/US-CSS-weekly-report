#!/usr/bin/env node
/**
 * Send US CSS Weekly Report notification card to Feishu.
 * Usage: node send_weekly_notify.js [chat_id]
 *   If chat_id is omitted, sends to the group.
 *   If chat_id is an open_id (ou_xxx), sends to that user.
 */
const { execFile } = require('child_process');
const path = require('path');

// ── Config ──────────────────────────────────────────────────────────────────
const PROFILE        = 'us-ccs';  // appId: cli_aa99822db9b8dbd6
const IRIS_OPEN_ID   = 'ou_423989c914515582660dfef99848b0e7';
const GROUP_CHAT_ID  = 'oc_6b53fdf35d29e9203579c4fc7b70acde'; // US CSS Weekly Report 群
const REPORT_URL = 'https://irisding001.github.io/US-CSS-weekly-report/weekly_report_2026-10-16_1022.html';
const HISTORY_URL    = 'https://irisding001.github.io/US-CSS-weekly-report/';
const WEEK_RANGE = 'Oct 16 – Oct 22, 2026';

// ── lark-cli invocation (Windows-safe) ──────────────────────────────────────
const IS_WIN = process.platform === 'win32';
const LARK_CLI = IS_WIN ? process.execPath : 'lark-cli';
const LARK_PREFIX = IS_WIN
  ? [path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@futu', 'ft-lark-cli', 'scripts', 'run.js')]
  : [];

function runLark(args) {
  return new Promise((resolve, reject) => {
    execFile(LARK_CLI, [...LARK_PREFIX, ...args], { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        const msg = stderr || stdout || String(err);
        reject(new Error(msg));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

// ── Card payload (schema 1.0 format) ─────────────────────────────────────────
const card = {
  config: { wide_screen_mode: true },
  header: {
    title: { tag: 'plain_text', content: `US CSS Weekly Report | ${WEEK_RANGE}` },
    template: 'blue'
  },
  elements: [
    {
      tag: 'div',
      text: { tag: 'lark_md', content: '本周报告已更新，含满意度分析及不满意工单分析' }
    },
    {
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '查看周报 View Report' },
          type: 'primary',
          url: REPORT_URL
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '历史周报 History' },
          type: 'default',
          url: HISTORY_URL
        }
      ]
    }
  ]
};

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const target = process.argv[2] || GROUP_CHAT_ID;
  const cardJson = JSON.stringify(card);

  const args = [
    '--profile', PROFILE,
    'im', '+messages-send',
    '--as', 'bot',
    '--msg-type', 'interactive',
    '--content', cardJson,
  ];

  if (target.startsWith('ou_')) {
    args.push('--user-id', target);
    console.log(`Sending to user: ${target}`);
  } else {
    args.push('--chat-id', target);
    console.log(`Sending to group: ${target}`);
  }

  try {
    const result = await runLark(args);
    console.log('Sent OK:', result);
  } catch (err) {
    console.error('Send failed:', err.message);
    process.exit(1);
  }
}

main();
