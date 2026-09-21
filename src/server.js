// 一句账 ✦ AI 记账 —— 本地原型
// 零依赖：Node 22 原生 http + fetch，JSON 文件存储
//
// 架构原则：LLM 只负责"人话 ⇄ 结构化"的翻译（解析输入 / 组织语言），
// 所有计算（预算余量、冲击、节奏预测、聚合）由本地确定性代码完成——
// 算术不出错，账目明细不出户。

const http = require("http");
const https = require("https"); // 兼容老版本 Node（<18 没有全局 fetch），调用智谱 API 用
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT) || 3456;
const DATA_FILE = path.join(__dirname, "data.json");

// API Key 读取顺序：环境变量 ZHIPU_API_KEY > 本地 secret.json（已 gitignore，不会提交）
function loadApiKey() {
  if (process.env.ZHIPU_API_KEY) return process.env.ZHIPU_API_KEY;
  try {
    const s = JSON.parse(fs.readFileSync(path.join(__dirname, "secret.json"), "utf8"));
    if (s.ZHIPU_API_KEY) return s.ZHIPU_API_KEY;
  } catch (_) { /* secret.json 不存在时走默认值 */ }
  return ""; // 没有配置 key，调用 AI 时会报错并提示
}
const ZHIPU_KEY = loadApiKey();
const ZHIPU_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
// 模型选择（你当前的智谱资源包都是 glm-4.5-air 专用，所以用它消耗赠送额度）
// 想换其他模型时改这一行即可，例如：\"glm-5.3-flash\"（按量付费）或\"glm-4.7-flash\"（免费但繁忙）
const MODEL = "glm-4.6v"; // 使用你的资源包对应的模型

const CATEGORIES = ["餐饮", "交通", "购物", "娱乐", "居住", "医疗", "学习", "其他"];
const DEFAULT_BUDGETS = { 餐饮: 2000, 交通: 500, 购物: 1500, 娱乐: 600, 居住: 3000, 医疗: 400, 学习: 300, 其他: 500 };

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ budgets: DEFAULT_BUDGETS, txns: [] }, null, 2));
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}
function saveData(d) { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); }

// ---------- 时间工具：一律本地时区（用 UTC 会让早 8 点前的"今天"变成昨天） ----------
const pad = n => String(n).padStart(2, "0");
const dateStr = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayStr = () => dateStr(new Date());
const monthKey = s => s.slice(0, 7);
const currentMonth = () => todayStr().slice(0, 7);
const daysInMonthOf = mk => { const [y, m] = mk.split("-").map(Number); return new Date(y, m, 0).getDate(); };
const round2 = n => Math.round(n * 100) / 100;
// LLM 返回的日期可能没补零（"2026-8-28"），统一归一化
function normalizeDate(s) {
  if (typeof s !== "string") return todayStr();
  const m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  return m ? `${m[1]}-${pad(Number(m[2]))}-${pad(Number(m[3]))}` : todayStr();
}

// ---------- 本地算账：月度统计 + 支出节奏预测（不经过 AI） ----------
function monthStats(d) {
  const mk = currentMonth();
  const monthTxns = d.txns.filter(t => monthKey(t.date) === mk);

  const catSpent = {};
  let totalSpent = 0;
  for (const t of monthTxns) { catSpent[t.category] = (catSpent[t.category] || 0) + t.amount; totalSpent += t.amount; }

  const daysInMonth = daysInMonthOf(mk);
  const dayOfMonth = Number(todayStr().slice(8)); // 今天是几号
  const daysPassed = dayOfMonth;
  const daysLeft = daysInMonth - dayOfMonth + 1; // 含今天

  let totalBudget = 0;
  for (const c of CATEGORIES) totalBudget += Number(d.budgets[c] || 0);

  // 支出节奏：按当月日均外推月底总支出，月初就能预警"照这个速度会超"
  const dailyAvg = daysPassed > 0 ? totalSpent / daysPassed : 0;
  const projected = dailyAvg * daysInMonth;

  const catStats = CATEGORIES.map(c => {
    const budget = Number(d.budgets[c] || 0);
    const spent = catSpent[c] || 0;
    const proj = daysPassed > 0 ? (spent / daysPassed) * daysInMonth : 0;
    return { category: c, budget, spent: round2(spent), left: round2(budget - spent), projected: round2(proj), projectedDelta: round2(proj - budget) };
  });

  // 每日支出序列（1 号到今天），给前端画柱状图
  const dailyByDate = {};
  for (const t of monthTxns) dailyByDate[t.date] = (dailyByDate[t.date] || 0) + t.amount;
  const dailySeries = [];
  for (let i = 1; i <= dayOfMonth; i++) dailySeries.push({ date: pad(i), amount: round2(dailyByDate[`${mk}-${pad(i)}`] || 0) });

  return {
    month: mk, daysInMonth, daysPassed, daysLeft,
    totalBudget, totalSpent: round2(totalSpent), totalLeft: round2(totalBudget - totalSpent),
    dailyAvg: round2(dailyAvg), projected: round2(projected), projectedDelta: round2(projected - totalBudget),
    todayAllowance: round2(daysLeft > 0 ? Math.max(0, (totalBudget - totalSpent) / daysLeft) : 0), // 今日"安全额度"
    dailyPace: round2(totalBudget / daysInMonth), // 日均预算线
    catStats, dailySeries, catSpent,
  };
}

