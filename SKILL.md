---
name: US-CCS-weekly-report
description: US CSS 团队周报生成器（12人 Conversion CS Team，四模块：LC/Phone/Email/Outbound）。自动拉取 BI 数据，生成 HTML 周报，推送 GitHub Pages + 飞书通知。当用户提到"周报"、"weekly report"、"CSS 周报"、"填周报"、"写周报"时使用。
---

# US CSS Weekly Report

周期：**周五 ~ 周四（北京时间 UTC+8）**

## 团队成员（12人）

jacelynlim / terrychen / muhamadfaisal / calventan / azamuddin / jeanliew / whitneylee / alvinsim / zaydentan / vincentyew / wilsonwong / zyonnleong

---

## 凭证说明（`.env` 文件）

路径：`C:\Users\irisding\.claude\skills\US-CCS-weekly-report\.env`

| 变量 | 有效期 | 用途 |
|------|--------|------|
| `DATA_COOKIE` | ~2周 | BI 数据拉取；到期前3天自动飞书预警 |
| `WS_COOKIE` | 数天 | **不满意工单分析**（patch_neg_cards.js）；手动更新 |
| `USCM_COOKIE` / `USCM_CSRF` | ~1天 | 外呼数据；每日 12:00 自动刷新 |
| `PASSPORT_SESS_ID` | 数周 | 手动更新 |
| `PASSPORT_SUPERSIG` | 每日自动续期 | 无需手动 |

---

## Step 1：生成主报告

```bash
node "C:\Users\irisding\.claude\skills\US-CCS-weekly-report\run.js" [options]
```

**常用参数：**

| 参数 | 说明 |
|------|------|
| `--week-start YYYY-MM-DD` | 指定周五日期（BT），默认自动计算 |
| `--data-start YYYY-MM-DD` | 覆盖 LC/Phone/Email 渠道起始日期 |
| `--ob-start / --ob-end` | 外呼统计起止日期 |
| `--lc-pc N` / `--phone-pc N` / `--email-pc N` | 渠道咨询PC总数（手动填入） |
| `--agent-consult-pc name=N,...` | 个人周咨询PC（API 已移除，**必须手动传入**，从 USCM 截图读取） |
| `--agent-monthly-consult-pc name=N,...` | 个人月度咨询PC（同上） |
| `--out /path/report.html` | 指定输出路径 |
| `--discover` | 打印所有 Card 字段，不生成报告 |

**典型用法（常规完整周）：**
```bash
node run.js \
  --week-start 2026-07-17 \
  --lc-pc 9 --phone-pc 13 --email-pc 0 \
  --agent-consult-pc alvinsim=4,azamuddin=1,calventan=0,jacelynlim=2,jeanliew=1,muhamadfaisal=1,terrychen=5,vincentyew=2,whitneylee=3,wilsonwong=0,zaydentan=1,zyonnleong=2 \
  --agent-monthly-consult-pc alvinsim=8,azamuddin=5,calventan=2,jacelynlim=8,jeanliew=7,muhamadfaisal=6,terrychen=11,vincentyew=8,whitneylee=11,wilsonwong=5,zaydentan=5,zyonnleong=11
```

输出文件名：`weekly_report_{weekStart}_{weekEndMMdd}.html`（默认在 `%USERPROFILE%\`）

---

## Step 1.5：报告增强（inject_wow_kpi.js）

主报告生成后，运行此脚本注入：
- **周环比（WoW）指标**：Team Channel Summary + Individual Summary 每格加 ▲▼ 变化
- **KPI进度条**：Individual Summary 新增一列，格式 `████░░░░ 41%`（月度总PC / 100，目标100）
- **OmniUtil 红色警示**：< 90% 自动红色加粗

**每周更新脚本顶部的数据：**

```js
// C:/Users/irisding/inject_wow_kpi.js

