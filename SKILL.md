---
name: US-CSS-weekly-report
description: US CSS 团队周报生成器（12人 Conversion CS Team，四模块：LC/Phone/Email/Outbound）。自动拉取 BI 数据，生成 HTML 周报，推送 GitHub Pages + 飞书通知。当用户提到"周报"、"weekly report"、"CSS 周报"、"填周报"、"写周报"时使用。
---

# US CSS Weekly Report — 四模块 HTML 周报

周期：**周五 ~ 周四（北京时间 UTC+8）**

## 团队成员（12人）

jacelynlim / terrychen / muhamadfaisal / calventan / azamuddin / jeanliew / whitneylee / alvinsim / zaydentan / vincentyew / wilsonwong / zyonnleong

---

## Step 1：获取认证

每次运行需提供：

**A. `DATA_COOKIE`**（来自 `us.data.futuoa.com`）
- F12 → Network → 任意请求 → Cookie: `uIdToken=...; uIdToken.sig=...`

**B. `USCM_COOKIE` + `USCM_CSRF`**（来自 `uscm.futuoa.com`）
- Cookie: `EGG_SESS=...; csrfToken=TOKEN; staff_id=7328; staff_id.sig=...`
- CSRF: `csrfToken` 的值（单独提取）

---

## Step 2：运行脚本

```bash
DATA_COOKIE="uIdToken=...; uIdToken.sig=..." \
USCM_COOKIE="EGG_SESS=...; csrfToken=TOKEN; staff_id=7328; staff_id.sig=..." \
USCM_CSRF="TOKEN" \
node "C:\Users\irisding\.claude\skills\US-CCS-weekly-report\run.js" [options]
```

**可选参数：**
- `--week-start YYYY-MM-DD`：指定周五日期（BT），默认自动计算上一完整周
- `--data-start YYYY-MM-DD`：覆盖在线/电话/邮件渠道的起始日期（不影响报告标题周期）
- `--ob-start YYYY-MM-DD`：外呼统计起始日期（默认 = week-start）
- `--ob-end YYYY-MM-DD`：外呼统计结束日期（默认 = weekEnd + 1 day）
- `--out /path/report.html`：输出路径，默认 `%USERPROFILE%\weekly_report_YYYY-MM-DD.html`
- `--discover`：打印所有 Card 字段列表

**典型用法（缩短周，如只统计后 2 天）：**
```bash
node run.js \
  --week-start 2026-06-26 \
  --data-start 2026-07-01 \
  --ob-start 2026-07-01 \
  --ob-end 2026-07-03 \
  --out "C:/Users/irisding/weekly_report_2026-06-26.html"
```

---

## Step 3：填写三、四节

脚本生成的 HTML 文件中，**第三节（本周重点工作）和第四节（下周安排）** 为可编辑区域，直接在浏览器中点击编辑，或提前通过对话收集内容后用 `--highlights` 和 `--plans` 参数传入（后续可扩展）。

当前工作流：询问用户后，用 Bash 直接将内容替换进 HTML 文件：
```bash
# 将占位文本替换为实际内容（UTF-8）
node -e "
const fs = require('fs');
const f = process.argv[1];
let h = fs.readFileSync(f, 'utf8');
h = h.replace('请填写本周重点工作...', process.argv[2]);
h = h.replace('请填写下周安排...', process.argv[3]);
fs.writeFileSync(f, h);
" "C:/Users/irisding/weekly_report_YYYY-MM-DD.html" "本周重点工作内容" "下周安排内容"
```

---

## Step 4：推送 GitHub Pages

```bash
cp "C:/Users/irisding/weekly_report_{date}.html" "C:/Users/irisding/US-CSS-weekly-report/"
cd "C:/Users/irisding/US-CSS-weekly-report"
git add "weekly_report_{date}.html"
git commit -m "Add US CSS weekly report {start} ~ {end}"
git push origin main
```

URL：`https://irisding001.github.io/US-CSS-weekly-report/weekly_report_{date}.html`

---

## Step 5：飞书通知

```bash
lark-cli --profile us-ccs im +messages-send \
  --user-id ou_423989c914515582660dfef99848b0e7 \
  --as bot --msg-type interactive \
  --content '{"config":{"wide_screen_mode":true},"header":{"title":{"tag":"plain_text","content":"US CSS Weekly Report | {MM-DD} ~ {MM-DD}"},"template":"blue"},"elements":[{"tag":"action","actions":[{"tag":"button","text":{"tag":"plain_text","content":"点击查看"},"type":"primary","url":"https://irisding001.github.io/US-CSS-weekly-report/weekly_report_{date}.html"},{"tag":"button","text":{"tag":"plain_text","content":"查看历史周报"},"type":"default","url":"https://irisding001.github.io/US-CSS-weekly-report/history.html"}]}]}'
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
| 三、本周重点工作 | 可在浏览器直接编辑的文本区域 |
| 四、下周安排 | 可在浏览器直接编辑的文本区域 |

---

## Phone Util Card 说明

Card `g2f6209e865c343cc9015a26` 的 v_param 由脚本自动从 `/api/card/{id}` 解析。
若返回 `[WARN] Phone util card failed`，运行以下命令排查：

```bash
DATA_COOKIE="..." node "C:\Users\irisding\.claude\skills\US-CCS-weekly-report\run.js" --discover
```

---

## 注意事项

- Cookie 有效期：`EGG_SESS` ~1天，`uIdToken` ~2周
- 日期全部使用北京时间（BT = UTC+8）
- Phone Util 失败时报 `[WARN]`，不阻断其他模块
- `--discover` 仅打印字段，不生成报告
