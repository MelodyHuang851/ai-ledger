// AI 记账平台 - 本地原型
// 零依赖：Node 22 原生 http + fetch，JSON 文件存储
// AI 只做"人话 -> 结构化数据"的翻译，算账全部由本地代码完成
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 3456;
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
const MODEL = "glm-5.3-flash";

const CATEGORIES = ["餐饮", "交通", "购物", "娱乐", "居住", "医疗", "学习", "其他"];
const DEFAULT_BUDGETS = { 餐饮: 2000, 交通: 500, 购物: 1500, 娱乐: 600, 居住: 3000, 医疗: 400, 学习: 300, 其他: 500 };

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ budgets: DEFAULT_BUDGETS, txns: [] }, null, 2));
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}
function saveData(d) { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); }

// ---- 智谱 GLM：自然语言 -> 结构化账目 ----
async function parseLedger(text) {
  const sys = `你是记账解析器。把用户输入解析成 JSON 数组，每个元素代表一笔支出：
{"amount": 数字, "category": 类目, "note": 简短备注(<=10字), "date": "YYYY-MM-DD"}
类目只能从这些里选：${CATEGORIES.join("、")}
规则：多笔支出拆成多条；"昨天/前天"换算成对应日期(今天是${new Date().toISOString().slice(0, 10)})；没提日期默认今天；金额是人民币元。
如果输入不是记账（比如是提问或闲聊），返回 {"query": "原始输入"}。
只输出 JSON，不要任何解释、不要 markdown 代码块。`;

  if (!ZHIPU_KEY) throw new Error("缺少智谱 API Key：请在项目目录创建 secret.json，内容为 {\"ZHIPU_API_KEY\": \"你的key\"}");
  const res = await fetch(ZHIPU_URL, {
    method: "POST",
    headers: { "Authorization": "Bearer " + ZHIPU_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "system", content: sys }, { role: "user", content: text }],
      temperature: 0.1,
      max_tokens: 1024,
    }),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message || "API error");
  let raw = j.choices[0].message.content.trim();
  raw = raw.replace(/^```(json)?\s*/i, "").replace(/```\s*$/, ""); // 容错：剥掉可能的代码块包裹
  const start = raw.search(/[[{]/);
  return JSON.parse(raw.slice(start === -1 ? 0 : start));
}

// ---- 本地算账：预算反馈（不经过 AI） ----
function monthKey(d) { return d.slice(0, 7); }
function buildFeedback(txns, budgets, newTxns) {
  const mk = monthKey(newTxns[0].date);
  const spent = {};
  for (const t of txns) if (monthKey(t.date) === mk) spent[t.category] = (spent[t.category] || 0) + t.amount;
  return newTxns.map(t => {
    const budget = budgets[t.category] ?? 0;
    const before = budget - (spent[t.category] || 0);
    const after = before - t.amount;
    const ratio = budget > 0 ? after / budget : 0;
    let level, tip;
    if (after < 0) { level = "red"; tip = "已超支"; }
    else if (ratio < 0.2) { level = "amber"; tip = "快见底了"; }
    else { level = "green"; tip = "状态良好"; }
    // 体感换算：按剩余预算还能花几笔同额消费
    const times = t.amount > 0 ? Math.floor(Math.max(after, 0) / t.amount) : 0;
    return { ...t, budgetLeft: Math.round(after * 100) / 100, level, tip, stillCanBuy: times };
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(obj)); };

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(fs.readFileSync(path.join(__dirname, "public", "index.html")));
  }

  if (url.pathname === "/api/state" && req.method === "GET") {
    const d = loadData();
    const mk = new Date().toISOString().slice(0, 7);
    const monthTxns = d.txns.filter(t => monthKey(t.date) === mk).sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
    const catSpent = {};
    for (const t of monthTxns) catSpent[t.category] = (catSpent[t.category] || 0) + t.amount;
    return send(200, { budgets: d.budgets, categories: CATEGORIES, txns: monthTxns, catSpent, month: mk });
  }

  if (url.pathname === "/api/record" && req.method === "POST") {
    let body = "";
    for await (const c of req) body += c;
    const { text } = JSON.parse(body);
    if (!text || !text.trim()) return send(400, { error: "empty input" });
    try {
      const parsed = await parseLedger(text.trim());
      if (!Array.isArray(parsed)) return send(200, { type: "chat", echo: parsed });
      const d = loadData();
      const newTxns = parsed.map(t => ({
        id: Date.now() + Math.floor(Math.random() * 1000),
        amount: Number(t.amount), category: t.category, note: t.note || "", date: t.date || new Date().toISOString().slice(0, 10),
      })).filter(t => t.amount > 0 && CATEGORIES.includes(t.category));
      if (!newTxns.length) return send(200, { type: "none" });
      const feedback = buildFeedback(d.txns, d.budgets, newTxns);
      d.txns.push(...newTxns);
      saveData(d);
      return send(200, { type: "ok", added: newTxns, feedback });
    } catch (e) {
      return send(500, { error: e.message });
    }
  }

  if (url.pathname === "/api/budget" && req.method === "POST") {
    let body = "";
    for await (const c of req) body += c;
    const { category, amount } = JSON.parse(body);
    const d = loadData();
    d.budgets[category] = Number(amount);
    saveData(d);
    return send(200, { ok: true });
  }

  if (url.pathname === "/api/delete" && req.method === "POST") {
    let body = "";
    for await (const c of req) body += c;
    const { id } = JSON.parse(body);
    const d = loadData();
    d.txns = d.txns.filter(t => t.id !== id);
    saveData(d);
    return send(200, { ok: true });
  }

  res.writeHead(404); res.end("not found");
});

server.listen(PORT, () => console.log(`AI 记账平台已启动: http://localhost:${PORT}`));