// ---------- 智谱 GLM 调用 ----------
// 兼容性：全局 fetch 要 Node 18+ 才有；检测不到时自动退回原生 https.request，保持零依赖
function postJSON(url, headers, body) {
  console.log('🔍 [DEBUG] 调用智谱API:', url);
  console.log('🔍 [DEBUG] 请求头:', JSON.stringify(headers));
  console.log('🔍 [DEBUG] 请求体长度:', body.length);
  
  if (typeof fetch === "function") {
    const opts = { method: "POST", headers, body };
    let timer = null;
    if (typeof AbortController === "function") {
      const ac = new AbortController();
      timer = setTimeout(() => {
        console.log('⏰ [DEBUG] 请求超时，取消请求');
        ac.abort();
      }, 60000); // 增加到60秒超时
      opts.signal = ac.signal;
    }
    
    return fetch(url, opts)
      .then(r => {
        console.log('🔍 [DEBUG] HTTP响应状态:', r.status, r.statusText);
        if (!r.ok) {
          throw new Error(`HTTP ${r.status}: ${r.statusText}`);
        }
        return r.json();
      })
      .catch(e => {
        const msg = String((e && e.message) || e);
        console.log('❌ [DEBUG] API调用失败:', msg);
        throw new Error(/abort/i.test(msg) ? "调用智谱 API 超时（30 秒无响应）" : "调用智谱 API 失败：" + msg);
      })
      .finally(() => { if (timer) clearTimeout(timer); });
  }
  // 老版本 Node：原生 https.request
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: "POST",
      headers: Object.assign({}, headers, { "Content-Length": Buffer.byteLength(body) }),
    }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (_) { reject(new Error("API 返回了无法解析的内容：" + String(data).slice(0, 120))); }
      });
    });
    req.on("error", reject);
    req.setTimeout(60000, () => req.destroy(new Error("调用智谱 API 超时（60 秒无响应）")));
    req.write(body);
    req.end();
  });
}

async function callGLM(system, user, { temperature = 0.1, max_tokens = 1024 } = {}, retryCount = 0) {
  if (!ZHIPU_KEY) throw new Error('缺少智谱 API Key：请在项目目录创建 secret.json，内容为 {"ZHIPU_API_KEY": "你的key"}');
  
  console.log('🔑 [DEBUG] API Key有效性检查:', ZHIPU_KEY ? '已配置' : '未配置');
  console.log('🔑 [DEBUG] 当前模型:', MODEL);
  console.log('🔄 [DEBUG] 重试次数:', retryCount);
  
  const body = JSON.stringify({
    model: MODEL,
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    temperature, max_tokens,
  });
  
  try {
    const j = await postJSON(ZHIPU_URL, { "Authorization": "Bearer " + ZHIPU_KEY, "Content-Type": "application/json" }, body);
    if (j.error) {
      console.log('❌ [DEBUG] 智谱API错误:', JSON.stringify(j.error));
      throw new Error(j.error.message || "API error");
    }
    const raw = j.choices[0].message.content.trim();
    return raw.replace(/^```(json)?\s*/i, "").replace(/```\s*$/, ""); // 容错：剥掉可能的代码块包裹
  } catch (error) {
    console.log('❌ [DEBUG] API调用失败:', error.message);
    
    // 如果是超时错误且还有重试次数，则重试
    if (retryCount < 2 && /timeout|abort/i.test(error.message)) {
      console.log('⏳ [DEBUG] 准备重试，等待2秒...');
      await new Promise(resolve => setTimeout(resolve, 2000));
      return callGLM(system, user, { temperature, max_tokens }, retryCount + 1);
    }
    
    throw error;
  }
}

