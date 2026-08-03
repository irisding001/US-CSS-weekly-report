---
name: US-CCS-weekly-report
description: US CSS 团队周报生成器（12人 Conversion CS Team，四模块：LC/Phone/Email/Outbound）。自动拉取 BI 数据，生成 HTML 周报，推送 GitHub Pages + 飞书通知。当用户提到"周报"、"weekly report"、"CSS 周报"、"填周报"、"写周报"时使用。
---

# US CSS Weekly Report

周期：**周五 ~ 周四（北京时间 UTC+8）**  
团队：jacelynlim / terrychen / muhamadfaisal / calventan / azamuddin / jeanliew / whitneylee / alvinsim / zaydentan / vincentyew / wilsonwong / zyonnleong

## 凭证（`.env`）

路径：`C:\Users\irisding\.claude\skills\US-CCS-weekly-report\.env`

| 变量 | 有效期 | 备注 |
|------|--------|------|
| `DATA_COOKIE` | ~2周 | 到期前3天自动预警 |
| `WS_COOKIE` | 数天 | 不满意工单分析，手动更新 |
| `USCM_COOKIE` / `USCM_CSRF` | ~1天 | 外呼；每日12:00自动刷新 |
| `PASSPORT_SESS_ID` | 数周 | 手动更新 |

---

## Step 1：生成主报告

咨询PC **必须从 USCM 截图手动读取**（API 已移除，脚本返回0）。

```bash
node "C:\Users\irisding\.claude\skills\US-CCS-weekly-report\run.js" \
  --week-start YYYY-MM-DD \
  --lc-pc N --phone-pc N --email-pc N \
  --agent-consult-pc name=N,name=N,... \
  --agent-monthly-consult-pc name=N,name=N,...
```

输出：`%USERPROFILE%\weekly_report_{weekStart}_{weekEndMMdd}.html`

---

## Step 1.5：注入 WoW + KPI（inject_wow_kpi.js）

更新脚本顶部 `lastWeekIndividual`、`monthlyPC`、`lastWeekChannel`、`thisWeekChannel`，然后：

```bash
node C:/Users/irisding/inject_wow_kpi.js [report_path]
```

---

## Step 2：不满意工单分析（patch_neg_cards.js）

更新第14-15行日期范围（北京时间），然后：

```bash
node "C:/Users/irisding/patch_neg_cards.js"
```

未知分类 ID → USCM 截图匹配后补入 `CAT_NAME`，同步更新 memory `ws_category_ids.md`。

---

## Step 3：数据检查（推送前必须通过）

打开 HTML 逐项确认，**任意异常停下来问用户，不得推送：**

- 个人/月度咨询PC（12人）大部分 > 0
- 渠道PC合计不为 0
- 团队工单量（LC/Phone/Email）均 > 0
- 外呼跟进量/转化PC > 0
- Email CSAT 在 40%~100%
- 月度PC ≥ 周度PC
- 第三节末有不满意工单分析表，分类列显示文字名称

---

## Step 3.5：差错分析（rebuild_section4.py）

更新脚本中：① `agents` 各人数据；② 日期范围字符串；③ 第4行文件路径，然后：

```bash
python C:/Users/irisding/rebuild_section4.py
```

---

## Step 4：填写第五、六节

向用户收集本周重点工作和下周计划，写入 HTML 第五、六节占位符。

---

## Step 5：推送 GitHub Pages

```bash
cp "C:/Users/irisding/weekly_report_{date}.html" "C:/Users/irisding/us-css-weeklyreport/"
cd "C:/Users/irisding/us-css-weeklyreport"
node update_index.js
git add "weekly_report_{date}.html" index.html
git commit -m "Add US CSS weekly report {start} ~ {end}"
git pull --rebase origin main
git push origin main
```

---

## Step 6：飞书通知（需 Iris 文字确认后再发）

更新 `send_weekly_notify.js` 中 `REPORT_URL` 和 `WEEK_RANGE`，等 Iris 确认后：

```bash
node C:/Users/irisding/us-css-weeklyreport/send_weekly_notify.js
```

默认发群 `oc_6b53fdf35d29e9203579c4fc7b70acde`（US CSS Weekly Report 群）。  
发给 Iris 个人加参数：`ou_423989c914515582660dfef99848b0e7`
