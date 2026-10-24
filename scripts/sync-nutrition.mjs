#!/usr/bin/env node
/**
 * sync-nutrition.mjs — 通过官方麦当劳 MCP 拉取真实餐品数据并生成菜单
 * --------------------------------------------------------------------------
 * 用法：
 *   MCD_MCP_TOKEN=你的token node scripts/sync-nutrition.mjs
 *   可选：MCD_CITY=广州 MCD_KEYWORD=天河  （决定示例门店）
 *
 * 数据源（均为官方 MCP mcp.mcd.cn）：
 *   1) list-nutrition-foods  → 每个餐品的能量/蛋白/脂肪/碳水/钠/钙（已直接给 kcal）
 *   2) query-nearby-stores   → 取一个示例门店编码（默认广州）
 *   3) query-meals           → 该门店在售菜单：分类、现价、标签、图片
 * 两源按「餐品名称」合并（分类用子串模糊，价格仅安全匹配），输出 assets/menu-data.js（live:true）。
 *
 * 协议：Streamable HTTP，鉴权 Authorization: Bearer <token>
 * 参考：https://github.com/M-China/mcd-mcp-server
 * --------------------------------------------------------------------------
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENDPOINT = "https://mcp.mcd.cn";
const TOKEN = process.env.MCD_MCP_TOKEN;

if (!TOKEN) {
  console.error("❌ 请先设置环境变量 MCD_MCP_TOKEN（在 open.mcd.cn 控制台申请后复制）");
  console.error("   例：MCD_MCP_TOKEN=xxxx node scripts/sync-nutrition.mjs");
  process.exit(1);
}

const HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
  Authorization: `Bearer ${TOKEN}`,
};

let reqId = 1;
const nextId = () => reqId++;

async function rpc(method, params, id) {
  const body = { jsonrpc: "2.0", method, params: params ?? {} };
  if (id !== null && id !== undefined) body.id = id;
  const res = await fetch(ENDPOINT, { method: "POST", headers: HEADERS, body: JSON.stringify(body) });
  if (res.status === 202 || res.status === 204) return null;
  const ct = res.headers.get("content-type") || "";
  const text = await res.text();
  let parsed;
  if (ct.includes("text/event-stream")) {
    const events = text.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim()).filter(Boolean);
    parsed = events.length ? JSON.parse(events[events.length - 1]) : null;
  } else {
    parsed = text ? JSON.parse(text) : null;
  }
  if (parsed && parsed.error) throw new Error(`MCP error: ${JSON.stringify(parsed.error)}`);
  return parsed;
}

function extractText(result) {
  const content = result?.result?.content || result?.content;
  if (!content) return null;
  if (typeof content === "string") return content;
  return content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
}

function cleanNum(v) {
  if (v == null) return 0;
  const s = String(v).trim();
  if (s === "" || s === "null") return 0;
  const n = parseFloat(s.replace(/[^\d.\-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/** 从「自然语言包装 + 原始 JSON」文本里抽取 Original Response 的 JSON 对象 */
function extractJsonObject(text) {
  const marker = "## Original Response";
  let slice = text;
  const i = text.indexOf(marker);
  if (i >= 0) slice = text.slice(i);
  const start = slice.indexOf("{");
  const end = slice.lastIndexOf("}");
  if (start < 0 || end < 0) return null;
  return JSON.parse(slice.slice(start, end + 1));
}

/** 解析 list-nutrition-foods 的 data 字符串表格 */
function parseNutritionTable(dataStr) {
  const lines = dataStr.split("\n").map((l) => l.trim()).filter(Boolean);
  const headerIdx = lines.findIndex((l) => l.includes("{") && l.includes("}"));
  if (headerIdx < 0) return {};
  const fields = lines[headerIdx].match(/\{([^}]*)\}/)[1].split(",").map((f) => f.trim());
  const iName = fields.indexOf("productName");
  const iKj = fields.indexOf("energyKj");
  const iKcal = fields.indexOf("energyKcal");
  const iPro = fields.indexOf("protein");
  const iFat = fields.indexOf("fat");
  const iCarb = fields.indexOf("carbohydrate");
  const iNa = fields.indexOf("sodium");
  const iDesc = fields.indexOf("nutritionDescription");
  const out = {};
  for (const row of lines.slice(headerIdx + 1)) {
    const c = row.split(",");
    if (c.length < fields.length) continue;
    const name = (c[iName] || "").trim();
    if (!name) continue;
    const kcalRaw = cleanNum(c[iKcal]);
    const kjRaw = cleanNum(c[iKj]);
    const kcal = kcalRaw || (kjRaw ? Math.round(kjRaw / 4.184) : 0);
    if (!kcal) continue;
    out[name] = {
      kcal,
      protein: cleanNum(c[iPro]),
      fat: cleanNum(c[iFat]),
      carbs: cleanNum(c[iCarb]),
      sodium: cleanNum(c[iNa]),
      desc: iDesc >= 0 && c[iDesc] && c[iDesc].trim() !== "null" ? c[iDesc].trim() : "",
    };
  }
  return out;
}

