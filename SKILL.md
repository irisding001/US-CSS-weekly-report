---
name: US-CCS-weekly-report
description: US CSS 团队周报生成器（12人 Conversion CS Team，四模块：LC/Phone/Email/Outbound）。自动拉取 BI 数据，生成 HTML 周报，推送 GitHub Pages + 飞书通知。当用户提到"周报"、"weekly report"、"CSS 周报"、"填周报"、"写周报"时使用。
---

# US CSS Weekly Report

周期：**周五 ~ 周四（北京时间 UTC+8）**  
团队：jacelynlim / terrychen / muhamadfaisal / calventan / azamuddin / jeanliew / whitneylee / alvinsim / zaydentan / vincentyew / wilsonwong / zyonnleong

> ⚠️ **仓库区分（严禁推错）**  
> - 本 skill（`US-CCS-weekly-report`）→ 仓库 `US-CSS-weekly-report`（周五~周四，`https://github.com/irisding001/US-CSS-weekly-report`）  
> - 本地路径：`C:/Users/irisding/us-css-weeklyreport/`（remote 已更新）  
> - `us-css-weeklyperformance` skill → 仓库 `us-css-weeklyperformance`（周一~周日）  
> - 两个 skill/仓库完全独立，推送前必须确认目标仓库正确

## 凭证

Cookie 统一存储在 `C:\Users\irisding\run_weekly_config.json`，脚本自动读取，无需手动传入：

| 字段 | 用途 | 有效期 |
|------|------|--------|
| `DATA_COOKIE` | us.data.futuoa.com（BI 数据） | ~2周 |
| `USCM_COOKIE` / `USCM_CSRF` | uscm.futuoa.com（USCM 工单） | ~1天 |
| `WS_COOKIE` | us-workspace.futuoa.com（不满意工单） | 数天 |

**Cookie 刷新已全自动，无需手动操作：**

| 情况 | 行为 |
|------|------|
| Cookies 仍有效（JWT 未过期 + EGG_SESS 存在） | 静默 reload，无任何窗口 |
| Cookies 过期，Playwright 浏览器 session 仍在 | `setup_cookies.py` headless 静默刷新（~10秒，无任何窗口） |
| Playwright session 也过期（约2周才发生） | Chrome 自动弹出，IOA 登录后自动检测，无需按 ENTER |

脚本启动时自动通过 `localhost:8765` proxy 绕过 Cloudflare 限制，不再因 1017 错误触发刷新提示。

若确实需要手动强制刷新（如三个站点都失效）：`py C:\Users\irisding\setup_cookies.py --force`

`.env` 文件（`C:\Users\irisding\.claude\skills\US-CCS-weekly-report\.env`）仍作为备用读取源，但以 `run_weekly_config.json` 为准（后者会覆盖 `.env` 中相同字段）。

---

## 一键运行（推荐）

所有步骤（Step 1 ~ Step 2.5）已串联为单条命令，每步完成后自动校验结构，任一步失败立即停止：

```bash
node C:/Users/irisding/run_report.js \
  --week-start YYYY-MM-DD \
  [--monthly-pc-kpi N]
```

- 自动验证 `--week-start` 是周五，否则报错
- 每步完成后校验 section 唯一性 + 哨兵注入次数
- 输出文件：`%USERPROFILE%\weekly_report_{weekStart}_{weekEndMMdd}.html`

> 只需手动预填 `inject_wow_kpi.js` 中的 `monthlyPC`/`lastWeekChannel`/`thisWeekChannel`，其余全自动。

---

## Step 1：生成主报告

**PC 数据来源（全部 BI 自动抓取）：**
- 咨询PC（LC/Phone/Email）：pbb45c BI card `oa724299e80dd4e4daaa9301`，按「最终有效跟进方式」统计 UID 数
  - 取数方式：6个 row 维度（地区/牛牛号UID/转化时间/处理人/有效跟进方式/最近跟进时间），每行 = 1条PC记录，直接 count 各方式行数
  - 时间范围：`${start} 00:00:00` ~ `${end} 23:59:59`（含当天，不用次日 00:00:00）
  - 在线PC = 方式含「在线」的行数；电话PC = 方式含「电话」的行数；邮件PC = 方式含「邮件」的行数
  - ⚠️ 不能只用 method+agent 两个维度，会折叠同一 agent 的多条记录导致计数偏低
- 外呼转化PC（`channelPC.ob`）：同一 card，方式 = 外呼 or SMS 行数
- 个人咨询PC：card `q675815b12e4246afa871c94`（page a367cbb），字段「客服侧PC」

