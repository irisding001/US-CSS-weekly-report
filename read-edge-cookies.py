"""
从 Edge Cookies 数据库解密并提取 passport.futuoa.com 的 cookies
写入 .env 中的 PASSPORT_SUPERSIG / PASSPORT_SESS_ID
"""
import os, sys, json, sqlite3, base64, re, ctypes, ctypes.wintypes
from pathlib import Path
from Crypto.Cipher import AES
import win32crypt

EDGE_BASE   = Path(os.environ['LOCALAPPDATA']) / 'Microsoft/Edge/User Data'
LOCAL_STATE = EDGE_BASE / 'Local State'
COOKIES_DB  = EDGE_BASE / 'Default/Network/Cookies'
ENV_FILE    = Path(__file__).parent / '.env'

# ── 用 Windows CreateFile 绕过文件锁读取 ─────────────────────────────────────
def _copy_locked_file(src: Path) -> Path:
    """用 CreateFile + FILE_SHARE_READ|WRITE|DELETE 读取被锁定的文件"""
    kernel32 = ctypes.windll.kernel32

    GENERIC_READ          = 0x80000000
    FILE_SHARE_READ       = 0x00000001
    FILE_SHARE_WRITE      = 0x00000002
    FILE_SHARE_DELETE     = 0x00000004
    OPEN_EXISTING         = 3
    FILE_ATTRIBUTE_NORMAL = 0x80

    handle = kernel32.CreateFileW(
        str(src),
        GENERIC_READ,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        None,
        OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL,
        None,
    )
    INVALID_HANDLE = ctypes.c_void_p(-1).value
    if handle == INVALID_HANDLE:
        raise PermissionError(f'CreateFile 失败: error={kernel32.GetLastError()}')

    try:
        file_size = ctypes.c_int64(0)
        kernel32.GetFileSizeEx(handle, ctypes.byref(file_size))
        size = file_size.value
        buf  = ctypes.create_string_buffer(size)
        read = ctypes.wintypes.DWORD(0)
        kernel32.ReadFile(handle, buf, size, ctypes.byref(read), None)
        data = buf.raw[:read.value]
    finally:
        kernel32.CloseHandle(handle)

    tmp = Path(os.environ['TEMP']) / 'edge_cookies_ro.db'
    tmp.write_bytes(data)
    return tmp

# ── 解密 ─────────────────────────────────────────────────────────────────────
def get_encryption_key():
    with open(LOCAL_STATE, encoding='utf-8') as f:
        state = json.load(f)
    encrypted_key = base64.b64decode(state['os_crypt']['encrypted_key'])
    encrypted_key = encrypted_key[5:]  # 去掉 DPAPI 前缀
    return win32crypt.CryptUnprotectData(encrypted_key, None, None, None, 0)[1]

def decrypt_value(key, encrypted):
    if not encrypted:
        return ''
    if encrypted[:3] in (b'v10', b'v20'):
        iv      = encrypted[3:15]
        payload = encrypted[15:]
        cipher  = AES.new(key, AES.MODE_GCM, nonce=iv)
        try:
            return cipher.decrypt(payload[:-16]).decode('utf-8')
        except Exception:
            return ''
    try:
        return win32crypt.CryptUnprotectData(encrypted, None, None, None, 0)[1].decode('utf-8')
    except Exception:
        return ''

# ── .env 读写 ─────────────────────────────────────────────────────────────────
def read_env():
    env = {}
    for line in ENV_FILE.read_text(encoding='utf-8').splitlines():
        m = re.match(r'^([^#=\s][^=]*)=(.*)$', line)
        if m:
            env[m.group(1).strip()] = m.group(2).strip()
    return env

def write_env(updates):
    src = ENV_FILE.read_text(encoding='utf-8')
    for key, val in updates.items():
        pattern = re.compile(rf'^({re.escape(key)}=).*$', re.MULTILINE)
        if pattern.search(src):
            src = pattern.sub(rf'\g<1>{val}', src)
        else:
            src += f'\n{key}={val}'
    ENV_FILE.write_text(src, encoding='utf-8')

# ── 主流程 ────────────────────────────────────────────────────────────────────
def main():
    key = get_encryption_key()

    print('[1] 读取 Edge Cookies 数据库...')
    tmp_db = _copy_locked_file(COOKIES_DB)

    con = sqlite3.connect(str(tmp_db))
    cur = con.cursor()
    cur.execute(
        "SELECT name, encrypted_value FROM cookies WHERE host_key LIKE '%futuoa.com%'"
    )
    rows = cur.fetchall()
    con.close()
    tmp_db.unlink(missing_ok=True)

    found = {}
    for name, enc_val in rows:
        val = decrypt_value(key, enc_val)
        if val:
            found[name] = val

    print(f'[INFO] futuoa.com cookies: {list(found.keys())}')

    supersig = found.get('PASSPORT_SUPERSIG')
    sess_id  = found.get('PASSPORT_SESS_ID')

    if not supersig:
        print('[ERROR] 未找到 PASSPORT_SUPERSIG（可能是未持久化的 session cookie）')
        print('所有找到的 cookie 名称:', list(found.keys()))
        sys.exit(1)

    updates = {'PASSPORT_SUPERSIG': supersig}
    if sess_id:
        updates['PASSPORT_SESS_ID'] = sess_id
        print('[OK] PASSPORT_SESS_ID 已更新')

    write_env(updates)
    print(f'[OK] PASSPORT_SUPERSIG 已写入 .env（{supersig[:20]}...）')

if __name__ == '__main__':
    main()