/** 解析 query-meals → 名称映射 {cat,price,tags,img} */
function buildMealsMap(text) {
  const json = extractJsonObject(text);
  const data = json?.data || json;
  const map = {};
  const cats = data?.categories || [];
  const details = data?.meals || {};
  for (const cat of cats) {
    for (const meal of cat.meals || []) {
      const d = details[meal.code];
      const name = (d?.name || meal.name || "").trim();
      if (!name || map[name]) continue;
      map[name] = {
        cat: cat.name,
        code: meal.code || "",
        price: cleanNum(d?.currentPrice),
        tags: Array.isArray(d?.tags) ? d.tags : [],
        img: d?.image || "",
      };
    }
  }
  return map;
}

/** 分类：尺寸不影响分类，子串模糊即可 */
function fuzzyCat(name, mealsMap) {
  if (mealsMap[name]) return mealsMap[name].cat;
  for (const m of Object.keys(mealsMap)) if (name.includes(m)) return mealsMap[m].cat;
  return null;
}

/** 价格：仅精确或「安全尺寸匹配」，避免大份套中份价 */
function safePriceName(name, mealsMap) {
  if (mealsMap[name]) return name;
  const v = name.replace(/（[^）]*）/g, "").replace(/[\d]+块$/, "").replace(/(中|大|小|迷你)[杯份]?$/, "");
  if (mealsMap[v]) return v;
  for (const m of Object.keys(mealsMap)) {
    if (name.includes(m)) {
      let rest = name.replace(m, "").replace(/（[^）]*）/g, "").replace(/^[-－]/, "").replace(/[\d]+块$/, "");
      if (rest === "" || /^(中|小|迷你)?$/.test(rest)) return m; // 显式排除含「大」
    }
  }
  return null;
}

function normCat(c) {
  return (c || "").replace(/[\n\r]/g, "").replace(/\s*\/\s*/g, "/").trim();
}

/** 名称优先归一化到内部 cat 枚举；分类名（已去换行）作兜底 */
function mapCat(chineseCat, name) {
  const cn = normCat(chineseCat);
  const n = name || "";
  if (/套餐|组合/.test(cn)) return "combo";
  // 名称优先（最可靠）
  if (/早餐|麦满分|早晨/.test(n)) return "breakfast";
  if (/甜品|新地|麦旋风|冰淇淋|圆筒|派/.test(n)) return "dessert";
  if (/饮品|可乐|雪碧|咖啡|豆浆|茶|橙汁|牛奶|麦咖啡|mcaf|McCaf/.test(n)) return "drink";
  if (/小食|薯条|鸡翅|麦乐鸡|玉米杯|脆鸡|鸡块|炸鸡|蘸酱/.test(n)) return "side";
  if (/汉堡|鸡腿堡|牛肉堡|板烧|吉士|麦香|巨无霸|卷|培根|猪柳|烟肉|火腿|鱼堡|双层|安格斯|厚牛/.test(n)) return "burger";
  // 分类名兜底
  if (/早餐|麦满分|早晨/.test(cn)) return "breakfast";
  if (/饮品|饮料|咖啡|可乐|雪碧|豆浆|茶|橙汁|牛奶|麦咖啡/.test(cn)) return "drink";
  if (/甜品|新地|麦旋风|冰淇淋|圆筒|派/.test(cn)) return "dessert";
  if (/小食|薯条|鸡翅|麦乐鸡|玉米杯|脆鸡|鸡块|炸鸡|蘸酱/.test(cn)) return "side";
  if (/汉堡|牛堡|卷|鸡腿堡|板烧|吉士|麦香|巨无霸|培根|猪柳|烟肉|火腿|鱼堡|双层|安格斯|厚牛/.test(cn)) return "burger";
  return "burger";
}

function guessTags(name) {
  const n = name || "";
  const t = [];
  if (/鸡|牛|鱼|虾|蛋|蛋白/.test(n)) t.push("高蛋白");
  if (/蔬|菜|玉米|沙拉/.test(n)) t.push("蔬菜");
  if (/辣/.test(n)) t.push("香辣");
  if (/零度|无糖|黑咖啡|纯茶|水/.test(n)) t.push("0糖");
  if (/薯条|炸|派|新地|麦旋风|冰淇淋/.test(n)) t.push("高油");
  return t;
}