概览栏显示：`周咨询PC`（在线+电话+邮件）+ `周总PC`（咨询PC + 外呼转化PC）  
**不再需要 `--lc-pc / --phone-pc / --email-pc` 参数。**

```bash
node "C:\Users\irisding\.claude\skills\US-CCS-weekly-report\run.js" \
  --week-start YYYY-MM-DD \
  [--monthly-pc-kpi N]
```

`--monthly-pc-kpi`：当月PC目标，默认 `80`。月度变动时传入，否则可省略。

输出：`%USERPROFILE%\weekly_report_{weekStart}_{weekEndMMdd}.html`

**Section 二 渠道详情布局：**  
在线 / 电话 / 邮件 三列并排（同一行）；外呼单独一行在下方。

**月度个人汇总表：**  
月度业绩区仅显示合计工单量（月度总工单），不再分渠道（LC/Phone/Email）拆列。

---

## Step 1.5：注入 WoW + KPI（inject_wow_kpi.js）

每周更新 `monthlyPC`、`lastWeekChannel`、`thisWeekChannel`（`lastWeekIndividual` 已移除，不再注入 Individual Summary WoW）：

**注意：**
- WoW 箭头只注入渠道汇总表（合计/在线/电话/邮件4行），Individual Summary 表不加 WoW
- Individual Breakdown 列标注：**彩色字体**（非色点）；满意度 <84% 标红字；接通率/FCR/SLA：底部值红字、顶部值绿字，仅当 colMin < colMax 时才标；全列相同不标
- 外呼表各业绩列：顶部值绿字 / 底部值红字，inline style，不再用 rank-top/rank-bot CSS class

```bash
node C:/Users/irisding/inject_wow_kpi.js [report_path]
```

---

## Step 1.6：各渠道近6周趋势（inject_channel_trend.js）

自动从 BI + USCM 抓取过去6周的渠道工单量/CSAT/外呼数据，插入 Section 一"各渠道近6周趋势"三图（工单量 / 转化PC / 满意度）。  
**无需手动修改数据**，每周只需传入正确的 `--week-start` 即可：

```bash
node C:/Users/irisding/inject_channel_trend.js --week-start YYYY-MM-DD
```

**重要**：此脚本同时写出 `C:/Users/irisding/csat_trend_data.json`，供后续 `patch_auto.js` 读取渠道 CSAT 数据。**必须在 `patch_auto.js` 之前运行。**

**chart-conv PC 趋势图包含两条线：**
- 橙色虚线：外呼转化PC（外呼+SMS，从 pbb45c BI card 实时抓取）
- 绿色实线：总PC（外呼转化PC + 咨询PC，从 USCM total_pc 获取）

⚠️ 依赖 `DATA_COOKIE`（`uIdToken` 约2周有效）+ `USCM_COOKIE`。若出现 401，更新 Cookie 后重跑。

---

## Step 2：不满意工单分析（patch_neg_cards.js）

时间戳和报告路径已参数化，无需手动修改脚本：

```bash
node "C:/Users/irisding/patch_neg_cards.js" \
  --week-start YYYY-MM-DD \
  --report /path/to/weekly_report.html
```

未知分类 ID → USCM 截图匹配后补入 `CAT_NAME`，同步更新 memory `ws_category_ids.md`。

---

## Step 2.5：外呼排名 + 满意度（patch_auto.js）

**全自动，无需手动填数据。** 读取 HTML + `csat_trend_data.json` + 实时抓取 workspace 6周数据：

```bash
node C:/Users/irisding/patch_auto.js --week-start YYYY-MM-DD
```

**自动完成以下三件事：**

**① 外呼排名标注**（无需 API，直接解析 HTML 外呼排名表）  
4列各找 top1（绿字）/ bottom1（红字），自动写入 inline style：
- 有效跟进 Eff. Follow
- 周PC Weekly PC
- 分配转化率月 Dist. Conv%
- 有效转化率月 Eff. Conv%
- vincentyew 自动排除（自 2026-08-14 起）

**② 近6周 CSAT combo 图**（Section 三）  
从 workspace `GetBadEvaluations` 并发抓取近6周评价数据，自动计算：
- 每周总评价量（totalTx）、负评量（negTx）、综合 CSAT%
- 渠道 CSAT 折线从 `csat_trend_data.json` 读取（inject_channel_trend.js 生成）
- 生成 SVG combo 图（总评价量柱 + 负评量柱 + CSAT 折线）注入 Section 三

