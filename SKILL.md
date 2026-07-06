---
name: US-CSS-weekly-report
description: US CSS 团队周报生成器（12人 Conversion CS Team，四模块：LC/Phone/Email/Outbound）。自动拉取 BI 数据，生成 HTML 周报，推送 GitHub Pages + 飞书通知。当用户提到"周报"、"weekly report"、"CSS 周报"、"填周报"、"写周报"时使用。
---

# US CSS Weekly Report — 四模块 HTML 周报

周期：**周五 ~ 周四（北京时间 UTC+8）**

## 团队成员（12人）

jacelynlim / terrychen / muhamadfaisal / calventan / azamuddin / jeanliew / whitneylee / alvinsim / zaydentan / vincentyew / wilsonwong / zyonnleong

---

## 自动化模式（推荐）

已配置 Windows 任务计划，无需手动操作：

| 任务 | 脚本 | 时间 |
|------|------|------|
| `USCSSRefreshSession` | `refresh-session.js` | 每天 12:00 BT |
| `USCSSWeeklyReport` | `auto-report.js` | 每周五 20:00 BT |

**首次注册**（右键 → 以管理员身份运行）：
```
C:\Users\irisding\.claude\skills\US-CCS-weekly-report\setup-tasks.bat
```

### 凭证管理（`.env` 文件）

路径：`C:\Users\irisding\.claude\skills\US-CCS-weekly-report\.env`

| 变量 | 来源 | 更新频率 |
|------|------|----------|
| `PASSPORT_SESS_ID` | passport.futuoa.com 登录后 | 数周有效，手动更新 |
| `PASSPORT_SUPERSIG` | 同上 | 每日自动滚动续期 |
| `DATA_COOKIE` | us.data.futuoa.com → F12 → Network → Cookie → `uIdToken=...` | **约1周**，到期前3天飞书提醒 |
| `USCM_COOKIE` / `USCM_CSRF` | 每日自动刷新 | 自动 |

**DATA_COOKIE 过期提醒机制：**
- 每日 12:00 session 刷新后自动检测 JWT 到期时间
- 还有 ≤3 天：飞书橙色预警
- 已过期：飞书红色紧急通知
- 周五 20:00 生成报告时如已过期：飞书通知，跳过本周发送

**更新 DATA_COOKIE：**
1. 打开 `us.data.futuoa.com`，F12 → Network → 任意请求 → Headers → Cookie
2. 复制 `uIdToken=eyJ...` 到 `.env` 的 `DATA_COOKIE=` 后（只需 `uIdToken`，不需要 `.sig`）

---

## 手动运行模式

### Step 1：获取认证

**A. `DATA_COOKIE`**（来自 `us.data.futuoa.com`）
- F12 → Network → 任意请求 → Cookie → 复制 `uIdToken=...` 部分

**B. `USCM_COOKIE` + `USCM_CSRF`**（来自 `uscm.futuoa.com`）
- Cookie: `EGG_SESS=...; csrfToken=TOKEN; staff_id=7328; staff_id.sig=...`
- CSRF: `csrfToken` 的值（单独提取）

### Step 2：运行脚本

```bash
DATA_COOKIE="uIdToken=..." \
USCM_COOKIE="EGG_SESS=...; csrfToken=TOKEN; staff_id=7328; staff_id.sig=..." \
USCM_CSRF="TOKEN" \
node "C:\Users\irisding\.claude\skills\US-CCS-weekly-report\run.js" [options]
```

**可选参数：**
- `--week-start YYYY-MM-DD`：指定周五日期（BT），默认自动计算上一完整周
- `--data-start YYYY-MM-DD`：覆盖在线/电话/邮件渠道的起始日期（不影响报告标题周期）
- `--ob-start YYYY-MM-DD`：外呼统计起始日期（默认 = week-start）
- `--ob-end YYYY-MM-DD`：外呼统计结束日期（默认 = weekEnd + 1 day）
- `--out /path/report.html`：输出路径，默认 `%USERPROFILE%\weekly_report_YYYY-MM-DD_MMDD.html`
- `--discover`：打印所有 Card 字段列表

**输出文件名格式：** `weekly_report_{weekStart}_{weekEndMMdd}.html`
例：`weekly_report_2026-06-27_0703.html`

**典型用法（缩短周）：**
```bash
node run.js \
  --week-start 2026-06-26 \
  --data-start 2026-07-01 \
  --ob-start 2026-07-01 \
  --ob-end 2026-07-03
```

### Step 3：填写三、四节

脚本生成的 HTML 中，**第三节（本周重点工作）和第四节（下周安排）** 为浏览器可编辑区域。
收集用户内容后用 Bash 替换：

