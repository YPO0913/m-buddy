/* M-buddy 轻食版 — 前端逻辑与减脂套餐推荐引擎 */
(function () {
  "use strict";

  const MENU = window.MENU || [];
  const META = window.MENU_META || {};
  const CATS = [
    { key: "all", label: "全部" },
    { key: "burger", label: "汉堡/卷" },
    { key: "side", label: "小食配菜" },
    { key: "drink", label: "饮品" },
    { key: "dessert", label: "甜品" },
    { key: "breakfast", label: "早餐" },
  ];
  const PRESETS = [
    ["白粥一碗", 90], ["肉包", 230], ["菜包", 160], ["米饭一碗", 230], ["面条一碗", 350],
    ["煮鸡蛋", 70], ["全麦面包2片", 160], ["牛奶250ml", 150], ["无糖豆浆", 90], ["苹果", 95],
    ["香蕉", 105], ["鸡胸肉100g", 165], ["西兰花100g", 35], ["牛油果半个", 160],
    ["三文鱼100g", 200], ["无酱沙拉", 120], ["无糖酸奶", 70], ["燕麦30g", 110],
    ["红薯150g", 130], ["豆腐100g", 80], ["美式咖啡", 5], ["奶茶(全糖)", 300],
    ["可乐", 150], ["啤酒330ml", 140], ["巧克力", 230], ["蛋糕一块", 350],
    ["外卖快餐一餐", 700], ["火锅一餐", 900],
  ];

  // 官方 MCP 实测不可下单的 productCode（界面会标记为非可下单）
  const INVALID_CODES = new Set(["3010"]); // 雪碧三个规格共享此码，下单失败
  let onlyOrderable = false;
  // 是否已成功算价（create-order 需要 calculate-price 返回的 takeWayCode）
  let priced = false;
  // 公网部署模式（由 /api/config 下发；本地运行均为 false/""）
  let READONLY = false;
  let ACCESS_CODE = "";
  // 购物车/门店/取餐方式变化后价格失效，需重新算价
  function resetPrice() {
    priced = false;
    $("#pricePreview").classList.add("hidden");
    $("#takeWayRow").classList.add("hidden");
  }
  const isOrderable = (m) => !!(m && m.code && !INVALID_CODES.has(String(m.code)));

  const STATE = loadState();
  if (!STATE.cart) STATE.cart = [];
  if (!STATE.store) STATE.store = { code: "1400359", name: "麦当劳广州天源路餐厅" };
  if (!STATE.beType) STATE.beType = 1;

  // ---------- 状态持久化 ----------
  function loadState() {
    try {
      const s = JSON.parse(localStorage.getItem("mbuddy") || "null");
      if (s) return s;
    } catch (e) {}
    return { gender: "f", goal: 1500, intake: [] };
  }
  function save() {
    try { localStorage.setItem("mbuddy", JSON.stringify(STATE)); } catch (e) {}
  }

  // ---------- 工具 ----------
  const $ = (sel) => document.querySelector(sel);
  const sum = (arr, k) => arr.reduce((a, b) => a + (b[k] || 0), 0);
  const kcalClass = (k) => (k <= 200 ? "lo" : k <= 450 ? "mid" : "hi");
  const fmtPrice = (p) => (p > 0 ? "¥" + p : "门店价");

  // ---------- 今日：目标 & 状态 ----------
  function renderGoal() {
    $("#goalVal").textContent = STATE.goal;
    $("#targetNum").textContent = STATE.goal;
    $("#goalInput").value = "";
    document.querySelectorAll("#genderSeg button").forEach((b) =>
      b.classList.toggle("active", b.dataset.g === STATE.gender)
    );
  }
  function renderStatus() {
    const intake = sum(STATE.intake, "kcal");
    const remain = STATE.goal - intake;
    $("#intakeNum").textContent = Math.round(intake);
    $("#remainNum").textContent = Math.round(remain);
    const pct = Math.max(0, Math.min(100, (intake / STATE.goal) * 100));
    const ring = $("#ring");
    ring.style.background = `conic-gradient(var(--accent) ${pct * 3.6}deg, var(--line) 0deg)`;
    const v = $("#verdict");
    v.className = "verdict";
    if (STATE.intake.length === 0) {
      v.textContent = "先记下今天吃过什么 👇";
    } else if (remain > 300) {
      v.textContent = "额度充足，可以放心点一顿麦麦 ✅";
    } else if (remain >= 0) {
      v.textContent = "额度偏紧，建议选低卡/高蛋白组合 ⚠️";
      v.classList.add("warn");
    } else {
      v.textContent = "今日已超标 " + Math.round(-remain) + " kcal，建议只喝零卡饮品 🚫";
      v.classList.add("danger");
    }
  }
  function renderPresets() {
    const box = $("#presetChips");
    box.innerHTML = "";
    PRESETS.forEach(([name, k]) => {
      const c = document.createElement("button");
      c.className = "chip";
      c.textContent = `${name} ${k}`;
      c.onclick = () => addIntake(name, k);
      box.appendChild(c);
    });
  }
  function renderIntake() {
    const ul = $("#intakeList");
    ul.innerHTML = "";
    if (!STATE.intake.length) {
      ul.innerHTML = '<li class="empty">还没有记录，上面说一句「一碗米饭、两个鸡蛋」试试 👆</li>';
      return;
    }
    STATE.intake.forEach((it, i) => {
      const li = document.createElement("li");
      li.innerHTML = `<span>${it.name}<span class="k">${Math.round(it.kcal)} kcal</span></span>`;
      const del = document.createElement("button");
      del.className = "del";
      del.textContent = "✕";
      del.onclick = () => { STATE.intake.splice(i, 1); save(); renderIntake(); renderStatus(); };
      li.appendChild(del);
      ul.appendChild(li);
    });
  }
  function addIntake(name, kcal) {
    if (!name) return;
    STATE.intake.push({ name, kcal: Number(kcal) || 0 });
    save(); renderIntake(); renderStatus();
  }

  // ---------- 自然语言：「说说今天吃了什么」自动算热量 ----------
  let nlItems = [];
  function runParse() {
    const txt = ($("#nlInput").value || "").trim();
    if (!txt) { flash("先说说你吃了什么～"); return; }
    nlItems = window.parseMealText ? window.parseMealText(txt) : [];
    if (!nlItems.length) { flash("没识别到内容，换个说法试试"); return; }
    renderNlPreview();
  }
  function renderNlPreview() {
    const box = $("#nlPreview");
    box.innerHTML = "";
    box.classList.remove("hidden");
    const ok = nlItems.filter((i) => i.matched);
    const miss = nlItems.filter((i) => !i.matched);
    nlItems.forEach((it) => {
      const row = document.createElement("div");
      row.className = "nl-item" + (it.matched ? "" : " miss");
      if (it.matched) {
        row.innerHTML = `<span class="tick">✓</span><span class="nm">${it.label}${it.approx ? '<em>（近似）</em>' : ""}</span><span class="kc">${Math.round(it.kcal)} kcal</span>`;
      } else {
        row.innerHTML = `<span class="tick">?</span><span class="nm">${it.raw}<em>（未识别，可手动补热量）</em></span>`;
        const inp = document.createElement("input");
        inp.type = "number"; inp.placeholder = "kcal"; inp.className = "nl-kcal"; inp.inputMode = "numeric";
        const add = document.createElement("button");
        add.className = "nl-mini"; add.textContent = "补录";
        add.onclick = () => {
          const v = parseFloat(inp.value);
          if (isNaN(v) || v <= 0) { flash("先填个热量"); return; }
          addIntake(it.raw, v); flash("已补录：" + it.raw);
          row.classList.remove("miss");
          row.innerHTML = `<span class="tick">✓</span><span class="nm">${it.raw}</span><span class="kc">${Math.round(v)} kcal</span>`;
        };
        row.appendChild(inp); row.appendChild(add);
      }
      box.appendChild(row);
    });
    const total = ok.reduce((a, b) => a + b.kcal, 0);
    const bar = document.createElement("div");
    bar.className = "nl-bar";
    bar.innerHTML = `<span>识别 <b>${ok.length}</b> 项 · 约 <b>${Math.round(total)}</b> kcal${miss.length ? ` · ${miss.length} 项待补` : ""}</span>`;
    const btn = document.createElement("button");
    btn.className = "nl-confirm";
    btn.textContent = "全部加入今日已吃";
    btn.onclick = () => {
      if (!ok.length) { flash("没有可加入的项"); return; }
      ok.forEach((it) => addIntake(it.label, it.kcal));
      flash(`已记录 ${ok.length} 项，共 ${Math.round(total)} kcal`);
      $("#nlInput").value = ""; box.classList.add("hidden"); nlItems = [];
    };
    bar.appendChild(btn);
    box.appendChild(bar);
  }

  // ---------- 菜单 ----------
  let curCat = "all", curSearch = "";
  function renderCats() {
    const box = $("#catTabs");
    box.innerHTML = "";
    CATS.forEach((c) => {
      const b = document.createElement("button");
      b.textContent = c.label;
      b.classList.toggle("active", c.key === curCat);
      b.onclick = () => { curCat = c.key; renderCats(); renderMenu(); };
      box.appendChild(b);
    });
  }
  function renderMenu() {
    const grid = $("#menuGrid");
    grid.innerHTML = "";
    const q = curSearch.trim().toLowerCase();
    const list = MENU.filter((m) => {
      if (curCat !== "all" && m.cat !== curCat) return false;
      if (onlyOrderable && !isOrderable(m)) return false;
      if (q && !(m.name.toLowerCase().includes(q) || (m.tags || []).join("").toLowerCase().includes(q))) return false;
      return true;
    });
    if (!list.length) {
      grid.innerHTML = '<p class="hint" style="grid-column:1/-1">' +
        (onlyOrderable ? "没有可下单的单品，切换「全部」看看～" : "没有匹配的单品") + "</p>";
      return;
    }
    list.forEach((m) => {
      const el = document.createElement("div");
      el.className = "food";
      const orderable = isOrderable(m);
      const tags = (m.tags || []).slice(0, 3).map((t) => `<span>${t}</span>`).join("");
      el.innerHTML = `
        <div class="fkcal ${kcalClass(m.kcal)}">${m.kcal} kcal</div>
        <button class="fadd" title="加入今日已吃">＋</button>
        <button class="fcart ${orderable ? "" : "locked"}" title="${orderable ? "加入购物车下单" : "该单品暂不支持一键下单"}">${orderable ? "🛒" : "🔒"}</button>
        <div class="fname">${m.name}</div>
        <div class="ftags">${tags}</div>
        <div class="fmacros">蛋${m.protein}g · 脂${m.fat}g · 碳${m.carbs}g · 钠${m.sodium}mg</div>
        <div class="fprice">${fmtPrice(m.price)}</div>`;
      el.querySelector(".fadd").onclick = (e) => {
        e.stopPropagation();
        addIntake(m.name, m.kcal);
        flash("已加入今日已吃：" + m.name);
      };
      el.querySelector(".fcart").onclick = (e) => {
        e.stopPropagation();
        if (!orderable) { flash("该单品暂无官方下单编码，点上方「仅可下单」看能买的"); return; }
        addToCart(m);
      };
      grid.appendChild(el);
    });
  }

  // ---------- 推荐引擎 ----------
  function buildCombos() {
    const mains = MENU.filter((i) => i.cat === "burger" || i.cat === "breakfast");
    const sides = MENU.filter((i) => i.cat === "side");
    const drinks = MENU.filter((i) => i.cat === "drink");
    const combos = [];
    const push = (items) => combos.push({
      items,
      kcal: sum(items, "kcal"), protein: sum(items, "protein"),
      fat: sum(items, "fat"), carbs: sum(items, "carbs"),
      sodium: sum(items, "sodium"), price: sum(items, "price"),
      allPriced: items.every((i) => i.price > 0),
    });
    for (const m of mains) {
      for (const s of [null, ...sides]) {
        for (const d of drinks) {
          const items = [m]; if (s) items.push(s); items.push(d);
          push(items);
        }
      }
    }
    for (const s of sides) for (const d of drinks) push([s, d]); // 低预算兜底
    for (const d of drinks) push([d]);
    return combos;
  }

  function pickBest(budget, filterFn, scoreFn) {
    const pool = buildCombos().filter((c) => c.kcal <= budget + 1 && filterFn(c));
    if (!pool.length) {
      // 预算过紧：放宽到任意不超过预算的组合
      const relaxed = buildCombos().filter((c) => c.kcal <= budget + 1);
      if (!relaxed.length) return null;
      return relaxed.sort((a, b) => a.kcal - b.kcal)[0];
    }
    return pool.sort((a, b) => scoreFn(b) - scoreFn(a))[0];
  }

  const STRATEGIES = [
    {
      key: "value", title: "💰 性价比最高", tag: "蛋白/元 最大化",
      filter: (c) => c.kcal >= 300 && c.protein >= 15 && c.allPriced,
      score: (c) => c.protein / (c.price + 1),
    },
    {
      key: "low", title: "🔥 热量最低", tag: "控制总热量",
      filter: (c) => c.kcal >= 250 && c.protein >= 10,
      score: (c) => -c.kcal,
    },
    {
      key: "protein", title: "💪 高蛋白增肌", tag: "蛋白优先·低脂",
      filter: (c) => c.protein >= 25 && c.kcal <= _budget,
      score: (c) => c.protein - 0.3 * c.fat,
    },
    {
      key: "balance", title: "⚖️ 均衡营养", tag: "宏量接近 3:2.5:4.5",
      filter: (c) => c.kcal >= 350,
      score: (c) => {
        const t = c.kcal || 1;
        const pk = (c.protein * 4) / t, fk = (c.fat * 9) / t, ck = (c.carbs * 4) / t;
        return -(Math.abs(pk - 0.3) + Math.abs(fk - 0.25) + Math.abs(ck - 0.45));
      },
    },
  ];
  // 高蛋白策略需在预算内，这里用闭包预算
  let _budget = 0;

  function renderRecommend() {
    const intake = sum(STATE.intake, "kcal");
    const budget = STATE.goal - intake;
    _budget = Math.max(budget, 0);
    $("#budgetNum").textContent = Math.round(Math.max(budget, 0));
    const hint = $("#budgetHint");
    if (STATE.intake.length === 0) {
      hint.textContent = "先到「今日」页记录已吃食物，系统才能算出还能吃多少。";
    } else if (budget <= 0) {
      hint.textContent = "今日额度已用完，仅建议零卡饮品。";
    } else {
      hint.textContent = `基于已摄入 ${Math.round(intake)} kcal，本餐建议控制在 ${Math.round(budget)} kcal 内。`;
    }
    const list = $("#recList");
    list.innerHTML = "";
    STRATEGIES.forEach((st) => {
      const best = pickBest(Math.max(budget, 0), st.filter, st.score);
      if (!best) return;
      const card = document.createElement("div");
      card.className = "rec";
      const itemsHtml = best.items
        .map((i) => `<div class="ri"><span>${i.name}</span><span>${i.kcal} kcal</span></div>`)
        .join("");
      const fit = best.kcal <= Math.max(budget, 0) + 1;
      card.innerHTML = `
        <div class="rec-head">${st.title}<span class="tag">${st.tag}</span></div>
        <div class="rec-items">${itemsHtml}</div>
        <div class="rec-stats">
          <span class="st">总热量 <b>${best.kcal}</b> kcal</span>
          <span class="st">蛋白 <b>${best.protein}</b>g</span>
          <span class="st">脂肪 ${best.fat}g</span>
          <span class="st">碳水 ${best.carbs}g</span>
          <span class="st">钠 ${best.sodium}mg</span>
          <span class="st">${best.allPriced ? "约 <b>¥" + best.price + "</b>" : "含门店实时价"}</span>
        </div>
        <div class="fit ${fit ? "ok" : "over"}">${fit ? "✅ 在今日剩余预算内" : "⚠️ 略超预算"}</div>
        <button class="rec-add">把这套加入今日已吃</button>
        <button class="rec-cart">🛒 加入购物车去下单</button>`;
      card.querySelector(".rec-add").onclick = () => {
        addIntake(st.title.replace(/[^一-龥]/g, "") + "套餐", best.kcal);
        flash("已记录该套餐热量");
        switchTab("today");
      };
      card.querySelector(".rec-cart").onclick = () => {
        let added = 0;
        best.items.forEach((i) => { if (isOrderable(i)) { addToCart(i); added++; } });
        if (added) { flash(`已加入购物车 ${added} 个单品，去「下单」页结算`); switchTab("cart"); }
        else flash("该组合无可下单单品");
      };
      list.appendChild(card);
    });
    if (!list.children.length) {
      list.innerHTML = '<p class="hint" style="margin:12px">暂无合适组合，试试降低目标或记录已吃食物。</p>';
    }
  }

  // ---------- 交互 ----------
  function flash(msg) {
    const t = document.createElement("div");
    t.textContent = msg;
    t.style.cssText = "position:fixed;left:50%;bottom:90px;transform:translateX(-50%);background:var(--accent);color:#fff;padding:8px 16px;border-radius:999px;font-size:13px;z-index:50;box-shadow:var(--shadow)";
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 1400);
  }
  function switchTab(tab) {
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.add("hidden"));
    $("#panel-" + tab).classList.remove("hidden");
    document.querySelectorAll(".tabbar .tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    if (tab === "rec") renderRecommend();
  }

  function bind() {
    document.querySelectorAll("#genderSeg button").forEach((b) =>
      b.onclick = () => {
        STATE.gender = b.dataset.g;
        STATE.goal = b.dataset.g === "f" ? 1500 : 1800;
        save(); renderGoal(); renderStatus();
      }
    );
    $("#goalInput").onchange = (e) => {
      const v = parseInt(e.target.value, 10);
      if (v > 0) { STATE.goal = v; save(); renderGoal(); renderStatus(); }
    };
    $("#addCustom").onclick = () => {
      const n = $("#customName").value.trim();
      const k = parseFloat($("#customKcal").value);
      if (n && !isNaN(k)) { addIntake(n, k); $("#customName").value = ""; $("#customKcal").value = ""; }
    };
    $("#nlParse").onclick = runParse;
    $("#nlInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); runParse(); }
    });
    $("#nlExample").onclick = () => {
      $("#nlInput").value = "一碗米饭、两个水煮蛋、一盘蒜蓉生菜、4个奥尔良鸡翅";
      runParse();
    };
    $("#menuSearch").oninput = (e) => { curSearch = e.target.value; renderMenu(); };
    document.querySelectorAll("#orderFilter button").forEach((b) =>
      b.onclick = () => {
        onlyOrderable = b.dataset.o === "1";
        document.querySelectorAll("#orderFilter button").forEach((x) => x.classList.toggle("active", x === b));
        renderMenu();
      }
    );
    const oc = MENU.filter(isOrderable).length;
    const ob = document.querySelector('#orderFilter [data-o="1"]');
    if (ob) ob.textContent = `仅可下单 (${oc})`;
    document.querySelectorAll(".tabbar .tab").forEach((b) => b.onclick = () => switchTab(b.dataset.tab));

    const badge = $("#liveBadge");
    if (META.live) { badge.textContent = "官方实时"; badge.classList.add("live"); }
    else { badge.textContent = "快照数据"; }

    // 下单相关
    document.querySelectorAll("#beTypeSeg button").forEach((b) =>
      b.onclick = () => {
        document.querySelectorAll("#beTypeSeg button").forEach((x) => x.classList.toggle("active", x === b));
        STATE.beType = parseInt(b.dataset.be, 10);
        $("#addrRow").classList.toggle("hidden", STATE.beType !== 2);
        resetPrice();
      }
    );
    $("#changeStore").onclick = () => { $("#storeSearch").classList.toggle("hidden"); $("#storeRow").classList.add("hidden"); };
    $("#storeQuery").onclick = queryStores;
    $("#calcBtn").onclick = calcPrice;
    $("#orderBtn").onclick = openConfirm;
    $("#confirmCancel").onclick = () => $("#confirmModal").classList.add("hidden");
    $("#confirmOk").onclick = doCreateOrder;
  }

  // ---------- 购物车与下单 ----------
  function addToCart(m) {
    if (!m || !m.code) { flash("该单品暂未匹配官方编码，无法一键下单"); return; }
    const found = STATE.cart.find((c) => c.code === m.code);
    if (found) found.qty += 1;
    else STATE.cart.push({ code: m.code, name: m.name, kcal: m.kcal, protein: m.protein, fat: m.fat, carbs: m.carbs, qty: 1 });
    save(); renderCart(); resetPrice(); flash("已加入购物车：" + m.name);
  }
  function changeQty(code, d) {
    const it = STATE.cart.find((c) => c.code === code);
    if (!it) return;
    it.qty += d; if (it.qty <= 0) STATE.cart = STATE.cart.filter((c) => c.code !== code);
    save(); renderCart(); resetPrice();
  }
  function removeCart(code) { STATE.cart = STATE.cart.filter((c) => c.code !== code); save(); renderCart(); resetPrice(); }
  function renderCart() {
    const ul = $("#cartList");
    ul.innerHTML = "";
    const empty = $("#cartEmpty");
    if (!STATE.cart.length) { empty.classList.remove("hidden"); $("#cartSummary").classList.add("hidden"); return; }
    empty.classList.add("hidden");
    STATE.cart.forEach((c) => {
      const li = document.createElement("li");
      li.className = "cart-item";
      li.innerHTML = `<div class="ci-name">${c.name}<small>${c.kcal} kcal/份</small></div>` +
        `<span class="ci-kcal">${c.kcal * c.qty} kcal</span>` +
        `<div class="qty"><button data-d="-1">−</button><span class="qn">${c.qty}</span><button data-d="1">＋</button></div>` +
        `<button class="del">✕</button>`;
      li.querySelector('[data-d="-1"]').onclick = () => changeQty(c.code, -1);
      li.querySelector('[data-d="1"]').onclick = () => changeQty(c.code, 1);
      li.querySelector(".del").onclick = () => removeCart(c.code);
      ul.appendChild(li);
    });
    const totalKcal = STATE.cart.reduce((a, c) => a + c.kcal * c.qty, 0);
    const cnt = STATE.cart.reduce((a, c) => a + c.qty, 0);
    const s = $("#cartSummary");
    s.classList.remove("hidden");
    s.innerHTML = `<span>共 ${cnt} 件 · 约 ${totalKcal} kcal</span><button class="link" id="clearCart">清空</button>`;
    s.querySelector("#clearCart").onclick = () => { STATE.cart = []; save(); renderCart(); resetPrice(); };
  }
  async function mcp(tool, args) {
    const callOnce = async (code) => {
      const r = await fetch("/api/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tool, args, code }) });
      let j; try { j = await r.json(); } catch (e) { j = { ok: false, error: "响应解析失败" }; }
      return j;
    };
    let j = await callOnce(ACCESS_CODE);
    if (!j.ok && j.needCode) {
      const input = prompt("请输入访问口令（向部署者索取）：");
      if (input) {
        ACCESS_CODE = input.trim();
        try { localStorage.setItem("mbuddy_code", ACCESS_CODE); } catch (e) {}
        j = await callOnce(ACCESS_CODE);
      }
    }
    if (!j.ok) throw new Error(j.error || "调用失败");
    // 麦当劳接口可能 HTTP 200 但业务失败（success:false），必须显式判错
    if (j.json && j.json.success === false) throw new Error(j.json.message || "麦当劳接口返回失败");
    return j.json;
  }

  // ---------- 公网部署模式（只读演示 / 口令保护）----------
  async function loadConfig() {
    try {
      const r = await fetch("/api/config", { cache: "no-store" });
      if (!r.ok) throw new Error("no backend");
      const c = await r.json();
      READONLY = !!c.readonly;
      if (c.needCode) { try { ACCESS_CODE = localStorage.getItem("mbuddy_code") || ""; } catch (e) {} }
      if (READONLY) applyReadonlyUI();
    } catch (e) {
      // 纯静态托管（GitHub Pages）没有后端：明确告知，而不是点下去才报错
      applyStaticUI();
    }
  }
  function applyStaticUI() {
    const btn = $("#orderBtn");
    if (btn) { btn.textContent = "静态演示版 · 不支持下单"; btn.disabled = true; }
    const hint = $("#orderBackendHint");
    if (hint) {
      hint.innerHTML = "📄 <b>当前为 GitHub Pages 静态演示</b>：菜单热量标注、口语记账、四策略套餐推荐 <b>全部可用</b>；真实下单需在本地运行本项目（<code>npm start</code>）后使用。";
      hint.classList.remove("hidden");
    }
  }
  function applyReadonlyUI() {
    const btn = $("#orderBtn");
    btn.textContent = "演示版不支持下单";
    btn.disabled = true;
    const hint = $("#orderBackendHint");
    hint.textContent = "🌐 公网只读演示版：菜单浏览 / 算价 / 套餐推荐可用；真实下单请在本地运行本项目后使用。";
    hint.classList.remove("hidden");
  }
  async function queryStores() {
    const city = $("#storeCity").value.trim() || "广州";
    const kw = $("#storeKw").value.trim() || "";
    flash("查询门店中…");
    try {
      const d = await mcp("query-nearby-stores", { searchType: 2, city, keyword: kw, beType: 1 });
      const list = (d && d.data) || [];
      const box = $("#storeList");
      box.innerHTML = "";
      if (!list.length) { box.innerHTML = '<div class="sitem">未找到门店</div>'; return; }
      list.slice(0, 8).forEach((st) => {
        const el = document.createElement("div");
        el.className = "sitem";
        el.innerHTML = `${st.storeName || "门店"}<small> ${st.storeCode || ""} · ${st.address || ""}</small>`;
        el.onclick = () => {
          STATE.store = { code: st.storeCode, name: st.storeName };
          resetPrice();
          $("#storeName").textContent = st.storeName;
          $("#storeCode").textContent = "门店 " + st.storeCode;
          $("#storeSearch").classList.add("hidden");
          $("#storeRow").classList.remove("hidden");
          flash("已选门店：" + st.storeName);
        };
        box.appendChild(el);
      });
    } catch (e) {
      flash("门店查询失败：" + e.message);
      $("#orderBackendHint").classList.remove("hidden");
    }
  }
  function orderParams() {
    const beType = STATE.beType || 1;
    return {
      storeCode: (STATE.store && STATE.store.code) || "1400359",
      orderType: beType === 2 ? 2 : 1,
      beType,
      items: STATE.cart.map((c) => ({ productCode: c.code, quantity: c.qty })),
    };
  }
  async function calcPrice() {
    if (!STATE.cart.length) { flash("购物车是空的"); return false; }
    $("#calcBtn").textContent = "算价中…"; $("#calcBtn").disabled = true;
    try {
      const p = orderParams();
      const d = await mcp("calculate-price", p);
      const data = d && d.data;
      if (!data || typeof data.price !== "number") {
        throw new Error((d && d.message) || "未返回价格（该门店可能缺货）");
      }
      const price = data.price / 100;
      const discount = data && data.discount ? data.discount / 100 : 0;
      const productList = (data && data.productList) || [];
      const pp = $("#pricePreview");
      let html = `<div class="pp-total">合计 ¥${price.toFixed(2)}</div>`;
      if (discount > 0) html += `<div class="pp-line"><span>优惠</span><span>-¥${discount.toFixed(2)}</span></div>`;
      productList.forEach((it) => html += `<div class="pp-line"><span>${it.productName} ×${it.quantity}</span><span>¥${((it.subtotal || 0) / 100).toFixed(2)}</span></div>`);
      pp.innerHTML = html;
      pp.classList.remove("hidden");
      const tw = (data && data.takeWayList) || [];
      if (STATE.beType === 1 && tw.length) {
        const seg = $("#takeWaySeg");
        seg.innerHTML = "";
        tw.forEach((t, i) => {
          const b = document.createElement("button");
          b.textContent = t.title;
          b.dataset.code = t.code;
          if (i === 0) b.classList.add("active");
          b.onclick = () => seg.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
          seg.appendChild(b);
        });
        $("#takeWayRow").classList.remove("hidden");
      }
      priced = true;
      $("#orderBackendHint").classList.add("hidden");
      return true;
    } catch (e) {
      priced = false;
      // 错误持久显示在页面上（不只靠一闪而过的 toast）
      const pp = $("#pricePreview");
      pp.innerHTML = `<div class="pp-error">⚠️ 算价失败：${e.message}<br><small>请确认本地后端已带 Token 启动，且单品在该门店有售。</small></div>`;
      pp.classList.remove("hidden");
      flash("算价失败：" + e.message);
      $("#orderBackendHint").classList.remove("hidden");
      return false;
    } finally {
      $("#calcBtn").textContent = "① 计算价格（含优惠）"; $("#calcBtn").disabled = false;
    }
  }
  async function openConfirm() {
    if (!STATE.cart.length) { flash("购物车是空的，先去菜单加 🛒"); return; }
    // 未算价则自动先算一次（create-order 需要 calculate-price 返回的 takeWayCode）
    if (!priced) {
      flash("正在自动算价…");
      const ok = await calcPrice();
      if (!ok) { flash("算价未成功，请先看页面上的错误提示"); return; }
    }
    const beType = STATE.beType || 1;
    const twEl = $("#takeWaySeg .active");
    const tw = (beType === 1 && twEl) ? twEl.dataset.code : undefined;
    const items = STATE.cart.map((c) => `${c.name} ×${c.qty}`).join("、");
    const totalKcal = STATE.cart.reduce((a, c) => a + c.kcal * c.qty, 0);
    $("#confirmBody").innerHTML =
      `门店：<b>${(STATE.store && STATE.store.name) || "麦当劳广州天源路餐厅"}</b><br>` +
      `方式：<b>${beType === 1 ? "到店自取" : "麦乐送"}</b>${tw ? `（${twEl.textContent}）` : ""}<br>` +
      `单品：<b>${items}</b><br>` +
      `总热量：<b>${totalKcal} kcal</b><br>` +
      `<span style="color:#c9760a">将创建真实订单，支付链接是 H5 网页：可在微信里打开长按二维码用微信支付，或用麦当劳 App 扫一扫完成支付（不强制装 App）。</span>`;
    $("#confirmModal").classList.remove("hidden");
  }
  async function doCreateOrder() {
    $("#confirmModal").classList.add("hidden");
    if (!STATE.cart.length) { flash("购物车是空的"); return; }
    const beType = STATE.beType || 1;
    if (beType === 2) { flash("外送需配送地址，演示请用「到店自取」"); return; }
    const twEl = $("#takeWaySeg .active");
    const tw = (beType === 1 && twEl) ? twEl.dataset.code : undefined;
    const params = orderParams();
    if (tw) params.takeWayCode = tw;
    const itemSummary = STATE.cart.map((c) => `${c.name}×${c.qty}`).join("、");
    $("#orderBtn").textContent = "下单中…"; $("#orderBtn").disabled = true;
    try {
      const d = await mcp("create-order", params);
      const data = d && d.data;
      if (!data || !data.orderId) throw new Error((d && d.message) || "未返回订单号，未创建成功");
      const no = data.orderId || data.orderNo || data.orderCode;
      const pay = data && (data.payH5Url || data.payUrl || data.payLink);
      const or = $("#orderResult");
      let html = `<div class="or-no">订单已创建 ✅</div>`;
      html += `<div>订单号：<b>${no}</b></div>`;
      html += `<div>已下单：<b>${itemSummary}</b></div>`;
      if (pay) html += `<div>支付：<a href="${pay}" target="_blank" rel="noopener">${pay}</a></div>`;
      html += `<div class="or-tip">支付链接是 H5 网页：在微信里打开可长按二维码用微信支付，或用麦当劳 App 扫一扫完成支付；支付后可在麦当劳 App / 小程序的「我的订单」查看状态。</div>`;
      or.innerHTML = html;
      or.classList.remove("hidden");
      flash("订单已创建，去支付吧");
      // 清空购物车，避免重复下单
      STATE.cart = []; save(); renderCart(); resetPrice();
    } catch (e) {
      const or2 = $("#orderResult");
      or2.innerHTML = `<div class="pp-error">⚠️ 下单失败：${e.message}</div>`;
      or2.classList.remove("hidden");
      flash("下单失败：" + e.message);
      $("#orderBackendHint").classList.remove("hidden");
    } finally {
      $("#orderBtn").textContent = "② 确认下单"; $("#orderBtn").disabled = false;
    }
  }

  // ---------- 启动 ----------
  renderGoal(); renderStatus(); renderPresets(); renderIntake();
  renderCats(); renderMenu(); renderCart(); bind(); loadConfig();
})();
