# workbuddy.md — WorkBuddy 开发对话上下文

> 本文件记录使用腾讯 **WorkBuddy（v4.10.4 桌面端）** 智能体从 0 到 1 开发「M·buddy 轻食版」的全过程，用于核验是否符合麦当劳程序员创意开发大赛 **WorkBuddy 专项奖励**条件。

## 1. 需求起点（用户原话）

> 我想做一个适合减脂健身人群的麦当劳点餐小程序，类似肯德基的 Kpro，可以叫 M-buddy 轻食版，发布在 GitHub 上。首先需要了解每个麦当劳单品的热量情况，点餐界面标注好每个单品的热量。点餐者在点餐前需要输出当日已摄入什么食物，系统要计算当日热量和营销情况，综合推荐合适的减脂套餐组合，并可以给出多种选择：比如性价比最高组合、热量最低组合、高蛋白增肌组合等等。

拆解为 4 项硬需求：① 单品热量标注；② 点餐前录入当日已摄入并计算热量/营养情况；③ 多策略减脂套餐推荐；④ 发布到 GitHub。

## 2. 确认赛事与提交规则

用户提供 `https://open.mcd.cn/mcp/doc` 与 `https://github.com/M-China/mcd-developer-innovation-challenge`，经检索确认这是**麦当劳程序员节创意开发大赛**：基于官方 MCP（`https://mcp.mcd.cn`，Streamable HTTP，Bearer Token）开发 Skill，公开仓库 + Star 排名，截止 2026-10-25 23:59。

**官方必交文件核对**（以活动 README 为准）：

| 文件 | 是否必须 | 本项目状态 |
| --- | --- | --- |
| `README.md` | 必须，文件名不可改 | ✅ 项目介绍 / 安装方法 / 使用示例 / 目标用户齐备 |
| `CONTEST_DECLARATION.md` | 必须，文件名与内容均不可改 | ✅ 直接使用官方原文，逐字未改 |
| `MCP_INTEGRATION.md` | 必须，文件名不可改 | ✅ MCP Server / Tool / 调用流程 / 业务价值齐备 |
| 源代码 | 必须，形式不限 | ✅ `index.html` + `assets/` + `scripts/` 可运行 |
| `workbuddy.md` | 非必须；参加 WorkBuddy 专项奖励时必须，文件名不可改 | ✅ 本文件 |

> `mcp-config.example.json`、`SKILL.md`、`render.yaml` 为本项目**自加**的工程文件，非官方必交项；其中配置示例仅含 `${MCD_MCP_TOKEN}` 环境变量占位，不含真实 Token。

## 3. 数据与 MCP 接入（WorkBuddy 完成）

- 先用 `list-nutrition-foods` 拉官方营养表，再 `query-nearby-stores` 取示例门店，最后 `query-meals` 取该店在售菜单与实时价，三源按餐品名称合并写入 `assets/menu-data.js`（`live:true`）。
- 落地结果：**154 个餐品**（breakfast / burger / side / drink / dessert 五类），其中 **32 个**带有效官方 `productCode`，可直接下单。
- 实测确认字段口径：菜单里存的 `code` = `details` 映射的 key（`1100`=巨无霸、`1406`=板烧鸡腿堡、`4810`=中薯条），可直接作 `productCode`；价格单位为**分**，展示除以 100；支付链接字段为 `data.payH5Url`。

## 4. 核心实现

- **形态**：移动端 Web 小程序（`index.html` + `assets/*`，无构建、可直接 GitHub Pages 运行）+ WorkBuddy Skill（`SKILL.md`）双交付，既满足"小程序"体感，又满足大赛"Skill + 真实使用 MCP"要求。
- **推荐引擎**：`assets/app.js` 中 `buildCombos()` 枚举「主食 + 可选小食 + 饮品」，`pickBest()` 按四种策略打分：
  - 性价比最高 = max(蛋白质 / 元)
  - 热量最低 = min(总热量)
  - 高蛋白增肌 = max(蛋白质 − 0.3×脂肪)
  - 均衡营养 = min(|宏量比例 − 3:2.5:4.5|)
