// ============================================================
// KOKO ATELIER — AI Assistant Backend
// Handles: Orders, Products, Sizing, Shipping, Returns, FAQs
// Stack: Node.js + Express + Anthropic + Supabase
// ============================================================

import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import multer from "multer";
import dotenv from "dotenv";
import crypto from "crypto";

dotenv.config();

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, x-api-key");
  next();
});

const upload = multer({ storage: multer.memoryStorage() });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ============================================================
// KOKO ATELIER — Brand Configuration
// ============================================================
const KOKO_CONFIG = {
  name: "Koko Atelier",
  language: "en-ur", // bilingual support hint
  systemPrompt: `You are Zara, the AI assistant for Koko Atelier — a premium ethnic fashion brand
based in Lahore, Pakistan. You assist customers shopping via the Koko Atelier Shopify store.

BRAND VOICE:
- Warm, elegant, and approachable
- Reflect the premium nature of the brand
- Use polite, refined language
- Occasionally use Urdu terms of endearment where natural (e.g. "jee", "bilkul")

YOU HELP WITH:
1. Order status and tracking
2. Product information (fabrics, collections, availability)
3. Sizing and measurements guidance
4. Shipping rates and delivery timelines (Pakistan & international)
5. Returns and exchange policy
6. Care instructions for garments
7. Collection information (Afsaneh '26, Marsa'a Festive '26, etc.)
8. Custom orders and studio visits

IMPORTANT POLICIES TO KNOW:
- Orders are processed within 2-3 business days
- Standard delivery in Pakistan: 3-5 business days
- International shipping: 7-14 business days
- Returns accepted within 7 days of delivery (unworn, tags intact)
- Custom sizing available — customers should WhatsApp the studio directly
- Payment methods: Bank transfer, EasyPaisa, JazzCash, card via Shopify

ESCALATION:
- For specific order issues, payment problems, or complaints → ask for their order number
  and let them know the team will follow up within 24 hours
- For custom orders → direct to WhatsApp: +92-XXX-XXXXXXX (replace with real number)
- Never make up product availability, pricing, or order status

Always be helpful, never dismissive. If unsure, say so gracefully and offer to connect
the customer with the Koko Atelier team.`,

  welcomeMessage: "Assalam o Alaikum! 🌸 Welcome to Koko Atelier. I'm Zara, your personal style assistant. How can I help you today?",
  model: "claude-haiku-4-5-20251001", // Haiku = faster + cheaper for customer service
  maxTokens: 800,
};

// ============================================================
// KOKO KNOWLEDGE BASE — Hardcoded FAQs
// These load without needing a DB upload
// ============================================================
const KOKO_KNOWLEDGE = `
COLLECTIONS:
- Afsaneh '26: Spring/Summer collection inspired by folk tales. Features lawn, cambric fabrics.
  Price range: PKR 4,500 - 18,000. Available in XS-XXL.
- Marsa'a Festive '26: Festive/Eid collection. Rich fabrics — karandi, chiffon, organza.
  Price range: PKR 8,000 - 35,000. Limited quantities.
- Ready to Wear (RTW): Available year-round. Pret pieces for daily and semi-formal wear.

SIZING GUIDE:
- XS: Chest 32", Waist 26", Hips 34"
- S:  Chest 34", Waist 28", Hips 36"
- M:  Chest 36", Waist 30", Hips 38"
- L:  Chest 38", Waist 32", Hips 40"
- XL: Chest 40", Waist 34", Hips 42"
- XXL: Chest 42", Waist 36", Hips 44"
- Custom sizing available — add note at checkout or WhatsApp studio

FABRIC CARE:
- Lawn/Cambric: Machine wash cold, mild detergent, do not bleach
- Karandi/Khaddar: Dry clean recommended or hand wash cold
- Chiffon/Organza: Dry clean only, store folded not hung
- Embroidered pieces: Always dry clean, store in dust bags

SHIPPING:
- Lahore: 1-2 business days (PKR 150)
- Other Pakistan cities: 3-5 business days (PKR 250)
- International (UAE, UK, USA, Canada): 7-14 business days ($15-25 USD)
- Free shipping on orders above PKR 10,000 (Pakistan only)

RETURNS & EXCHANGES:
- 7-day return window from delivery date
- Items must be unworn, unwashed, tags attached
- Sale items are final — no returns
- To initiate: email support or WhatsApp with order number + reason
- Exchanges subject to availability

PAYMENT:
- Credit/Debit card (Visa, Mastercard via Shopify)
- Bank transfer (HBL, MCB — details at checkout)
- EasyPaisa / JazzCash
- Cash on Delivery available for select cities (Lahore, Karachi, Islamabad)
`;

// ============================================================
// SESSION STORE — In-memory (replace with Supabase for prod)
// ============================================================
const sessions = new Map();

function getHistory(sessionId) {
  if (!sessions.has(sessionId)) sessions.set(sessionId, []);
  return sessions.get(sessionId);
}