const lastWeekIndividual = {
  terrychen: { weekPC: 3, csat: 83.3 },
  // ... 12 人上周数据
};
const monthlyPC = {
  whitneylee: 41, jacelynlim: 38, // ... 12 人本周月度总PC
};
const lastWeekChannel = {
  total: { vol: 1159, pc: 24, csat: 85.3 },
  lc: { vol: 363, pc: 10, csat: 90.7 },
  phone: { vol: 183, pc: 14, csat: 60.0 },
  email: { vol: 613, pc: 0, csat: 71.0 },
};
const thisWeekChannel = { /* 本周渠道数据 */ };
```

**运行：**
```bash
node C:/Users/irisding/inject_wow_kpi.js [report_path]
```

---

## Step 1.6：Outbound 表增强

Individual Breakdown → 外呼 Outbound 表需包含以下列（run.js 已支持，检查确认）：

| 新增列 | 计算公式 | 异常阈值 |
|--------|----------|----------|
| 跟进率 | 跟进量 / 分配Leads | — |
| 有效跟进率 | 有效跟进 / 分配Leads | — |
| 有效跟进（红色警示） | 数值本身 | **< 25 → 红色加粗** |

Individual Summary 底部需有**合计行**（背景 #dce6ff，蓝色上下边框）：
- 满意度：团队综合满意度（来自本周概览）
- 工时利用率：`-`

---

## Step 1.7：满意度分析 — 二级分类分布（run.js 内置）

`run.js` 主报告生成时，若 `WS_COOKIE` 有效，**第三节满意度分析**末尾会自动追加：

- **不满意工单分类分布（二级）**：显示分类名、工单数、占比，按工单数降序排列
- 仅统计 `optionSatisfied=3`（不满意）和 `4`（糟糕）工单的 `categoryInfo` 中**二级分类**（CAT_LEVEL=2）

无需额外脚本，只需确保 `.env` 中 `WS_COOKIE` 有效即可。

---

## Step 2：不满意工单分析（patch_neg_cards.js）

主报告生成后，运行此脚本将**第三节末尾**插入不满意工单分析表 + 渠道/分类小结（含个人明细）。

**前提**：`.env` 中 `WS_COOKIE` 有效。

**每周需更新脚本顶部的日期范围**（北京时间 00:00 ~ 23:59）：

```js
// patch_neg_cards.js 第14-15行
const begin = Math.floor(new Date('2026-07-17T00:00:00+08:00').getTime() / 1000);
const endTs  = Math.floor(new Date('2026-07-23T23:59:59+08:00').getTime() / 1000);
```

**运行：**
```bash
node "C:/Users/irisding/patch_neg_cards.js"
```

输出：`done — N cards + summary inserted`（N 为本周不满意+糟糕工单数）

**分类 ID 说明：**
- `GetBadEvaluations` 接口返回的 `categoryInfo` 字段为纯数字 ID
- 已知 22 个 ID → 名称映射在脚本的 `CAT_NAME` 对象中（详见 memory `ws_category_ids.md`）
- 遇到未知 ID（显示为原始数字）：去 USCM 满意度页面截图，按 渠道+客服 匹配后手动补充到 `CAT_NAME`

---

## Step 3：数据检查（推送前必须通过）

在浏览器打开生成的 HTML，逐项核查。**任意一项为 0 或明显异常，停下来问用户，不得推送。**

| 检查项 | 正常值 | 常见原因 |
|--------|--------|----------|
| 个人咨询PC（12人） | 大部分 > 0 | 未传 `--agent-consult-pc` |
| 月度咨询PC（12人） | 大部分 > 0 | 未传 `--agent-monthly-consult-pc` |
| 渠道咨询PC 合计 | 不为 0 | 未传 `--lc-pc/--phone-pc` |
| 团队工单量（LC/Phone/Email） | 均 > 0 | `DATA_COOKIE` 过期 |
| 外呼跟进量 / 转化PC | > 0 | `USCM_COOKIE` 过期 |
| Email CSAT | 40%~100%，不为 0% | 过滤条件或数据问题 |
| 月度总PC | ≥ 周度总PC | 月内数据范围错误 |
| 不满意工单分析 | 出现在第三节末，有表格和小结 | `WS_COOKIE` 过期或 patch 未运行 |
| 分类列 | 显示文字名称，非纯数字 | `CAT_NAME` 缺少该 ID，需补充 |

---

## Step 4：填写第四、五节

脚本生成的 HTML 中，第四节和第五节为浏览器可编辑区域，收集用户内容后用以下命令替换：

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

---

## Step 5：推送 GitHub Pages

```bash
cp "C:/Users/irisding/weekly_report_{date}.html" "C:/Users/irisding/US-CSS-weekly-report/"
cd "C:/Users/irisding/US-CSS-weekly-report"
git add "weekly_report_{date}.html" index.html
git commit -m "Add US CSS weekly report {start} ~ {end}"
git pull --rebase origin main
git push origin main
```

URL：`https://irisding001.github.io/US-CSS-weekly-report/weekly_report_{date}.html`

---

## Step 6：飞书通知（Bot 私信给 Iris）

```bash
lark-cli --profile us-ccs im +messages-send \
  --user-id ou_423989c914515582660dfef99848b0e7 \
  --as bot --msg-type interactive \
  --content '{"config":{"wide_screen_mode":true},"header":{"title":{"tag":"plain_text","content":"US CSS Weekly Report | {MM-DD} ~ {MM-DD}"},"template":"blue"},"elements":[{"tag":"div","text":{"tag":"lark_md","content":"本周报告已更新，含满意度分析及不满意工单分析"}},{"tag":"action","actions":[{"tag":"button","text":{"tag":"plain_text","content":"查看周报 View Report"},"type":"primary","url":"https://irisding001.github.io/us-css-weeklyreport/weekly_report_YYYY-MM-DD_MMDD.html"},{"tag":"button","text":{"tag":"plain_text","content":"历史周报 History"},"type":"default","url":"https://irisding001.github.io/us-css-weeklyreport/"}]}]}'
```

open_id 固定：`ou_423989c914515582660dfef99848b0e7`（us-ccs profile）

---

## 脚本文件说明

| 脚本 | 位置 | 作用 |
|------|------|------|
| `run.js` | skill 目录 | 主报告生成（一~三节框架 + 四五节占位） |
| `patch_neg_cards.js` | `C:/Users/irisding/` | 插入不满意工单分析表 + 小结（需 WS_COOKIE） |
| `auto-report.js` | skill 目录 | 定时任务入口（每周五 20:00 BT 自动运行） |
| `refresh-session.js` | skill 目录 | 每日 12:00 刷新 USCM_COOKIE/CSRF |

---

## 注意事项

- **咨询PC 每周必须手动从 USCM 截图读取**，API 字段 `online_pc/phone_pc/email_pc` 已移除，脚本始终返回 0
- `patch_neg_cards.js` 日期范围每周需手动更新（第14-15行）
- 遇到不满意工单分类列显示数字 ID → 截图 USCM 满意度页面比对后补充到 `CAT_NAME`（同步更新 memory `ws_category_ids.md`）
- git push 前先 `git pull --rebase origin main`，避免被拒
- 日期全部使用北京时间（BT = UTC+8）
