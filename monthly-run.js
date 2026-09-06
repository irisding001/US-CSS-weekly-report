'use strict';
/**
 * monthly-run.js
 * Wrapper around run.js for full-month reports.
 * Usage: node monthly-run.js [--month YYYY-MM] [all run.js args except --week-start/end/ob-start/ob-end]
 *
 * --month YYYY-MM  Target month (default: last completed calendar month in BT)
 *
 * Auto-fetches from BI (us.data.futuoa.com) unless manually overridden:
 *   --agent-consult-pc, --agent-monthly-consult-pc
 */
const { spawnSync } = require('child_process');
const path = require('path');
const fs   = require('fs');
const https = require('https');

const args   = process.argv.slice(2);
const getArg = f => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; };
const hasArg = f => args.includes(f);

function getMonthRange() {
  const monthArg = getArg('--month');
  if (monthArg) {
    const [y, m] = monthArg.split('-').map(Number);
    const start   = `${y}-${String(m).padStart(2,'0')}-01`;
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const end     = `${y}-${String(m).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;
    return { start, end, label: monthArg };
  }
  // Default: last completed month in Beijing Time
  const bt   = new Date(Date.now() + 8 * 3600000);
  const m0   = bt.getUTCMonth(); // 0-indexed current month
  const y0   = bt.getUTCFullYear();
  const lastM = m0 === 0 ? 12 : m0;
  const lastY = m0 === 0 ? y0 - 1 : y0;
  const start   = `${lastY}-${String(lastM).padStart(2,'0')}-01`;
  const lastDay = new Date(Date.UTC(lastY, lastM, 0)).getUTCDate();
  const end     = `${lastY}-${String(lastM).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;
  return { start, end, label: `${lastY}-${String(lastM).padStart(2,'0')}` };
}

function nonce(n = 26) {
  const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let r = '';
  for (let i = 0; i < n; i++) r += c[Math.floor(Math.random() * c.length)];
  return r;
}

function fetchBiAgentPC(monthLabel) {
  return new Promise((resolve, reject) => {
    // Read uIdToken from DATA_COOKIE in .env
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return reject(new Error('.env not found'));
    const envContent = fs.readFileSync(envPath, 'utf8');
    const m = envContent.match(/uIdToken=([^;\s\n]+)/);
    if (!m) return reject(new Error('uIdToken not found in .env DATA_COOKIE'));
    const token = m[1];

    const body = JSON.stringify({
      offset: 0, limit: 200,
      filters: [
        { name: '地区', fdId: 'l08320afe361b46ed9294ac3', dsId: 'ic06ff886844c4de6a191268',
          cdId: 'q675815b12e4246afa871c94', fdType: 'STRING', filterType: 'IN',
          originFilterType: 'IN', sourceCdId: 'v2b5d7057116345b382d8227',
          filterValue: ['US'], displayValue: ['US'] },
        { name: '员工最小组织', fdId: 'f3920cbb150fc404ab03a427', dsId: 'ic06ff886844c4de6a191268',
          cdId: 'q675815b12e4246afa871c94', fdType: 'STRING', filterType: 'IN',
          originFilterType: 'IN', sourceCdId: 'cbaf52bc16be54f368b0e1d9',
          filterValue: ['美国转化客服组'], displayValue: [] },
        { name: '统计月', fdId: 'ef5d2727150b142299080061_month', dsId: 'ic06ff886844c4de6a191268',
          cdId: 'q675815b12e4246afa871c94', fdType: 'SUB_DATE', filterType: 'IN',
          originFilterType: 'IN', sourceCdId: 'aabbf61e1b0d04975b0bee0a',
          filterValue: [monthLabel], displayValue: [monthLabel] }
      ],
      treeFilters: [], dynamicParams: [], dynamicFieldFilters: [],
      combinationFilters: [], layerTreeFilters: [],
      headerSortings: null, rowExpand: null, sorting: [],
      name: '报表',
      zoneFilter: { zoneData: {
        row: [{ fdId: 'k6e417652a5be4714ad8b8e7', name: '处理人显示名：英文名（中文）',
          alias: '客服', fdType: 'STRING', metaType: 'DIM', isAggregated: false,
          calculationType: 'normal', baseFdType: 'STRING', key: 'LyYTiKHlXjqFJHGogwBrEVMv',
          level: 'dataset', annotation: '处理人显示名：英文名（中文）',
          dsId: 'ic06ff886844c4de6a191268', nameTranslated: '客服', zoneId: 'row' }],
        column: [{ name: '度量名', metaType: 'MPH', key: 'hWfrOKnIhVfPaymcQDxqjYfA',
          nameTranslated: '度量名', alias: '度量名' }],
        metric: [
          { fdId: 'u7dd6900b4faf4023831bcdb', name: '客服侧已转化 PC 数', fdType: 'LONG',
            metaType: 'METRIC', aggrType: 'SUM', isAggregated: false, calculationType: 'normal',
            baseFdType: 'LONG', key: 'hHqhiTQbcPQTSNXPapyQxxMI', level: 'dataset',
            dsId: 'ic06ff886844c4de6a191268' }
        ],
        sorting: []
      }},
      taskRequestId: nonce()
    });

    const opts = {
      hostname: 'us.data.futuoa.com',
      path: '/api/card/q675815b12e4246afa871c94/data?v=' + nonce(),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Cookie': 'uIdToken=' + token,
        'raw-backend-response': 'TRUE',
        'user-id': 'aXJpc2Rpbmc=',
        'x-dom-id': 'Z3VhbmJp',
        'referer': 'https://us.data.futuoa.com/page/md4204d8939874f5b83b99d0'
      }
    };

    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          if (j.result !== 'ok') return reject(new Error('BI API error: ' + (j.error || {}).message));
          const cm = j.response.chartMain;
          const result = {};
          cm.row.values.forEach((rv, i) => {
            // Extract username from pattern "English Name（username）" or "Chinese Name（username）"
            const title = rv[0].title || '';
            const match = title.match(/（([^）]+)）$/);
            if (!match) return;
            const username = match[1].trim();
            const csPC = (cm.data[i][0] || {}).v || 0;
            result[username] = csPC;
          });
          resolve(result);
        } catch (e) {
          reject(new Error('BI parse error: ' + e.message + ' raw: ' + d.slice(0, 200)));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const { start, end, label } = getMonthRange();
const outFile = getArg('--out') || `C:/Users/irisding/monthly_report_${label}.html`;

async function main() {
  // Auto-fetch agent consult PC from BI if not manually provided
  let agentConsultPcStr = getArg('--agent-consult-pc');
  let agentMonthlyConsultPcStr = getArg('--agent-monthly-consult-pc');

  if (!agentConsultPcStr) {
    console.log(`[BI] Fetching agent consult PC for ${label}...`);
    try {
      const agentPC = await fetchBiAgentPC(label);
      const pcStr = Object.entries(agentPC).map(([k,v]) => `${k}=${v}`).join(',');
      if (pcStr) {
        agentConsultPcStr = pcStr;
        agentMonthlyConsultPcStr = agentMonthlyConsultPcStr || pcStr;
        console.log('[BI] agent-consult-pc:', pcStr);
      } else {
        console.warn('[BI] Warning: no agent PC data returned');
      }
    } catch (e) {
      console.warn('[BI] Warning: failed to fetch agent PC:', e.message);
      console.warn('[BI] Proceeding without auto-fetch; use --agent-consult-pc to override');
    }
  }

  // Build run.js args: inject month range, pass through everything else
  const runArgs = [
    path.join(__dirname, 'run.js'),
    '--week-start', start,
    '--week-end',   end,
    '--ob-start',   start,
    '--ob-end',     end,
    '--out',        outFile,
    '--monthly',
  ];

  if (agentConsultPcStr) {
    runArgs.push('--agent-consult-pc', agentConsultPcStr);
  }
  if (agentMonthlyConsultPcStr) {
    runArgs.push('--agent-monthly-consult-pc', agentMonthlyConsultPcStr);
  }

  // Forward all args except those we control
  const skip = new Set(['--month', '--week-start', '--week-end', '--ob-start', '--ob-end', '--out',
    '--agent-consult-pc', '--agent-monthly-consult-pc']);
  let i = 0;
  while (i < args.length) {
    if (skip.has(args[i])) { i += 2; continue; }
    runArgs.push(args[i++]);
  }

  // Parse .env and pass credentials as environment variables to run.js
  const envVars = {};
  const envPath2 = path.join(__dirname, '.env');
  if (fs.existsSync(envPath2)) {
    for (const line of fs.readFileSync(envPath2, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
      if (m) envVars[m[1].trim()] = m[2].trim();
    }
  }
  const spawnEnv = { ...process.env, ...envVars };

  console.log(`=== US CSS Monthly Report: ${start} ~ ${end} ===`);
  const r = spawnSync(process.execPath, runArgs, { stdio: 'inherit', env: spawnEnv });
  if (r.status !== 0) process.exit(r.status || 1);

  // Patch title and monthly-specific column hiding
  if (fs.existsSync(outFile)) {
    let html = fs.readFileSync(outFile, 'utf8');
    html = html.replace(/US CSS Weekly Report/g, 'US CSS Monthly Report');
    html = html.replace(/<title>US CSS Weekly Report/, '<title>US CSS Monthly Report');
    html = html.replace('</head>', `<style>
table.team-summary td:nth-child(4),table.team-summary th:nth-child(4){display:none}
[data-col="consultpc"],[data-col="salespc"]{display:none}
</style></head>`);
    fs.writeFileSync(outFile, html);
    console.log(`[OK] Saved: ${outFile}`);
  }
}

main().catch(e => { console.error('[ERROR]', e.message); process.exit(1); });