function updateHistory(sessionId, role, content) {
  const h = getHistory(sessionId);
  h.push({ role, content });
  if (h.length > 16) h.splice(0, 2); // keep last 8 exchanges
}

// ============================================================
// KNOWLEDGE RETRIEVAL — Simple keyword match
// In production: replace with pgvector embeddings
// ============================================================
async function getContext(query) {
  const q = query.toLowerCase();
  const sections = KOKO_KNOWLEDGE.split("\n\n");
  const keywords = {
    "COLLECTIONS": ["collection", "afsaneh", "marsa", "festive", "lawn", "range", "price", "fabric"],
    "SIZING GUIDE": ["size", "sizing", "chest", "waist", "hip", "fit", "measurement", "custom"],
    "FABRIC CARE": ["wash", "clean", "care", "fabric", "dry clean", "store", "chiffon", "karandi"],
    "SHIPPING": ["ship", "deliver", "delivery", "days", "international", "lahore", "karachi", "track"],
    "RETURNS": ["return", "exchange", "refund", "policy", "unworn", "tags", "cancel"],
    "PAYMENT": ["pay", "payment", "card", "easypaisa", "jazz", "bank", "cod", "cash"],
  };

  const relevant = [];
  for (const [section, keys] of Object.entries(keywords)) {
    if (keys.some(k => q.includes(k))) {
      const block = sections.find(s => s.startsWith(section));
      if (block) relevant.push(block);
    }
  }

  // Also check uploaded docs in Supabase
  try {
    const { data } = await supabase
      .from("koko_knowledge")
      .select("content")
      .textSearch("content", query.split(" ").slice(0, 3).join(" "), { type: "plain" })
      .limit(2);
    if (data?.length) relevant.push(...data.map(d => d.content));
  } catch { /* no db yet — that's fine */ }

  return relevant.length
    ? `\n\nRelevant Koko Atelier information:\n${relevant.join("\n\n")}`
    : "";
}

// ============================================================
// ROUTE: Chat
// POST /chat
// Body: { message, sessionId? }
// Header: x-api-key
// ============================================================
app.post("/chat", async (req, res) => {
  const apiKey = req.headers["x-api-key"];
  if (apiKey !== process.env.KOKO_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { message, sessionId = crypto.randomUUID() } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: "Message required" });

  try {
    const context = await getContext(message);
    const systemWithContext = KOKO_CONFIG.systemPrompt + context;

    updateHistory(sessionId, "user", message);
    const history = getHistory(sessionId);

    const response = await anthropic.messages.create({
      model: KOKO_CONFIG.model,
      max_tokens: KOKO_CONFIG.maxTokens,
      system: systemWithContext,
      messages: history,
    });

    const reply = response.content[0].text;
    updateHistory(sessionId, "assistant", reply);

    // Log to Supabase (non-blocking)
    supabase.from("koko_chat_logs").insert({
      session_id: sessionId,
      user_message: message,
      assistant_reply: reply,
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    }).then(() => {}).catch(() => {});

    res.json({ reply, sessionId });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "I'm having a moment — please try again shortly.",
    });
  }
});