**③ 满意度小结**（自动生成文字）  
- CSAT 达标与否 + 与上周对比
- 渠道分布（LC/Phone/Email 各多少条负评）
- 负评集中 agent（姓名 + 条数）
- 个人 CSAT 低于 84% 的 agent（需 ≥3 条评价）

**Section 三最终结构：**
1. 满意度小结（自动生成，可人工补充解读）
2. 近6周综合满意度趋势（SVG combo chart）
   - 图例项均可点击切换显示/隐藏：总评价量 / 负评量 / 综合CSAT / 目标≥84% / 在线LC / 电话Phone / 邮件Email
   - 在线/电话/邮件各渠道 CSAT 折线从 `csat_trend_data.json` 读取（虚线，与综合CSAT实线区分）
   - 点击逻辑由 SVG 内联 `togCsatCh(ch, btn)` 实现，ID 命名：`csat-bars-total/neg`、`csat-target`、`csat-ch-lc/ph/em`、`csat-overall`
3. 不满意工单明细（默认折叠，含 agent/rating/分类三级筛选器，由 patch_neg_cards.js 生成）

**已废弃脚本（不再运行）：**
- `patch_all_27_29_30.js` → 由 `patch_auto.js` 完全替代
- `patch_vol_csat_5weeks.js` → Section 一图表由 `inject_channel_trend.js` 维护，Section 三 combo 由 `patch_auto.js` 维护，此脚本作废
- `patch_3in1row.js` → 已为 no-op，不需运行

---

## Step 3：数据检查 + 全报告内容复查（推送前必须通过）

打开 HTML 逐项确认，**任意异常停下来问用户，不得推送：**

**数据存在性（不得缺失）：**
- 个人/月度咨询PC（12人）大部分 > 0
- 渠道PC合计不为 0
- 团队工单量（LC/Phone/Email）均 > 0
- 外呼跟进量/转化PC > 0
- Email CSAT 在 40%~100%
- 第三节末有不满意工单明细表（折叠状态），分类列显示文字名称
- Individual Breakdown 所有 12 人均有数据，无空白行
- Section 三有满意度小结文字（非空）+ combo chart（有数据点）

**数据一致性（不得冲突）：**
- 月度PC ≥ 周度PC
- **PC 数据校验（必须通过才推送）**：
  - `周咨询PC`（顶部栏）= 渠道表在线+电话+邮件 PC 之和
  - `周总PC`（顶部栏）= 周咨询PC + 外呼转化PC
  - `渠道合计 PC` = 在线PC + 电话PC + 邮件PC
  - `Individual Summary 咨询PC 合计` = 渠道合计 PC（两处数值一致）
  - `Individual Summary 总PC 合计` = 周总PC（顶部栏一致）
- 工单量合计 = LC + Phone + Email 之和

**格式校验：**
- 外呼排名表 4 列已有彩色字体标注（inline style `color:#16a34a` / `color:#dc2626`，非 rank-top/rank-bot class）
- Individual Breakdown 满意度/接通率/FCR 列用彩色字体标注（非色点），全列相同时不标
- 满意度节无独立"个人满意度明细"表（已删除）
- Section 二 待提升卡片内容已更新本周数据（Phone CSAT / FCR / 转化率）

**报告视觉格式检查（对照上周报告逐项比较）：**

上周报告路径：`C:/Users/irisding/us-css-weeklyreport/` 目录下上一份 HTML 文件。

- **表格布局**：列数、列宽与上周一致；无列内容溢出或截断
- **间距**：各 Section 之间 padding/margin 与上周一致，无异常压缩或撑开
- **字体大小**：表头、数据行、小标签字号与上周一致
- **图表**：趋势图（Section 一）、CSAT combo chart（Section 三）与上周尺寸一致，数据点可见、无空白图
- **内容不重叠**：SVG/图表内文字不遮挡，柱图/折线不超出边框
- **颜色标注**：彩色字体（绿/红 inline style）位置与上周一致，无多余标注也无漏标
- **折叠组件**：不满意工单明细默认折叠（`<details>` 未展开）
- **移动端/宽屏**：Section 二三列并排（在线/电话/邮件）布局正常，外呼单独一行
- **整体高度**：报告总高度与上周大致相当；若差异 > 20%，检查是否有内容块意外重复或缺失

**分析内容复查（避免本周报告残留上周内容）：**
- **Section 一 小结文字**：检查趋势图描述、本周工单/PC/CSAT 概况是否对应本周数据，不残留上周文字
- **Section 二 待提升卡片**：
  - 电话 CSAT 卡片：agent 名字 + CSAT 值是否本周数据（非上周名单）
  - 在线 FCR 卡片：agent 名字 + FCR 值是否本周数据
  - 月度有效转化率卡片：低转化 agent 名单和比值是否本周数据
