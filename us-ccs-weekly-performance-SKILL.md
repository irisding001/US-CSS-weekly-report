---
name: us-ccs-weekly-performance
description: US CCS 团队周度业绩数据抓取与报告生成器。自动调用内网 API 抓取团队和个人业绩数据，生成汇总报告，发送飞书私信给自己。当用户提到"US CCS 业绩"、"拉业绩数据"、"周度业绩"、"performance report"、"跟进数据"时，必须使用此 skill。
---

# US CCS Weekly Performance

调用内网 API 获取 3 人团队周度数据，计算团队加总，格式化后发送飞书私信给 irisding 本人。

## 成员列表

| staff_id | 姓名        |
|----------|-------------|
| 16510    | jacelynlim  |
| 16424    | alvinsim    |
| 14243    | vincentyew  |

## API 信息

### 来源A — 跟进量数据

```
GET https://uscm.futuoa.com/api/visitor/overseas-statistics/marketing-work
  ?start_date=YYYYMMDD&end_date=YYYYMMDD&staff_ids=16510,16424,14243
```

**必须 Headers：**
- `futu-csrf-token: {csrf_token}`
- `x-csrf-token: {csrf_token}`
- `x-futu-client-lang: en`
- `x-requested-with: XMLHttpRequest`
- `cookie: {session_cookies}`（含 `EGG_SESS`、`csrfToken`）

**字段映射（使用 `calculate_date=0` 汇总行）：**

| 报告指标 | API 字段 |
|---|---|
| 总跟进量 | `follow_count` |
| 总有效跟进量 | `effective_follow_count` |
| 总PC（外呼+SMS去重）| `intervened_transferred_num` |

团队数据 = 3 人 `calculate_date=0` 行加总。

### 来源B — 转化率数据（BI Dashboard）

**认证方式：** JWT Cookie (`uIdToken`) + Headers (`user-id: aXJpc2Rpbmc=`, `x-dom-id: Z3VhbmJp`)

**基础 URL：** `https://us.data.futuoa.com/api/card/{card_id}/data?v={v_param}`

**请求方式：** POST，Body 含 filters（日期范围、地区=US、周期粒度=周）

**已知 Card（仅用个人 card）：**

| card_name | card_id | v_param | 说明 |
|---|---|---|---|
| `new_leads_personal` | `ra25fdcdd1f5643d49983698` | `ggpNwkUiEmWzYEtsKMseFuSw` | 新 leads 个人级转化率，脚本同时输出 team_data（3人均值）|

> ⚠️ 团队级 card (`new_leads_team`) 返回漏斗计数而非转化率，**已停用**。
> 团队转化率 = 3 人简单平均，由脚本自动计算并输出在 `team_data` 字段。

**个人 card 目标指标：** 有效跟进率、分配转化率（跟进转化率）、有效跟进转化率

**staff 维度字段名：** `客经名`（存储英文用户名，如 `jacelynlim`）

## 工作流程

### Step 1：获取认证信息

询问用户提供以下信息（或从上下文读取）：
- **Cookie 字符串**：包含 `EGG_SESS`、`csrfToken`（来源A）
- **CSRF Token**：`csrfToken` 的值（来源A）
- **uIdToken**：来源B 的 JWT token
- **日期范围**：默认上周一至上周日（YYYY-MM-DD 格式）

### Step 2：计算日期范围

若用户未指定，自动计算上一完整周（**周一至周日**）：

```python
from datetime import datetime, timedelta
today = datetime.today()
last_monday = today - timedelta(days=today.weekday() + 7)
last_sunday = last_monday + timedelta(days=6)
start_yyyymmdd = last_monday.strftime('%Y%m%d')
end_yyyymmdd   = last_sunday.strftime('%Y%m%d')
start_dash     = last_monday.strftime('%Y-%m-%d')
end_dash       = last_sunday.strftime('%Y-%m-%d')
```

### Step 3：调用来源A

```bash
cd C:/Users/irisding/.claude/skills/us-ccs-weekly-performance

py scripts/fetch_data.py \
  --start {start_yyyymmdd} \
  --end {end_yyyymmdd} \
  --cookies "{cookie_string}" \
  --csrf "{csrf_token}"
```

脚本自动：
1. 获取当周数据（`calculate_date=0` 汇总行）
2. 获取上周同期数据（日期前推 7 天）
3. 计算团队加总
4. 输出格式化文本

### Step 4：调用来源B（仅个人 card）

```bash
py scripts/fetch_bi_data.py --card new_leads_personal \
  --start {start_dash} --end {end_dash} --uid-token {uid_token}
```

输出包含：
- `team_data`：3 人均值（有效跟进率 / 分配转化率 / 有效跟进转化率）
- `staff_data`：每人各指标

### Step 5：整合输出格式

```
📊 US CCS 周度业绩报告｜{start_dash} ~ {end_dash}

▌跟进量数据
              总跟进量  总有效跟进量  总PC
──────────────────────────────────────────
Team            XXXX         XXXX   XXX
jacelynlim      XXXX         XXXX   XXX
alvinsim        XXXX         XXXX   XXX
vincentyew      XXXX         XXXX   XXX

  ┌─ 与上周对比（{prev_range}）
  │ 总跟进量     ▲/▼ X%
  │ 总有效跟进量 ▲/▼ X%
  └─ 总PC        ▲/▼ X%

▌新 Leads 转化率
              有效跟进率  跟进转化率  有效跟进转化率
──────────────────────────────────────────────────
Team           XX.X%       XX.X%         XX.X%
jacelynlim     XX.X%       XX.X%         XX.X%
alvinsim       XX.X%       XX.X%         XX.X%
vincentyew     XX.X%       XX.X%         XX.X%
```

**对比规则：**
- 量级指标（跟进量、PC）：`▲/▼ X%`（增减百分比）
- 率类指标：`▲/▼ X pp`（百分点差值）

### Step 6：发送飞书私信

1. 展示完整报告预览
2. 调用 `lark-im` skill，搜索用户 `irisding`，发送私信给自己

---

## 注意事项

- Cookie 有效期：`EGG_SESS` 约 1 天，`uIdToken` 约 2 周，过期返回 401/403 时提示用户刷新
- `calculate_date=0` 行是周期汇总，直接读取，无需逐日累加
- Windows 下优先用 `py` 命令，若不可用则用 `python`
- 个人 card (`new_leads_personal`) 使用 **GRAPH view**（TABLE view 返回 500）；脚本 `preferred_views` 已配置为 `["GRAPH"]`
- staff 维度名已确认为 `客经名`，存储英文用户名
- 团队转化率 = 3 人的简单平均值
- `v_param` 是 card 版本号，日期变化不影响，已硬编码在脚本中
- 当前周数据可能尚未处理（count=0），脚本会输出 warning 而非报错退出
- 周期定义：**周一到周日**，WEEKS 数组格式 `MM-DD~MM-DD`