- **口语化记账**：`assets/food-db.js` 内置约 100 种常见食物，`parseMealText()` 拆句 → 识别食物与数量 → 折算热量，解决"用户不知道多少卡"的真实痛点。
- **一键下单**：`scripts/serve.mjs` 提供同源代理 `POST /api/mcp { tool, args }`，后端持 Token 转发官方 MCP；前端购物车 → 选店 → `calculate-price` → 二次确认 → `create-order`，拿到订单号 + 支付 H5 链接。

## 5. 迭代记录（按用户反馈逐轮修复）

| # | 用户反馈 | 处理 |
| --- | --- | --- |
| 1 | 不知道怎么算热量，只会说"一碗米饭、两个水煮蛋…" | 新增 `food-db.js` 口语化解析器，输入食物名+数量自动折算热量 |
| 2 | 选好食物后要能直接连麦当劳下单 | 加后端代理 + 购物车 + 算价 + 下单全链路，浏览器不直连官方域名，Token 仅后端 |
| 3 | 手机怎么运行 / 换 WiFi IP 就变 | `serve.mjs` 绑定 `0.0.0.0`、自动打印 WLAN 真实网卡 IP（跳过 VPN/蓝牙虚拟网卡）；README 补 Windows PowerShell 与手机同 Wi-Fi 步骤；再补 Render 公网部署方案（`render.yaml`），彻底摆脱 IP |
| 4 | 支付必须装麦当劳 App 吗 | 实测建单抓取支付页 HTML，确认 `payH5Url` 是纯 H5 扫码支付页，微信内可直接付，不强制 App，并修正界面文案 |
| 5 | 菜单食物加不进购物车 | 根因是 154 个单品只有部分带有效编码、按钮外观无差异。加「全部单品 / 仅可下单」筛选；不可下单按钮变灰 🔒 并给明确提示；实测剔除失效码（雪碧 `3010`） |
| 6 | 点"确认下单"完全没反应 | 根因是按钮初始 `disabled`，禁用按钮不触发点击。改为始终可点 + 自动先算价再弹确认 + 错误持久显示 |
| 7 | 算价显示 ¥0.00、下单无订单号 | 根因是手机缓存旧 JS + 代码未判 `success:false` 业务失败。静态资源加 `no-store` 与版本号，补业务成功判断 |
| 8 | 正式上线不想反复改 IP | 加 `ORDER_MODE`（readonly/full）与 `ORDER_ACCESS_CODE` 安全开关 + `/api/config`，前端自动适配；`render.yaml` 一键部署 |

## 6. 验证记录

- `node --check` 通过 `assets/app.js`、`scripts/serve.mjs`、`scripts/sync-nutrition.mjs`。
- 菜单数据：154 个单品、`live:true`、32 个可下单；失效编码已黑名单排除。
- 口语解析实测：「一碗米饭、两个水煮蛋、一盘蒜蓉生菜、4个奥尔良鸡翅」→ 米饭 230 + 水煮蛋 140 + 蒜蓉生菜 85 + 奥尔良鸡翅 460 = **915 kcal**，4 项全部命中。
- 官方 MCP 实链验证：`calculate-price` 巨无霸(1100)+中薯条(4810) = **¥39.00**（2550+1350 分），取餐方式返回 `堂食/外带`；`create-order` 真实建单返回 `orderId` + `payH5Url`，测试单均用 `cancel-order` 清理，无残留待支付订单。

## 7. 交付状态

- 代码与文档全部完成并通过验证，仓库待用户推送至 GitHub 公开仓并按官方格式提交报名 Issue。
- 本机无 `gh` CLI，故仓库创建/推送由用户在网页端与本地 git 完成；MCP Token 仅存于本地 `.env`（已 `.gitignore`），未入库、未写入任何提交材料。
