# MCP_INTEGRATION.md — 麦当劳 MCP 集成说明

## 1. 使用的官方 MCP Server

| 项目 | 内容 |
| --- | --- |
| 服务方 | 麦当劳中国（金拱门）官方 MCP |
| 接入地址 | `https://mcp.mcd.cn` |
| 传输协议 | Streamable HTTP |
| 鉴权方式 | `Authorization: Bearer <MCD_MCP_TOKEN>`（Token 在 open.mcd.cn 控制台申请，仅运行时使用，入参用环境变量占位） |
| 官方文档 | https://github.com/M-China/mcd-mcp-server |
| 速率限制 | 每 Token 600 次/分钟（超限制返回 429） |

配置示例见 `mcp-config.example.json`：

```json
{
  "mcpServers": {
    "mcd-mcp": {
      "type": "streamablehttp",
      "url": "https://mcp.mcd.cn",
      "headers": { "Authorization": "Bearer ${MCD_MCP_TOKEN}" }
    }
  }
}
```

## 2. 实际使用的 Tool

本项目真实调用**七个**官方工具，覆盖「营养拉取 → 门店查询 → 套餐推荐 → 真实下单」完整闭环：

### （1）`list-nutrition-foods`（核心 · 营养权威源）
- **用途**：获取麦当劳常见餐品的营养成分数据——能量、蛋白质、脂肪、碳水化合物、钠、钙（接口**已直接返回 kcal**，无需 kJ 换算）。
- **本项目如何使用**：作为所有热量标注与推荐计算的**唯一权威数据源**。Web 小程序在「菜单」页为每个单品标注热量与宏量；推荐引擎以真实营养值为输入做组合搜索。
- **返回处理**：接口返回为「自然语言说明 + 原始 JSON」包装体，本脚本从 `data` 字段的**表格字符串**解析（字段序：`productName, nutritionDescription, energyKj, energyKcal, protein, fat, carbohydrate, sodium, calcium`）。

### （2）`query-nearby-stores`（取示例门店）
- **用途**：按城市/位置搜索可点餐门店，返回 `storeCode`。
- **本项目如何使用**：默认取「广州·天河」附近第一个门店（如 `麦当劳广州天源路餐厅 1400359`）作为示例门店，仅为获取该店实时菜单与价格；可用环境变量 `MCD_CITY` / `MCD_KEYWORD` 切换城市。

### （3）`query-meals`（在售菜单 + 价格 + 分类 + 标签）
- **用途**：按 `storeCode` + `orderType=1`(到店) + `beType=1`(自取) 查询该门店在售餐品：分类、餐品名、现价 `currentPrice`、标签、图片。
- **本项目如何使用**：为营养单品**补全真实分类与实时价格**（营养表只给热量、无分类/价格）。两源按「餐品名称」合并——分类用子串模糊（尺寸不影响分类），价格仅做安全尺寸匹配（避免「大薯条」套「中薯条」价）。

> 说明：以上三个工具用于「营养 + 在售菜单 + 价格」的权威数据拉取。在此基础上，本项目进一步真实调用以下下单类工具，把推荐结果直接落为真实订单。

### （4）`calculate-price`（下单试算）
- **用途**：按 `storeCode` / `orderType` / `beType` / `items[]`（`productCode` + `quantity`）计算价格与可用优惠，返回 `data.price`（单位：**分**）、`data.discount`、`data.productList`、`data.takeWayList[]`（每个含 `code` + `title`）。
- **本项目如何使用**：用户在「🛒 下单」页点「计算价格（含优惠）」时调用，展示合计与逐项小计，并渲染到店自取的取餐方式选项（`takeWayList[].code` 即 `create-order` 所需的 `takeWayCode`）。

### （5）`create-order`（创建真实订单）
- **用途**：与 `calculate-price` 同参，额外传 `takeWayCode`（到店自取时必填，取自 `takeWayList[].code`）；返回 `data.orderId`、`data.payH5Url`、`data.orderDetail`。
- **本项目如何使用**：用户在二次确认弹窗点「确认下单」后调用，拿到订单号与支付 H5 链接，引导到麦当劳 App / 扫码完成支付。**下单前强制二次确认**，避免误建真实订单。

### （6）`cancel-order`（取消订单，演示清理用）
- **用途**：按订单号取消未支付订单。
- **本项目如何使用**：演示 / 测试下单后清理未支付订单，避免产生真实待支付。状态判断用中文「待支付」正则匹配。

### （7）`order-list`（查询订单）
- **用途**：查询当前账号订单列表。
- **本项目如何使用**：配合 `cancel-order` 做演示订单的核对与清理。

> 字段约定（已实测确认）：菜单数据里存的就是官方 `productCode`（= `details` 映射的 key，如 `1100`=巨无霸、`1406`=板烧鸡腿堡、`4810`=中薯条、`1700`=麦辣鸡翅），可直接用于 `calculate-price` / `create-order`；价格单位为**分**，展示时除以 100；支付链接字段为 `data.payH5Url`。