- **Section 三 满意度小结**：
  - CSAT% 是否本周实际值
  - 渠道分布（LC/Phone/Email 负评条数）是否对应本周
  - 负评集中 agent 名单是否本周负评数据
  - 个人 CSAT 低于 84% 名单是否本周数据
- **WoW 箭头**：渠道汇总表合计/在线/电话/邮件4行的 WoW 差值是否本周 vs 上周的真实差值（非上周的差值复制）
- **概览栏**：周咨询PC / 周总PC / 月度PC / 外呼转化PC 数值与表格合计一致
- **通用错误**：无残留占位符（`XXX`、`TODO`、`___`）、无未填字段、无空 `div`

---

## Step 3.5：Section 二 待提升内容更新

Section 二（WoW变化）末尾有**待提升卡片**，每周依据本周数据更新以下3项：

> ⚠️ **SLA 永久排除**：业绩分析（待提升/亮点）任何时候都不提 SLA 异常，run.js 已移除 emailSla 卡片生成逻辑。

| 卡片 | 关注点 | 更新内容 |
|------|--------|----------|
| 电话 CSAT | Phone/个人 CSAT 低于 84% | 具体 agent 名字 + CSAT 值 |
| 在线 FCR | LC FCR 低于 95% | 具体 agent 名字 + FCR 值 |
| 月度有效转化率 | BI 新例子有效跟进转化率差距 | 低转化 agent + 比值 vs 高效 agent |

月度有效转化率卡片由 run.js **自动生成**（USCM `/api/visitor/overseas-statistics/marketing-work` 月度区间，`effective_follow_user_count` 字段），无需手动更新。  
若某项本周无异常可删去该卡片；若有其他维度异常可新增。

---

## Step 3.5：向 Iris 收集第四、五节内容

数据检查（Step 3）全部通过后：

1. **告知 Iris**：数据部分已完整，所有数字均通过校验
2. **询问以下两项内容**：
   - 本周重点工作（Section 四）
   - 下周计划（Section 五）
3. **等待 Iris 提供**，收到后写入 HTML 对应节
4. **确认全部内容完整**后，再询问是否推送

> ⚠️ 未收到第四、五节内容前，**不得询问是否推送**，更不得自行推送。

---

## Step 4：推送 GitHub Pages

> ⚠️ **执行前必须向 Iris 确认**：列出将要执行的命令，等待 Iris 明确回复"确认"或"yes"后再执行。

**推送前先检查报告列表：**
- 确认 `us-css-weeklyreport/` 目录中无多余/重复/错误命名文件
- 新报告文件名格式：`weekly_report_{weekStart}_{weekEndMMdd}.html`（如 `weekly_report_2026-08-28_0903.html`）
- `weekStart` 必须是**周五**（可用 `date -d YYYY-MM-DD +%A` 验证）
- 历史列表应连续，无日期重叠或缺漏
- **push 后、发飞书前**：访问 GitHub Pages 首页，确认历史报告列表完整、周期全部为周五开始

```bash
cp "C:/Users/irisding/weekly_report_{date}.html" "C:/Users/irisding/us-css-weeklyreport/"
cd "C:/Users/irisding/us-css-weeklyreport"
node update_index.js
git add "weekly_report_{date}.html" index.html
git commit -m "Add US CSS weekly report {start} ~ {end}"
git pull --rebase origin main
git push origin main
```

**注意**：index.html 由 `update_index.js` 自动生成，按文件名倒序排列（最新在最上）。

---

## Step 5：飞书通知

> ⚠️ **执行前必须向 Iris 确认**：列出将要执行的命令，等待 Iris 明确回复"确认"或"yes"后再执行。  
> ⚠️ **必须等 GitHub Pages 部署完成**（访问 URL 确认页面有数据）后再发飞书通知，否则用户点开是 404。  
> ⚠️ **发飞书前复查历史报告列表**：访问 GitHub Pages 首页，确认历史报告完整连续、周期全部为周五开始，无异常才发通知。

更新 `send_weekly_notify.js` 中 `REPORT_URL` 和 `WEEK_RANGE`，等 Iris 确认后：

```bash
node C:/Users/irisding/us-css-weeklyreport/send_weekly_notify.js oc_6b53fdf35d29e9203579c4fc7b70acde
```

**推送群固定为 "US CSS Weekly Report" 群**（chat_id: `oc_6b53fdf35d29e9203579c4fc7b70acde`），不要发到其他群。  
发给 Iris 个人加参数：`ou_423989c914515582660dfef99848b0e7`
