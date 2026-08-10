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

**个人咨询PC 从 BI 自动抓取**（card `ndfe729d2affb4323a070459`），不需要 `--agent-consult-pc`。  
渠道级咨询PC（LC/Phone/Email）仍需从 USCM 截图手动读取。  
周外呼转化PC = 客经侧已转化PC（BI 自动抓取，无需手动传入）。

```bash
node "C:\Users\irisding\.claude\skills\US-CCS-weekly-report\run.js" \
  --week-start YYYY-MM-DD \
  --lc-pc N --phone-pc N --email-pc N \
  --monthly-pc-kpi N
```

`--monthly-pc-kpi`：当月PC目标（如 `100`），用于 Section 二 KPI 进度条展示。skill 调用格式：`August PC KPI 100`。

输出：`%USERPROFILE%\weekly_report_{weekStart}_{weekEndMMdd}.html`

---

## Step 1.5：注入 WoW + KPI（inject_wow_kpi.js）

更新脚本顶部 `lastWeekIndividual`（仅 weekPC，CSAT 列已改为趋势色块由 run.js 自动生成）、`monthlyPC`、`lastWeekChannel`、`thisWeekChannel`，然后：

```bash
node C:/Users/irisding/inject_wow_kpi.js [report_path]
```

---

## Step 2：不满意工单分析（patch_neg_cards.js）

每周更新两处：① `begin`/`endTs` 时间戳（北京时间）；② 底部 `f` 变量（HTML 文件路径），然后：

```bash
node "C:/Users/irisding/patch_neg_cards.js"
```

未知分类 ID → USCM 截图匹配后补入 `CAT_NAME`，同步更新 memory `ws_category_ids.md`。

---

## Step 2.5：外呼排名标注 + 满意度改版

更新 `patch_all_27_29_30.js` 顶部数据后运行：

```bash
node C:/Users/irisding/patch_all_27_29_30.js
node C:/Users/irisding/patch_3in1row.js
```

**patch_all_27_29_30.js 每周需更新：**
- Part 1 外呼排名：4列（有效跟进/周PC/分配転化率月/有效転化率月）的 top1/bottom1 agent 姓名和数值
- Part 2 CSAT SVG：`csatPct`（近5周）、`weeks5` 标签
- Part 2 负评分布小结文字：渠道分布/糟糕工单/不满意工单各条原因

**近5周 combo 图（总评价量 + 负评量 + CSAT 折线）数据来源：**
- 总评价量 / 负评量：从近5周报告 HTML 或 patch_csat_combo_bars.js 手动录入
- 负评量辅助公式：`neg = round(total × (1 − CSAT/100))` 可辅助计算历史数据
- CSAT 折线 + 数据点 tooltip：`patch_vol_csat_5weeks.js` 自动生成，鼠标悬停显示周次+渠道+数值

每周运行 `patch_vol_csat_5weeks.js` 前，更新脚本顶部：
- `volData`：5×3 数组（在线/电话/邮件 各周工单量，近5周从旧到新）
- `csatData`：5×4 数组（在线/电话/邮件/综合 CSAT%，近5周从旧到新）
- `labels`：5个周次标签（如 `['0703-0709', '0710-0716', ...]`）

历史数据从往期报告 HTML 中读取；当周数据由 run.js 生成后手动补入。

```bash
node C:/Users/irisding/patch_vol_csat_5weeks.js [report_path]
```

**满意度节（Section 三）最终结构：**
1. **满意度小结**（内含负评分布小结）：需提供有意义的解读，不是数据罗列
   - 开头：CSAT 达标与否 + 与上周对比 + 负评量是否创新低/新高
   - 渠道层面：哪个渠道超/低于目标，Email/Phone 如有持续问题需点出
   - 个人层面：本周负评集中在哪些人（具体名字 + 条数），CSAT 低于目标的人
   - 负评分布：按渠道分布 → 最高频分类及成因 → 每类一句话行动建议
2. **近5周综合满意度趋势**（SVG combo chart）：CSAT折线 + 总评价量/负评量双柱，5周均显示
3. **一行 flex**：趋势图 | 分渠道负评分布表 | 二级分类表（三列并排）
4. **不满意工单明细**：默认折叠（▶ 点击展开），含 agent/rating/分类 三级筛选器

**patch_3in1row.js** 无需修改（仅做布局调整，结构稳定）。

**周転化PC 数据来源说明：**
- 当周 = Individual Summary 表中 転化PC 列合计（run.js `agentSalesPC`）
- 历史5周数据**无法从 API 获取**，从往期报告 HTML 手动读取或用户截图提供

---

## Step 3：数据检查（推送前必须通过）

打开 HTML 逐项确认，**任意异常停下来问用户，不得推送：**

- 个人/月度咨询PC（12人）大部分 > 0
- 渠道PC合计不为 0
- 团队工单量（LC/Phone/Email）均 > 0
- 外呼跟进量/転化PC > 0
- Email CSAT 在 40%~100%
- 月度PC ≥ 周度PC
- 第三节末有不满意工单明细表（折叠状态），分类列显示文字名称
- 外呼表4列已标绿/标红（rank-top/rank-bot）
- 满意度节无独立"个人满意度明细"表（已删除）
- Section 二 待提升卡片内容已更新本周数据（Phone CSAT / FCR / 転化率）

---

## Step 3.5：差错分析（rebuild_section4.py）

更新脚本中：① `agents` 各人数据；② 日期范围字符串；③ 第4行文件路径，然后：

```bash
python C:/Users/irisding/rebuild_section4.py
```

---

## Step 3.6：Section 二 待提升内容更新

Section 二（WoW变化）末尾有**待提升卡片**，每周依据本周数据更新以下3项（SLA 卡片已删除）：

| 卡片 | 关注点 | 更新内容 |
|------|--------|----------|
| 电话 CSAT | Phone/个人 CSAT 低于 84% | 具体 agent 名字 + CSAT 值 |
| 在线 FCR | LC FCR 低于 95% | 具体 agent 名字 + FCR 值 |
| 月度有效転化率 | 转化率与最高对比 | 低转化 agent + 比值 vs 高效 agent |

若某项本周无异常可删去该卡片；若有其他维度异常可新增。

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

**注意**：index.html 由 `update_index.js` 自动读取本地所有 `weekly_report_YYYY-MM-DD_MMDD.html` 生成。  
推送前确认本地目录只有正确命名的报告文件（`{weekStart}_{weekEndMMdd}` 格式），删除任何错误/重复文件后再运行 `update_index.js`。

---

## Step 6：飞书通知（需 Iris 文字确认后再发）

更新 `send_weekly_notify.js` 中 `REPORT_URL` 和 `WEEK_RANGE`，等 Iris 确认后：

```bash
node C:/Users/irisding/us-css-weeklyreport/send_weekly_notify.js oc_6b53fdf35d29e9203579c4fc7b70acde
```

默认发群 `oc_6b53fdf35d29e9203579c4fc7b70acde`（US CSS Weekly Report 群）。  
发给 Iris 个人加参数：`ou_423989c914515582660dfef99848b0e7`
