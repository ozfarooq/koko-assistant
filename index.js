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
  systemPrompt: `You are Zara, a chat assistant for Koko Atelier, a fashion brand in Lahore.

ABSOLUTE RULES — NEVER BREAK THESE:
1. Maximum 2 sentences per reply. No exceptions. No third sentence.
2. Plain text only. NEVER use markdown: no #, no **, no -, no numbered lists, no bullet points.
3. No emojis whatsoever.
4. Write in clean English only. Do NOT use Urdu filler words like "bilkul", "jee", "ji", "haan", "zaroor". No mixing languages.
5. If the customer needs more help, end with one short question or direct them to WhatsApp +92 313 4730467.
6. Never give long explanations, step-by-step guides, or detailed breakdowns. One concise answer only.

GOOD REPLY EXAMPLE:
Q: Do you ship internationally?
A: Yes, we ship internationally via DHL and Skynet to UAE, UK, USA, Canada and more. WhatsApp us at +92 313 4730467 with your location and we will share the exact courier quote.

BAD REPLY (never do this):
# International Shipping
**Delivery:** 7-14 days
- UAE
- UK
- USA
1. Add to cart
2. Enter address

Keep every reply short, plain text, and direct.`,

  welcomeMessage: "Assalam o Alaikum! 🌸 Welcome to Koko Atelier. I'm Zara, your personal style assistant. How can I help you today?",
  model: "claude-haiku-4-5-20251001",
  maxTokens: 150, // hard cap — forces short replies
};

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
// KNOWLEDGE RETRIEVAL — Supabase lookup
// ============================================================
async function getContext(query) {
  try {
    const { data } = await supabase
      .from("koko_knowledge")
      .select("content")
      .textSearch("content", query.split(" ").slice(0, 3).join(" "), { type: "plain" })
      .limit(3);
    if (data?.length) {
      return `\n\nRelevant Koko Atelier information:\n${data.map(d => d.content).join("\n\n")}`;
    }
  } catch { /* db not available */ }
  return "";
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
    #koko-widget * { box-sizing:border-box; font-family:'Helvetica Neue',Arial,sans-serif; margin:0; padding:0; }
    #koko-btn { position:fixed; bottom:24px; right:24px; z-index:9999;
      background:#1a1208; color:#fff; border:none; border-radius:4px;
      padding:12px 20px; cursor:pointer; font-size:12px; letter-spacing:2px; text-transform:uppercase;
      box-shadow:0 2px 16px rgba(0,0,0,0.25); transition:opacity 0.2s; }
    #koko-btn:hover { opacity:0.85; }
    #koko-box { position:fixed; bottom:76px; right:24px; z-index:9999;
      width:360px; height:500px; background:#fff; border-radius:2px;
      box-shadow:0 4px 32px rgba(0,0,0,0.14); display:none; flex-direction:column; overflow:hidden; }
    #koko-header { background:#1a1208; color:#fff; padding:16px 20px;
      display:flex; justify-content:space-between; align-items:center; }
    #koko-header-title { font-size:11px; letter-spacing:3px; text-transform:uppercase; }
    #koko-header-sub { font-size:10px; opacity:0.6; letter-spacing:1px; margin-top:2px; }
    #koko-close { background:none; border:none; color:#fff; font-size:16px; cursor:pointer; opacity:0.7; line-height:1; }
    #koko-close:hover { opacity:1; }
    #koko-msgs { flex:1; overflow-y:auto; padding:16px; display:flex; flex-direction:column; gap:12px;
      background:#fafaf8; }
    .koko-msg { max-width:82%; padding:10px 14px; font-size:13px; line-height:1.6; }
    .koko-user { align-self:flex-end; background:#1a1208; color:#fff; border-radius:2px; }
    .koko-bot { align-self:flex-start; background:#fff; color:#1a1208; border-radius:2px;
      border:1px solid #e8e4dc; }
    .koko-typing { align-self:flex-start; color:#999; font-size:11px; letter-spacing:1px;
      padding:8px 0; text-transform:uppercase; }
    #koko-footer { padding:12px 16px; border-top:1px solid #e8e4dc; display:flex; gap:8px; background:#fff; }
    #koko-input { flex:1; padding:10px 14px; border:1px solid #ddd; border-radius:2px;
      font-size:13px; color:#1a1208; outline:none; background:#fafaf8; }
    #koko-input:focus { border-color:#1a1208; }
    #koko-send { background:#1a1208; color:#fff; border:none; border-radius:2px;
      padding:10px 18px; cursor:pointer; font-size:11px; letter-spacing:1.5px; text-transform:uppercase; }
    #koko-send:hover { opacity:0.85; }
    #koko-msgs::-webkit-scrollbar { width:4px; }
    #koko-msgs::-webkit-scrollbar-track { background:#fafaf8; }
    #koko-msgs::-webkit-scrollbar-thumb { background:#ddd; border-radius:2px; }
  \`;

  const el = document.createElement("div");
  el.id = "koko-widget";
  el.innerHTML = \`
    <style>\${styles}</style>
    <button id="koko-btn">Ask Zara</button>
    <div id="koko-box">
      <div id="koko-header">
        <div>
          <div id="koko-header-title">Koko Atelier</div>
          <div id="koko-header-sub">Style Assistant · Zara</div>
        </div>
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