// ---------- LLM 职责 1：人话 -> 结构化（意图路由 + 记账解析） ----------
async function parseLedger(text) {
  const sys = `你是记账意图解析器，把用户输入解析成 JSON。只输出 JSON，不要任何解释、不要 markdown 代码块。今天是 ${todayStr()}。

判断输入属于哪种意图，输出对应格式：

一、记账（输入里出现了明确的消费金额）：输出支出数组，多笔支出拆成多条：
[{"amount": 数字, "category": "类目", "note": "备注(≤10字)", "date": "YYYY-MM-DD"}]
- 类目只能从这些里选：${CATEGORIES.join("、")}
- "昨天""前天"要换算成真实日期；没提日期默认今天
- 金额是人民币元；备注写消费内容本身（如"午饭"），不要包含金额
- 没有明确金额就不算记账，走意图三

二、调整预算（用户想修改某类目的预算金额）：
{"setBudget": {"category": "类目", "amount": 数字}}

三、其他一切情况（提问、闲聊、看不懂）：
{"query": "用户原话"}`;
  const raw = await callGLM(sys, text);
  const start = raw.search(/[[{]/); // 容错：定位 JSON 起点
  return JSON.parse(raw.slice(start === -1 ? 0 : start));
}

// ---------- LLM 职责 2：数据 -> 人话（数字先在本地算好，AI 只负责组织语言） ----------
async function answerQuestion(text, d) {
  const s = monthStats(d);
  const recent = d.txns
    .filter(t => monthKey(t.date) === s.month)
    .sort((a, b) => b.id - a.id)
    .slice(0, 12)
    .map(t => `${t.date.slice(5)} ${t.category} ¥${t.amount}${t.note ? " " + t.note : ""}`);
  const facts = [
    `今天：${todayStr()}（本月还剩 ${s.daysLeft} 天）`,
    `总预算 ¥${s.totalBudget}，本月已花 ¥${s.totalSpent}，剩余 ¥${s.totalLeft}`,
    `日均支出 ¥${s.dailyAvg}，按此节奏月底预计花 ¥${s.projected}（${s.projectedDelta >= 0 ? "超支" : "结余"} ¥${Math.abs(s.projectedDelta)}）`,
    `今日还可花 ¥${s.todayAllowance}`,
    `各类目（预算/已花/按节奏月底预计）：` + s.catStats.map(c => `${c.category} ¥${c.budget}/¥${c.spent}/¥${c.projected}`).join("，"),
    `最近流水：` + (recent.length ? recent.join("；") : "暂无"),
  ].join("\n");
  const sys = `你是记账助手"一句账"，基于用户提供的本月账目数据回答问题。规则：
1. 只依据数据回答，禁止编造或猜测任何数字
2. 需要计算时先想清楚再回答，简洁（80 字以内），金额写成 ¥xx
3. 数据里没有的信息（比如其他月份）就直说暂时看不到
4. 语气自然像朋友聊天，称呼"你"`;
  return (await callGLM(sys, `${facts}\n\n用户问题：${text}`, { temperature: 0.3, max_tokens: 300 })).trim();
}

// ---------- 本地算账：记账后的即时预算冲击反馈 ----------
function buildFeedback(d, newTxns) {
  const spent = {}; // "YYYY-MM|类目" -> 已花
  for (const t of d.txns) {
    const k = monthKey(t.date) + "|" + t.category;
    spent[k] = (spent[k] || 0) + t.amount;
  }
  return newTxns.map(t => {
    const k = monthKey(t.date) + "|" + t.category;
    const budget = Number(d.budgets[t.category] || 0);
    spent[k] = (spent[k] || 0) + t.amount; // 顺序累计：同一次输入多笔同类也能算对
    const after = budget - spent[k];
    const ratio = budget > 0 ? after / budget : 0;
    let level = "green", tip = "状态良好";
    if (after < 0) { level = "red"; tip = "已超支"; }
    else if (ratio < 0.2) { level = "amber"; tip = "快见底了"; }
    const times = t.amount > 0 ? Math.floor(Math.max(after, 0) / t.amount) : 0;
    return {
      ...t,
      budgetLeft: round2(after), level, tip, stillCanBuy: times,
      impactPct: budget > 0 ? Math.round((t.amount / budget) * 100) : 0, // 这笔占该类目预算的百分比
    };
  });
}

// ---------- HTTP ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(obj)); };
  const readBody = async () => { let b = ""; for await (const c of req) b += c; return JSON.parse(b); };

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(fs.readFileSync(path.join(__dirname, "public", "index.html")));
  }

  // 本月全量状态：预算、统计、预测、流水（全部本地计算）
  if (url.pathname === "/api/test" && req.method === "GET") {
    return send(200, { 
      status: "ok", 
      message: "服务正常运行",
      model: MODEL,
      hasApiKey: !!ZHIPU_KEY
    });
  }

  if (url.pathname === "/api/state" && req.method === "GET") {
    const d = loadData();
    const s = monthStats(d);
    const txns = d.txns.filter(t => monthKey(t.date) === s.month).sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
    return send(200, { ...s, budgets: d.budgets, categories: CATEGORIES, txns });
  }

  // 统一入口：一次 LLM 调用完成意图路由（记账 / 调预算 / 提问）
  if (url.pathname === "/api/record" && req.method === "POST") {
    try {
      const { text } = await readBody();
      if (!text || !text.trim()) return send(400, { error: "empty input" });
      const parsed = await parseLedger(text.trim());
      const d = loadData();

      if (Array.isArray(parsed)) {
        // 意图一：记账（LLM 输出过白名单校验，不可全信）
        const newTxns = parsed.map(t => ({
          id: Date.now() + Math.floor(Math.random() * 1000),
          amount: Number(t.amount), category: t.category, note: t.note || "",
          date: normalizeDate(t.date),
        })).filter(t => t.amount > 0 && CATEGORIES.includes(t.category));
        if (!newTxns.length) return send(200, { type: "none" });
        const feedback = buildFeedback(d, newTxns);
        d.txns.push(...newTxns);
        saveData(d);
        return send(200, { type: "ok", added: newTxns, feedback });
      }

      if (parsed && parsed.setBudget && CATEGORIES.includes(parsed.setBudget.category) && Number(parsed.setBudget.amount) > 0) {
        // 意图二：调整预算
        d.budgets[parsed.setBudget.category] = round2(Number(parsed.setBudget.amount));
        saveData(d);
        return send(200, { type: "budget", category: parsed.setBudget.category, amount: d.budgets[parsed.setBudget.category] });
      }

      // 意图三：提问 -> 本地聚合数据 + LLM 只组织语言
      const answer = await answerQuestion(text.trim(), d);
      return send(200, { type: "answer", answer });
    } catch (e) {
      console.log('❌ [ERROR] 处理请求时出错:', e.message);
      
      // 特殊处理智谱API的访问量过大错误
      if (e.message.includes('访问量过大') || e.message.includes('当前访问量过大') || e.message.includes('该模型当前访问量过大')) {
        return send(503, { 
          error: '服务暂时不可用', 
          message: '该模型当前访问量过大，请您稍后再试',
          suggestion: '建议等待几分钟后重试，或切换到其他模型'
        });
      }
      
      // 特殊处理超时错误
      if (e.message.includes('超时') || e.message.includes('timeout')) {
        return send(504, { 
          error: '请求超时', 
          message: '智谱API响应超时，已自动重试，请稍后重试',
          suggestion: '网络可能较慢，建议检查网络连接后重试'
        });
      }
      
      return send(500, { error: e.message });
    }
  }

  if (url.pathname === "/api/budget" && req.method === "POST") {
    try {
      const { category, amount } = await readBody();
      if (!CATEGORIES.includes(category)) return send(400, { error: "bad category" });
      const d = loadData();
      d.budgets[category] = round2(Number(amount));
      saveData(d);
      return send(200, { ok: true });
    } catch (e) {
      return send(500, { error: e.message });
    }
  }

  if (url.pathname === "/api/delete" && req.method === "POST") {
    try {
      const { id } = await readBody();
      const d = loadData();
      d.txns = d.txns.filter(t => t.id !== id);
      saveData(d);
      return send(200, { ok: true });
    } catch (e) {
      return send(500, { error: e.message });
    }
  }

  res.writeHead(404); res.end("not found");
});

// 端口被占时给出人话提示，而不是让用户面对一堆英文堆栈
server.on("error", err => {
  if (err.code === "EADDRINUSE") {
    console.error(`[启动失败] 端口 ${PORT} 被旧进程占用。`);
    console.error("解决：关掉旧的黑色窗口，重新双击「启动记账.bat」即可（新版启动脚本会自动清理旧进程）。");
  } else {
    console.error("[启动失败] " + err.message);
  }
  process.exit(1);
});

server.listen(PORT, () => console.log(`一句账 · AI 记账已启动: http://localhost:${PORT}  （Node ${process.versions.node}）`));