```bash
node -e "
const fs = require('fs');
const f = process.argv[1];
let h = fs.readFileSync(f, 'utf8');
h = h.replace('请填写本周重点工作...', process.argv[2]);
h = h.replace('请填写下周安排...', process.argv[3]);
fs.writeFileSync(f, h);
" "C:/Users/irisding/weekly_report_YYYY-MM-DD_MMDD.html" "本周重点工作内容" "下周安排内容"
```

### Step 4：推送 GitHub Pages

```bash
cp "C:/Users/irisding/weekly_report_{date}.html" "C:/Users/irisding/us-css-weeklyreport/"
cd "C:/Users/irisding/us-css-weeklyreport"
git add "weekly_report_{date}.html"
git commit -m "Add US CSS weekly report {start} ~ {end}"
git push origin main
```

URL：`https://irisding001.github.io/us-css-weeklyreport/weekly_report_{date}.html`

### Step 5：飞书通知

```bash
lark-cli --profile us-ccs im +messages-send \
  --user-id ou_423989c914515582660dfef99848b0e7 \
  --as bot --msg-type interactive \
  --content '{"config":{"wide_screen_mode":true},"header":{"title":{"tag":"plain_text","content":"US CSS Weekly Report | {MM-DD} ~ {MM-DD}"},"template":"blue"},"elements":[{"tag":"action","actions":[{"tag":"button","text":{"tag":"plain_text","content":"点击查看"},"type":"primary","url":"https://irisding001.github.io/us-css-weeklyreport/weekly_report_{date}.html"},{"tag":"button","text":{"tag":"plain_text","content":"查看历史周报"},"type":"default","url":"https://irisding001.github.io/us-css-weeklyreport/"}]}]}'
```

open_id 固定：`ou_423989c914515582660dfef99848b0e7`（us-ccs profile）

---

## 数据来源

| 模块 | Card ID | v_param | 说明 |
|------|---------|---------|------|
| LC Queue | `n897ad21677424c66af5aad8` | `TFUsDZAqXcxCwqCzQlvZIQRT` | 工单量、满意度、FCR、30s率 |
| LC Util  | `u6b720a2a07f246b8ba5ed1c` | `SYRdxWeqRlzviTWngneskcEk` | 工时利用率 |
| Phone    | `p387a9f31ddc842f89a058eb` | `LoZeFSbcPCYrMOEKfCEenGqH` | 呼入量、接通率、满意度、FCR |
| Phone Util | `g2f6209e865c343cc9015a26` | 自动解析 | 电话工时利用率（每人） |
| Email    | `j4e69d8b9111b4f0a86bfb93` | `rwBQAsirGzsCMpndPwUVKhzL` | 工单量、SLA |
| SLA      | `i962341c6f44c422f8eb998e` | `ZedMDVjfQRBbjcfVycpPIPMU` | conversion CS team SLA |
| Outbound Leads | uscm `/api/am/us/statistics/marketing-details` | - | Leads分配/跟进/有效 |
| Outbound PC    | uscm `/api/am/us/overseas-performance/total-stats` | - | 周PC + 月累计 |

**外呼时间窗口**：`--ob-start` 19:00 BT → `--ob-end` 16:00 BT（默认：周五 19:00 → 下周五 16:00）

---

## 报告结构

| 节 | 内容 |
|----|------|
| 一、业绩情况 | 四渠道团队汇总 + 12人个人汇总（工单/利用率/满意度/周PC/月PC）|
| 二、个人业绩分析 | LC / Phone / Email / Outbound 各渠道个人明细 |
| 三、本周重点工作 | 浏览器可编辑文本区域 |
| 四、下周安排 | 浏览器可编辑文本区域 |

---

## Phone Util Card 说明

Card `g2f6209e865c343cc9015a26` 的 v_param 由脚本自动从 `/api/card/{id}` 解析。
若返回 `[WARN] Phone util card failed`，运行以下命令排查：

```bash
DATA_COOKIE="..." node "C:\Users\irisding\.claude\skills\US-CCS-weekly-report\run.js" --discover
```

---

## 注意事项

- `uIdToken` 约 **1周** 有效，到期前3天飞书自动提醒（每日12:00检测）
- `EGG_SESS` 约1天有效，由 `refresh-session.js` 每日自动刷新
- `PASSPORT_SUPERSIG` 每日随 SSO 流程滚动续期，一般无需手动更新
- 日期全部使用北京时间（BT = UTC+8）
- Phone Util 失败时报 `[WARN]`，不阻断其他模块
- `--discover` 仅打印字段，不生成报告
