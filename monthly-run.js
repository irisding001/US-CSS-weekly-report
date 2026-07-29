'use strict';
/**
 * monthly-run.js
 * Wrapper around run.js for full-month reports.
 * Usage: node monthly-run.js [--month YYYY-MM] [all run.js args except --week-start/end/ob-start/ob-end]
 *
 * --month YYYY-MM  Target month (default: last completed calendar month in BT)
 */
const { spawnSync } = require('child_process');
const path = require('path');
const fs   = require('fs');

const args   = process.argv.slice(2);
const getArg = f => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; };

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

const { start, end, label } = getMonthRange();
const outFile = getArg('--out') || `C:/Users/irisding/monthly_report_${label}.html`;

// Build run.js args: inject month range, pass through everything else
const runArgs = [
  path.join(__dirname, 'run.js'),
  '--week-start', start,
  '--week-end',   end,
  '--ob-start',   start,
  '--ob-end',     end,
  '--out',        outFile,
];

// Forward all args except those we control
const skip = new Set(['--month', '--week-start', '--week-end', '--ob-start', '--ob-end', '--out']);
let i = 0;
while (i < args.length) {
  if (skip.has(args[i])) { i += 2; continue; }
  runArgs.push(args[i++]);
}

console.log(`=== US CSS Monthly Report: ${start} ~ ${end} ===`);
const r = spawnSync(process.execPath, runArgs, { stdio: 'inherit' });
if (r.status !== 0) process.exit(r.status || 1);

// Patch title
if (fs.existsSync(outFile)) {
  let html = fs.readFileSync(outFile, 'utf8');
  html = html.replace(/US CSS Weekly Report/g, 'US CSS Monthly Report');
  html = html.replace(/<title>US CSS Weekly Report/, '<title>US CSS Monthly Report');
  fs.writeFileSync(outFile, html);
  console.log(`[OK] Saved: ${outFile}`);
}
