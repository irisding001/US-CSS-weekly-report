/**
 * extract-supersig.js
 * 用 Edge CDP 远程调试协议自动提取 PASSPORT_SUPERSIG，无需手动复制
 * 流程：启动 Edge（带用户 profile + 调试端口）→ 访问 passport.futuoa.com → 抓 cookie → 写入 .env
 */
const { execFile, exec } = require('child_process');
const http  = require('http');
const https = require('https');
const net   = require('net');
const fs    = require('fs');
const path  = require('path');

const ENV_FILE    = path.join(__dirname, '.env');
const EDGE_EXE    = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const DEBUG_PORT  = 9355; // 避免与现有 Edge 冲突
const USER_DATA   = `C:/Users/irisding/AppData/Local/Microsoft/Edge/User Data`;
const PASSPORT_URL = 'https://passport.futuoa.com/';

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

// ── 等待端口就绪 ──────────────────────────────────────────────────────────────
function waitForPort(port, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    function attempt() {
      const sock = new net.Socket();
      sock.setTimeout(500);
      sock.connect(port, '127.0.0.1', () => { sock.destroy(); resolve(); });
      sock.on('error', () => {
        sock.destroy();
        if (Date.now() - start > timeout) reject(new Error('Edge 启动超时'));
        else setTimeout(attempt, 300);
      });
      sock.on('timeout', () => {
        sock.destroy();
        if (Date.now() - start > timeout) reject(new Error('Edge 启动超时'));
        else setTimeout(attempt, 300);
      });
    }
    attempt();
  });
}

// ── HTTP GET（返回 body 字符串）────────────────────────────────────────────────
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

// ── WebSocket 发送 CDP 命令 ────────────────────────────────────────────────────
function cdpCall(wsUrl, method, params = {}) {
  return new Promise((resolve, reject) => {
    const { hostname, port, pathname } = new URL(wsUrl);
    const key = Buffer.from(Math.random().toString()).toString('base64');

    const req = http.request({
      hostname, port: port || 80, path: pathname,
      headers: {
        'Upgrade': 'websocket',
        'Connection': 'Upgrade',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
      },
    });

    req.on('upgrade', (res, socket) => {
      const id = 1;
      const msg = JSON.stringify({ id, method, params });
      // WebSocket frame: FIN + opcode 1 (text), masked
      const payload = Buffer.from(msg);
      const maskKey = Buffer.from([0x01, 0x02, 0x03, 0x04]);
      const masked  = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ maskKey[i % 4];
      const header = Buffer.alloc(payload.length < 126 ? 6 : 8);
      header[0] = 0x81;
      if (payload.length < 126) {
        header[1] = 0x80 | payload.length;
        maskKey.copy(header, 2);
      } else {
        header[1] = 0x80 | 126;
        header.writeUInt16BE(payload.length, 2);
        maskKey.copy(header, 4);
      }
      socket.write(Buffer.concat([header, masked]));

      let buf = Buffer.alloc(0);
      socket.on('data', chunk => {
        buf = Buffer.concat([buf, chunk]);
        // parse frame
        if (buf.length < 2) return;
        const fin  = (buf[0] & 0x80) !== 0;
        const opcode = buf[0] & 0x0f;
        if (opcode === 8) { socket.destroy(); return; } // close
        const masked2 = (buf[1] & 0x80) !== 0;
        let payloadLen = buf[1] & 0x7f;
        let offset = 2;
        if (payloadLen === 126) { payloadLen = buf.readUInt16BE(2); offset = 4; }
        if (buf.length < offset + payloadLen) return;
        let data = buf.slice(offset, offset + payloadLen);
        if (masked2) {
          const mk = buf.slice(offset, offset + 4);
          data = buf.slice(offset + 4, offset + 4 + payloadLen);
          for (let i = 0; i < data.length; i++) data[i] ^= mk[i % 4];
        }
        try {
          const result = JSON.parse(data.toString());
          if (result.id === id) { socket.destroy(); resolve(result.result); }
        } catch {}
      });
      socket.on('error', reject);
      setTimeout(() => { socket.destroy(); reject(new Error('CDP 超时')); }, 10000);
    });
    req.on('error', reject);
    req.end();
  });
}

// ── 主流程 ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('[1] 启动 Edge（调试模式）...');

  // 用独立 profile 目录避免与正在运行的 Edge 冲突
  const debugProfile = path.join(process.env.TEMP, 'edge-supersig-debug');

  const edgeProc = execFile(EDGE_EXE, [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${USER_DATA}`,  // 使用真实 profile，cookie 已登录
    '--profile-directory=Default',
    '--no-first-run',
    '--no-default-browser-check',
    PASSPORT_URL,
  ], { detached: true });

  edgeProc.unref();

  console.log('[2] 等待调试端口就绪...');
  await waitForPort(DEBUG_PORT);
  await new Promise(r => setTimeout(r, 2000)); // 等页面加载

  console.log('[3] 获取调试目标列表...');
  const targetsJson = await httpGet(`http://localhost:${DEBUG_PORT}/json`);
  const targets = JSON.parse(targetsJson);

  // 找到 passport.futuoa.com 的 tab
  let target = targets.find(t => t.url && t.url.includes('passport.futuoa.com'));
  if (!target) {
    // 用第一个可用 target
    target = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
  }
  if (!target || !target.webSocketDebuggerUrl) {
    throw new Error('找不到可用的调试 target，请确认 Edge 已打开');
  }

  console.log(`[4] 连接到: ${target.url}`);
  const wsUrl = target.webSocketDebuggerUrl;

  // 先导航到 passport.futuoa.com
  try {
    await cdpCall(wsUrl, 'Page.navigate', { url: PASSPORT_URL });
    await new Promise(r => setTimeout(r, 3000));
  } catch (e) {
    console.warn('[WARN] 导航指令失败（可能页面已在 passport）:', e.message);
  }

  // 获取 cookies
  console.log('[5] 提取 cookies...');
  const result = await cdpCall(wsUrl, 'Network.getAllCookies');
  if (!result || !result.cookies) throw new Error('无法获取 cookies');

  const cookies = result.cookies;
  const superSig  = cookies.find(c => c.name === 'PASSPORT_SUPERSIG'  && c.domain.includes('futuoa.com'));
  const sessId    = cookies.find(c => c.name === 'PASSPORT_SESS_ID'   && c.domain.includes('futuoa.com'));

  if (!superSig) {
    console.error('[ERROR] 未找到 PASSPORT_SUPERSIG cookie');
    console.log('可用的 futuoa.com cookies:', cookies.filter(c => c.domain.includes('futuoa')).map(c => c.name).join(', '));
    process.exit(1);
  }

  console.log(`[OK] PASSPORT_SUPERSIG = ${superSig.value.substring(0, 20)}...`);

  const updates = { PASSPORT_SUPERSIG: superSig.value };
  if (sessId) {
    updates.PASSPORT_SESS_ID = sessId.value;
    console.log(`[OK] PASSPORT_SESS_ID 也已更新`);
  }

  writeEnv(updates);
  console.log('[OK] .env 已更新');

  // 关闭调试 Edge（用 taskkill 关闭对应端口的进程）
  exec(`for /f "tokens=5" %a in ('netstat -ano ^| findstr :${DEBUG_PORT}') do taskkill /F /PID %a`, { shell: 'cmd.exe' });
}

main().catch(e => {
  console.error('[ERROR]', e.message);
  process.exit(1);
});