## 2.1 为什么需要后端代理（安全架构）

浏览器**不能**直连 `mcp.mcd.cn`：一方面有 CORS 跨域限制，另一方面 Token 若下发到前端会泄露。本项目采用**本地后端代理**方案：

- `scripts/serve.mjs` 同时承担「静态文件预览」与「MCP 代理」。
- 前端只发同源请求 `POST /api/mcp { tool, args }`；**代理在后端用 `Authorization: Bearer <MCD_MCP_TOKEN>` 转发**给官方 MCP。
- Token 来源优先级：环境变量 `MCD_MCP_TOKEN` → 本地 `.env`（`MCD_MCP_TOKEN=...`，已被 `.gitignore` 忽略，**绝不入库**）。代理启动后 Token 只在后端内存使用，前端永远拿不到。
- 未配置 Token 时，代理返回 `400` 并提示用 `MCD_MCP_TOKEN=... node scripts/serve.mjs` 重启；静态页面其余功能（热量标注 / 口语记账 / 套餐推荐）仍可用。
- 说明：GitHub Pages 等纯静态托管**没有后端**，因此「一键下单」需在本地用 `node scripts/serve.mjs` 起代理后才能用；这是有意的安全取舍，避免 Token 暴露在公网。

## 3. 调用流程（端到端）

```
用户 → 记录今日已吃食物
        ↓
[list-nutrition-foods] → 拉取真实营养数据（或读取已刷新的 menu-data.js）
        ↓
计算：已摄入 / 目标 / 剩余预算 + 宏量营养情况
        ↓
推荐引擎（剩余预算内组合搜索）
   ├─ 性价比最高：max(蛋白质 / 元)
   ├─ 热量最低：min(总热量)
   ├─ 高蛋白增肌：max(蛋白质 − 0.3×脂肪)
   └─ 均衡营养：min(|宏量比例 − 3:2.5:4.5|)
        ↓
输出多策略减脂套餐组合（单品/热量/蛋白/脂肪/碳水/钠/价格 + 是否在预算内）
        ↓
[选单品加入购物车] → [query-nearby-stores] 选门店
        ↓
[calculate-price] 试算价格与优惠（取 takeWayList[].code 作 takeWayCode）
        ↓
[二次确认弹窗] → [create-order] 创建真实订单 → 返回 orderId + payH5Url
        ↓
（演示清理）[order-list] → [cancel-order] 取消未支付订单
```

实时刷新调用链（`scripts/sync-nutrition.mjs`）：
```
initialize → tools/call(list-nutrition-foods)     # 154 个餐品真实营养
           → tools/call(query-nearby-stores)        # 取示例门店 storeCode（默认广州·天河）
           → tools/call(query-meals)                # 该店在售菜单：分类/价格/标签
   → 三源合并（名称对齐）→ 每个可下单单品写入官方 productCode（=details key）
   → 覆盖 assets/menu-data.js（live:true）
   → 原始响应存档：data/raw-nutrition.json、data/raw-meals.json
```
> 价格覆盖说明：`query-meals` 仅返回示例门店**当前在售**单品的实时价（约 35 个核心单品有精确价，如巨无霸 ¥25.5 / 板烧鸡腿堡 ¥23.5 / 中薯条 ¥13.5）。其余单品（含早餐麦满分非在售时段、不同尺寸）在界面显示「门店价」，推荐组合若含无价单品则标注「含门店实时价」，**绝不编造价格**。

## 4. 业务价值

- **解决真实痛点**：减脂/健身人群想吃麦当劳但怕超标、不会搭配。本工具把「官方真实营养数据」变成可执行的个性化套餐建议。
- **数据可信**：直接消费麦当劳官方 MCP，而非第三方估算，营养/热量结论可溯源。
- **多目标覆盖**：同一份剩余预算，给出性价比、最低热量、高蛋白增肌、均衡四种策略，适配减脂、增肌、日常保持健康等不同人群。
- **可落地**：既能作为 WorkBuddy Skill 对话使用，也能独立部署为移动端点餐小程序（GitHub Pages）；通过本地后端代理，`calculate-price` + `create-order` 已把「推荐 → 实时下单」打通为完整闭环，且 Token 只在后端使用、下单前强制二次确认。

## 5. 代码引用

| 文件 | 作用 |
| --- | --- |
| `scripts/sync-nutrition.mjs` | 官方 MCP `list-nutrition-foods` 实时拉取与写入（含 `productCode`） |
| `scripts/serve.mjs` | 本地预览服务器 + 麦当劳 MCP 下单代理（`POST /api/mcp`，Token 仅后端） |
| `assets/menu-data.js` | 菜单营养数据（快照 / 官方实时，含可下单 `code`） |
| `assets/app.js` | 推荐引擎（`buildCombos` / `pickBest` / 四种策略）+ 购物车与下单流程 |
| `SKILL.md` | WorkBuddy Skill 工作流定义 |
| `index.html` / `assets/style.css` | 移动端点餐界面（含「🛒 下单」页） |
