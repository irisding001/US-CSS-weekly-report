const fs = require('fs');
const path = require('path');

const dir = path.dirname(__filename);
const files = fs.readdirSync(dir)
  .filter(f => /^weekly_report_\d{4}-\d{2}-\d{2}.*\.html$/.test(f))
  .filter(f => f >= 'weekly_report_2026-06-01')
  .filter(f => {
    // Include Friday-start (Fri~Thu) and Monday-start (Mon~Sun) reports
    const m = f.match(/^weekly_report_(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return false;
    const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
    return d.getUTCDay() === 5 || d.getUTCDay() === 1; // 5=Friday, 1=Monday
  })
  .sort()
  .reverse();

function parseLabel(filename) {
  const base = filename.replace(/\.html$/, '').replace(/^weekly_report_/, '');
  // e.g. "2026-07-20" or "2026-06-26_0702"
  const m = base.match(/^(\d{4})-(\d{2})-(\d{2})(?:_(\d{2})(\d{2}))?/);
  if (!m) return base;
  const start = `${m[2]}-${m[3]}`;
  if (m[4]) return `${start} ~ ${m[4]}-${m[5]}`;
  return `Week of ${start}`;
}

const rows = files.map(f => {
  const label = parseLabel(f);
  return `    <li><a href="${f}">${label}</a></li>`;
}).join('\n');

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>US CSS Weekly Reports</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 60px auto; padding: 0 20px; color: #1a1a2e; }
    h1 { font-size: 22px; color: #1456F0; margin-bottom: 8px; }
    p.sub { font-size: 13px; color: #6b7280; margin-bottom: 28px; }
    ul { list-style: none; padding: 0; }
    li { border-bottom: 1px solid #e5e7eb; }
    li a { display: block; padding: 12px 4px; font-size: 15px; color: #1456F0; text-decoration: none; }
    li a:hover { background: #f0f4ff; border-radius: 4px; }
    li:first-child a { font-weight: 700; }
  </style>
</head>
<body>
  <h1>US CSS Weekly Reports</h1>
  <p class="sub">US Conversion CS Team — Performance Reports</p>
  <ul>
${rows}
  </ul>
</body>
</html>`;

fs.writeFileSync(path.join(dir, 'index.html'), html, 'utf8');
console.log(`index.html updated — ${files.length} reports listed`);
