#!/usr/bin/env node
/**
 * serve.mjs — 本地预览服务器 + 麦当劳 MCP 下单代理
 * --------------------------------------------------------------------------
 * 静态预览：  node scripts/serve.mjs            → http://localhost:5173
 * 下单代理：  MCD_MCP_TOKEN=你的token node scripts/serve.mjs
 *   （token 仅在后端内存中使用，绝不下发到前端，也不写入任何文件）
 *
 * 前端通过同源 POST /api/mcp 调用官方 MCP，避免浏览器直连 mcp.mcd.cn 的
 * CORS 限制与 token 泄露问题。代理为「业务级封装」：
 *   POST /api/mcp  { tool: "calculate-price", args: {...} }
 *   → { ok: true, text: "...", json: {...} } | { ok: false, error: "..." }
 * --------------------------------------------------------------------------
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { networkInterfaces } from "node:os";

// 取本机局域网 IPv4 列表（跳过 VPN/TAP/蓝牙/链路本地等虚拟网卡），方便手机同 Wi-Fi 访问
function lanIPs() {
  const nets = networkInterfaces();
  const skip = /tap|outline|vpn|loopback|bluetooth|isatap|6to4|teredo|vmware|virtualbox|docker|vethernet|vethernet/i;
  const out = [];
  for (const name of Object.keys(nets)) {
    if (skip.test(name)) continue;
    for (const net of nets[name] || []) {
      if (net.family === "IPv4" && !net.internal && !net.address.startsWith("169.254.")) out.push(net.address);
    }
  }
  return [...new Set(out)];
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = process.env.PORT || 5173;
const MCP_ENDPOINT = "https://mcp.mcd.cn";
// 从本地 .env 读取 token（不覆盖已有环境变量）；.env 已被 .gitignore 忽略，绝不入库
try {
  const envText = readFileSync(join(ROOT, ".env"), "utf8");
  envText.split("\n").forEach((l) => {
    const i = l.indexOf("=");
    if (i > 0) { const k = l.slice(0, i).trim(); const v = l.slice(i + 1).trim(); if (k && !(k in process.env)) process.env[k] = v; }
  });
} catch {}
const MCP_TOKEN = process.env.MCD_MCP_TOKEN || "";
// —— 公网部署安全开关（本地不使用，留空即保持原有行为）——
// ORDER_MODE=readonly        → 永久禁止下单/取消/查订单（纯演示），即使有口令也不放行
// ORDER_ACCESS_CODE=你的口令 → 所有 /api/mcp 调用须带正确口令，适合「加口令才可下单」
const ORDER_MODE = process.env.ORDER_MODE || "full";
const ACCESS_CODE = process.env.ORDER_ACCESS_CODE || "";
// 涉及真实交易或隐私的工具
const GUARDED_TOOLS = new Set(["create-order", "cancel-order", "order-list"]);
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

/* ============================ MCP 代理 ============================ */
async function mcpRaw(method, params, id) {
  const body = { jsonrpc: "2.0", method, params: params ?? {} };
  if (id !== undefined && id !== null) body.id = id;
  const res = await fetch(MCP_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${MCP_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  if (res.status === 202 || res.status === 204) return null;
  const ct = res.headers.get("content-type") || "";
  const text = await res.text();
  let parsed;
  if (ct.includes("text/event-stream")) {
    const evs = text.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim()).filter(Boolean);
    parsed = evs.length ? JSON.parse(evs[evs.length - 1]) : null;
  } else {
    parsed = text ? JSON.parse(text) : null;
  }
  if (parsed && parsed.error) throw new Error(parsed.error.message || JSON.stringify(parsed.error));
  return parsed;
}

function extractText(result) {
  const c = result?.result?.content || result?.content;
  if (!c) return null;
  if (typeof c === "string") return c;
  return c.filter((x) => x.type === "text").map((x) => x.text).join("\n");
}

function extractJson(text) {
  if (!text) return null;
  const i = text.indexOf("## Original Response");
  const s = i >= 0 ? text.slice(i) : text;
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a < 0 || b < 0) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

let initialized = false;
async function mcpCall(tool, args) {
  if (!initialized) {
    await mcpRaw("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "m-buddy-proxy", version: "1.0.0" } }, 1);
    initialized = true;
  }
  const r = await mcpRaw("tools/call", { name: tool, arguments: args || {} }, 2);
  const text = extractText(r);
  return { text, json: extractJson(text) };
}

/* ============================ 路由 ============================ */
createServer(async (req, res) => {
  try {
    const url = req.url.split("?")[0];

    // ---- MCP 代理 ----
    if (url === "/api/mcp" && req.method === "POST") {
      if (!MCP_TOKEN) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "未配置 MCD_MCP_TOKEN：请用 MCD_MCP_TOKEN=你的token node scripts/serve.mjs 启动本服务" }));
        return;
      }
      let body = "";
      req.on("data", (c) => (body += c));
      await new Promise((r) => req.on("end", r));
      let payload;
      try { payload = JSON.parse(body); } catch {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "请求体不是合法 JSON" }));
        return;
      }
      const { tool, args, code } = payload;
      if (!tool) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "缺少 tool 字段" }));
        return;
      }
      // 只读演示模式：禁止真实交易与隐私查询
      if (ORDER_MODE === "readonly" && GUARDED_TOOLS.has(tool)) {
        res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "当前为只读演示模式，禁止下单/取消/查询订单" }));
        return;
      }
      // 口令校验（若设置了 ORDER_ACCESS_CODE）
      if (ACCESS_CODE && code !== ACCESS_CODE) {
        res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, needCode: true, error: "需要访问口令" }));
        return;
      }
      try {
        const out = await mcpCall(tool, args);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, text: out.text, json: out.json }));
      } catch (e) {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    // ---- 运行配置（前端据此调整界面）----
    if (url === "/api/config") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ readonly: ORDER_MODE === "readonly", needCode: !!ACCESS_CODE }));
      return;
    }

    // ---- 静态文件 ----
    let p = decodeURIComponent(url);
    if (p === "/") p = "/index.html";
    const file = normalize(join(ROOT, p));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end("forbidden"); return; }
    const data = await readFile(file);
    res.writeHead(200, {
      "Content-Type": MIME[extname(file)] || "application/octet-stream",
      // 禁止浏览器缓存，避免手机上一直跑旧版 JS/CSS
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      Pragma: "no-cache",
      Expires: "0",
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("404 Not Found");
  }
}).listen(PORT, "0.0.0.0", () => {
  const lans = lanIPs();
  console.log(`M-buddy 预览（本机）：http://localhost:${PORT}`);
  if (lans.length) {
    console.log(`📱 手机访问（同一 Wi-Fi），任选一个地址打开：`);
    lans.forEach((ip) => console.log(`   http://${ip}:${PORT}`));
  } else {
    console.log(`⚠️ 未检测到局域网 IP，请用电脑内网 IP 访问（ipconfig 查 IPv4）`);
  }
  console.log(MCP_TOKEN ? "✅ MCP 下单代理已启用（token 仅后端使用）" : "⚠️ 未配置 MCD_MCP_TOKEN：仅静态预览，下单功能需带 token 重启");
});