async function getStoreCode() {
  const r = await rpc(
    "tools/call",
    { name: "query-nearby-stores", arguments: { searchType: 2, city: process.env.MCD_CITY || "广州", keyword: process.env.MCD_KEYWORD || "天河", beType: 1 } },
    nextId()
  );
  const json = extractJsonObject(extractText(r));
  const list = json?.data || [];
  if (!list.length) throw new Error("未找到可用门店");
  console.log(`  示例门店：${list[0].storeName} (${list[0].storeCode})`);
  return list[0];
}

async function main() {
  console.log("→ 初始化 MCP 连接 ...");
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "m-buddy-sync", version: "1.0.0" } }, nextId());
  console.log("  ok (mcd-mcp)");

  console.log("→ list-nutrition-foods ...");
  const nutText = extractText(await rpc("tools/call", { name: "list-nutrition-foods", arguments: {} }, nextId()));
  if (!nutText) throw new Error("未获取到营养数据");
  const nutJson = extractJsonObject(nutText);
  const nutrition = parseNutritionTable(nutJson?.data?.data || nutJson?.data);
  if (!Object.keys(nutrition).length) throw new Error("营养解析为空");
  console.log(`  营养条目：${Object.keys(nutrition).length}`);
  writeFileSync(join(__dirname, "..", "data", "raw-nutrition.json"), JSON.stringify({ nutText }, null, 2), "utf8");

  console.log("→ query-nearby-stores（取示例门店）...");
  const store = await getStoreCode();
  console.log("→ query-meals ...");
  const mealText = extractText(
    await rpc("tools/call", { name: "query-meals", arguments: { storeCode: store.storeCode, orderType: 1, beType: 1 } }, nextId())
  );
  if (!mealText) throw new Error("未获取到菜单数据");
  const mealsMap = buildMealsMap(mealText);
  console.log(`  菜单单品：${Object.keys(mealsMap).length}（含价格 ${Object.values(mealsMap).filter((m) => m.price > 0).length}）`);
  writeFileSync(join(__dirname, "..", "data", "raw-meals.json"), JSON.stringify({ store, mealText }, null, 2), "utf8");

  const items = [];
  for (const [name, nut] of Object.entries(nutrition)) {
    const pName = safePriceName(name, mealsMap);
    const price = pName ? mealsMap[pName].price : 0;
    const rawCat = (pName && mealsMap[pName].cat) || fuzzyCat(name, mealsMap) || null;
    const cat = mapCat(rawCat, name);
    if (cat === "combo") continue;
    const tags = (pName && mealsMap[pName].tags.length ? mealsMap[pName].tags : guessTags(name)).slice(0, 5);
    items.push({
      id: "mcp-" + items.length,
      name,
      cat,
      code: pName ? mealsMap[pName].code : "",
      kcal: nut.kcal,
      protein: nut.protein,
      fat: nut.fat,
      carbs: nut.carbs,
      sodium: nut.sodium,
      price,
      tags,
      img: pName ? mealsMap[pName].img : "",
    });
  }
  if (!items.length) throw new Error("合并后无有效餐品");
  items.sort((a, b) => a.cat.localeCompare(b.cat) || a.name.localeCompare(b.name, "zh"));

  const date = new Date().toISOString().slice(0, 10);
  const out =
    "/*\n * M-buddy 轻食版 — 麦当劳菜单营养数据（官方 MCP 实时拉取）\n" +
    ` * 拉取时间：${date}\n` +
    ` * 示例门店：${store.storeName} (${store.storeCode})，价格以该门店到店自取实时价为准\n` +
    " * 营养源：list-nutrition-foods ｜ 分类/价格源：query-meals\n" +
    " * 端点：https://mcp.mcd.cn ｜ 本文件由 scripts/sync-nutrition.mjs 自动生成，请勿手动编辑。\n" +
    " */\n" +
    "window.MENU_META = { updated: " + JSON.stringify(date) +
    ', live: true, source: "麦当劳官方 MCP 实时数据 (list-nutrition-foods + query-meals)" };\n' +
    "window.MENU = " + JSON.stringify(items, null, 2) + ";\n";
  writeFileSync(join(__dirname, "..", "assets", "menu-data.js"), out, "utf8");

  const byCat = {};
  let priced = 0;
  for (const it of items) { byCat[it.cat] = (byCat[it.cat] || 0) + 1; if (it.price > 0) priced++; }
  console.log(`✅ 写入 ${items.length} 个餐品到 assets/menu-data.js（live:true）`);
  console.log(`   有价格：${priced} ｜ 分类：${JSON.stringify(byCat)}`);
  console.log("   示例：", items.filter((i) => i.price > 0).slice(0, 4).map((i) => `${i.name}(${i.kcal}kcal/¥${i.price})`).join("  "));
}

main().catch((e) => { console.error("❌ 同步失败：", e.message); process.exit(1); });