// ============================================================
// ROUTE: Upload product/policy document
// POST /upload
// Form-data: file (.txt or .md)
// ============================================================
app.post("/upload", async (req, res) => {
  const apiKey = req.headers["x-api-key"];
  if (apiKey !== process.env.KOKO_ADMIN_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Handle multer inline
  upload.single("file")(req, res, async (err) => {
    if (err || !req.file) return res.status(400).json({ error: "No file uploaded" });

    const text = req.file.buffer.toString("utf-8");
    const chunks = [];
    for (let i = 0; i < text.length; i += 600) {
      chunks.push(text.slice(i, i + 600).trim());
    }

    const rows = chunks
      .filter(c => c.length > 20)
      .map((content, idx) => ({
        filename: req.file.originalname,
        chunk_index: idx,
        content,
      }));

    const { error } = await supabase.from("koko_knowledge").insert(rows);
    if (error) return res.status(500).json({ error: "DB insert failed", detail: error.message });

    res.json({ message: `✅ Uploaded ${rows.length} chunks from ${req.file.originalname}` });
  });
});

// ============================================================
// ROUTE: Admin — view recent chat logs
// GET /logs?limit=20
// ============================================================
app.get("/logs", async (req, res) => {
  const apiKey = req.headers["x-api-key"];
  if (apiKey !== process.env.KOKO_ADMIN_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const limit = parseInt(req.query.limit) || 20;
  const { data, error } = await supabase
    .from("koko_chat_logs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) return res.status(500).json({ error: "Could not fetch logs" });
  res.json({ logs: data });
});

// ============================================================
// ROUTE: Embeddable Widget
// GET /widget.js — add to Koko Shopify store
// ============================================================
app.get("/widget.js", (req, res) => {
  res.setHeader("Content-Type", "application/javascript");
  const serverUrl = process.env.SERVER_URL || "http://localhost:3000";
  const apiKey = process.env.KOKO_API_KEY || "";

  res.send(`
(function() {
  const API = "${serverUrl}/chat";
  const KEY = "${apiKey}";
  let sessionId = null;

  const styles = \`
    #koko-widget * { box-sizing: border-box; font-family: 'Georgia', serif; }
    #koko-btn { position:fixed; bottom:24px; right:24px; z-index:9999;
      background:#2c1810; color:#f5e6d3; border:none; border-radius:50px;
      padding:14px 22px; cursor:pointer; font-size:14px; letter-spacing:0.5px;
      box-shadow:0 4px 20px rgba(44,24,16,0.4); transition:transform 0.2s; }
    #koko-btn:hover { transform:scale(1.05); }
    #koko-box { position:fixed; bottom:80px; right:24px; z-index:9999;
      width:340px; height:480px; background:#fffaf6; border-radius:16px;
      box-shadow:0 8px 40px rgba(0,0,0,0.18); display:flex; flex-direction:column;
      overflow:hidden; display:none; }
    #koko-header { background:#2c1810; color:#f5e6d3; padding:16px 18px;
      font-size:15px; letter-spacing:1px; display:flex; justify-content:space-between; align-items:center; }
    #koko-close { background:none; border:none; color:#f5e6d3; font-size:18px; cursor:pointer; }
    #koko-msgs { flex:1; overflow-y:auto; padding:14px; display:flex; flex-direction:column; gap:10px; }
    .koko-msg { max-width:85%; padding:10px 14px; border-radius:14px; font-size:13px; line-height:1.5; }
    .koko-user { align-self:flex-end; background:#2c1810; color:#f5e6d3; border-radius:14px 14px 2px 14px; }
    .koko-bot { align-self:flex-start; background:#f0e6d8; color:#2c1810; border-radius:14px 14px 14px 2px; }
    .koko-typing { align-self:flex-start; color:#a08060; font-size:12px; font-style:italic; padding:4px 8px; }
    #koko-footer { padding:10px 12px; border-top:1px solid #e8d8c8; display:flex; gap:8px; background:#fffaf6; }
    #koko-input { flex:1; padding:9px 12px; border:1px solid #d4b896; border-radius:20px;
      font-size:13px; background:#fff; color:#2c1810; outline:none; }
    #koko-send { background:#2c1810; color:#f5e6d3; border:none; border-radius:20px;
      padding:9px 16px; cursor:pointer; font-size:13px; }
  \`;

  const el = document.createElement("div");
  el.id = "koko-widget";
  el.innerHTML = \`
    <style>\${styles}</style>
    <button id="koko-btn">🌸 Style Assistant</button>
    <div id="koko-box">
      <div id="koko-header">
        <span>✦ KOKO ATELIER</span>
        <button id="koko-close">✕</button>
      </div>
      <div id="koko-msgs"></div>
      <div id="koko-footer">
        <input id="koko-input" placeholder="Ask about orders, sizes, collections..." />
        <button id="koko-send">Send</button>
      </div>
    </div>
  \`;
  document.body.appendChild(el);

  const btn = document.getElementById("koko-btn");
  const box = document.getElementById("koko-box");
  const close = document.getElementById("koko-close");
  const msgs = document.getElementById("koko-msgs");
  const input = document.getElementById("koko-input");
  const send = document.getElementById("koko-send");

  addMsg("bot", "${KOKO_CONFIG.welcomeMessage}");

  btn.onclick = () => { box.style.display = "flex"; btn.style.display = "none"; };
  close.onclick = () => { box.style.display = "none"; btn.style.display = "block"; };
  send.onclick = sendMsg;
  input.onkeydown = e => { if (e.key === "Enter") sendMsg(); };

  function addMsg(type, text) {
    const d = document.createElement("div");
    d.className = "koko-msg koko-" + type;
    d.textContent = text;
    msgs.appendChild(d);
    msgs.scrollTop = msgs.scrollHeight;
    return d;
  }

  async function sendMsg() {
    const msg = input.value.trim();
    if (!msg) return;
    input.value = "";
    addMsg("user", msg);

    const typing = document.createElement("div");
    typing.className = "koko-typing";
    typing.textContent = "Zara is typing...";
    msgs.appendChild(typing);
    msgs.scrollTop = msgs.scrollHeight;

    try {
      const res = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": KEY },
        body: JSON.stringify({ message: msg, sessionId })
      });
      const data = await res.json();
      typing.remove();
      sessionId = data.sessionId;
      addMsg("bot", data.reply || "I'm sorry, something went wrong. Please try again.");
    } catch {
      typing.remove();
      addMsg("bot", "I seem to be offline right now. Please reach out via WhatsApp.");
    }
  }
})();
  `);
});

// ============================================================
// HEALTH CHECK
// ============================================================
app.get("/health", (_, res) => res.json({
  status: "ok",
  assistant: "Zara — Koko Atelier",
  timestamp: new Date().toISOString(),
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌸 Koko Atelier Assistant running on port ${PORT}`);
});
