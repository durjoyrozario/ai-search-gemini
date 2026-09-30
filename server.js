import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 3000);
// Free-tier friendly defaults (see https://ai.dev/rate-limit for your own limits):
// - gemini-2.5-flash-lite: Google Search grounding is available on the free tier
// - gemini-3.5-flash-lite: larger daily allowance, but no free Google Search (answers without live search)
const MODEL = process.env.MODEL || "gemini-2.5-flash-lite";
const FALLBACK_MODELS = (process.env.FALLBACK_MODELS ?? "gemini-3.5-flash-lite").split(",").map((s) => s.trim()).filter(Boolean);
const MODELS = [MODEL, ...FALLBACK_MODELS.filter((m) => m !== MODEL)];
const MAX_TOKENS = Number(process.env.MAX_TOKENS || 4096);
const RATE_LIMIT = Number(process.env.RATE_LIMIT_PER_MIN || 0); // 0 = unlimited
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const API_BASE = process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com";
const API_KEY = process.env.GEMINI_API_KEY;

if (!API_KEY) {
  console.error("Missing GEMINI_API_KEY. Copy .env.example to .env and add your key.");
  process.exit(1);
}

const SYSTEM_PROMPT = `You are a research assistant inside a search website.
For every question, search the web for current, reliable information, then write a detailed, well-organized answer.
- Reply in the same language the user wrote their question in.
- Use Markdown: short headings, bullet points and bold text where they help.
- Be thorough but clear. Mention dates and figures when relevant.
- If sources disagree or information is uncertain, say so.
- Do not invent facts. If you cannot find something, say so.
- The conversation may contain earlier messages. Use them to understand follow-up questions.`;

const NO_SEARCH_PROMPT = `You are a helpful assistant inside a search website. Live web search is not available right now.
Answer from your own knowledge in a detailed, well-organized way.
- Reply in the same language the user wrote their question in.
- Use Markdown where it helps.
- Briefly mention that the information may be out of date and should be checked for recent events.
- Do not invent facts. If you are not sure, say so.
- The conversation may contain earlier messages. Use them to understand follow-up questions.`;

// Build the "contents" array for Gemini: earlier turns + the new question.
// Consecutive messages with the same role are merged, and the list always starts with a user turn.
function buildContents(history, query) {
  const turns = [
    ...history.map((h) => ({ role: h.role === "assistant" ? "model" : "user", text: h.content })),
    { role: "user", text: query },
  ];
  const merged = [];
  for (const t of turns) {
    const last = merged[merged.length - 1];
    if (last && last.role === t.role) last.parts[0].text += "\n\n" + t.text;
    else merged.push({ role: t.role, parts: [{ text: t.text }] });
  }
  while (merged.length > 1 && merged[0].role !== "user") merged.shift();
  return merged;
}

function callGemini(model, contents, useSearch, signal) {
  const url = `${API_BASE}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  const body = {
    systemInstruction: { parts: [{ text: useSearch ? SYSTEM_PROMPT : NO_SEARCH_PROMPT }] },
    contents,
    generationConfig: { maxOutputTokens: MAX_TOKENS },
  };
  if (useSearch) body.tools = [{ google_search: {} }];
  return fetch(url, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", "x-goog-api-key": API_KEY },
    body: JSON.stringify(body),
  });
}

function errorMessage(status) {
  if (status === 429) return "Google's usage limit was reached for this model (429). Try again later, or set another MODEL / FALLBACK_MODELS.";
  if (status === 404) return "The model name is not available (404). Set a current model in the MODEL variable.";
  if (status === 400 || status === 403 || status === 401)
    return `Google rejected the request (${status}). Check GEMINI_API_KEY and MODEL.`;
  return "Something went wrong while answering. Please try again.";
}

const app = express();

// CORS: lets the static page (GitHub Pages, biggo.gt.tc or an Android app's index.html) call this backend.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: "200kb" }));
app.use(express.static(path.join(__dirname, "public")));

// Optional in-memory rate limiter (off by default)
const hits = new Map();
function rateLimit(req, res, next) {
  if (!RATE_LIMIT) return next();
  const now = Date.now();
  const ip = req.ip;
  const recent = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  if (recent.length >= RATE_LIMIT) {
    return res.status(429).json({ error: "Too many requests. Please wait a moment." });
  }
  recent.push(now);
  hits.set(ip, recent);
  next();
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

app.post("/api/search", rateLimit, async (req, res) => {
  const query = String(req.body?.query || "").trim();
  if (!query) return res.status(400).json({ error: "Empty query." });
  if (query.length > 2000) return res.status(400).json({ error: "Query too long." });

  // Earlier messages of this chat (sent by the page). Keep only the last 8, each capped in length.
  const history = (Array.isArray(req.body?.history) ? req.body.history : [])
    .filter((h) => h && (h.role === "user" || h.role === "assistant") && typeof h.content === "string" && h.content.trim())
    .slice(-8)
    .map((h) => ({ role: h.role, content: h.content.slice(0, 4000) }));
  const contents = buildContents(history, query);

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const controller = new AbortController();
  res.on("close", () => controller.abort());

  const sources = new Map();
  let gotText = false;

  try {
    sse(res, "status", { state: "searching" });

    // Try each model in order. For each model, first with Google Search, and if that is
    // rejected (quota / unsupported) once more without search.
    let upstream = null;
    let usedSearch = true;
    let lastStatus = 0;

    outer: for (const model of MODELS) {
      for (const useSearch of [true, false]) {
        const r = await callGemini(model, contents, useSearch, controller.signal);
        if (r.ok && r.body) {
          upstream = r;
          usedSearch = useSearch;
          break outer;
        }
        lastStatus = r.status;
        const detail = await r.text().catch(() => "");
        console.error("Gemini error", model, useSearch ? "(with search)" : "(no search)", r.status, detail.slice(0, 500));
        if (useSearch && (r.status === 400 || r.status === 429)) continue; // retry same model without search
        if (r.status === 400 || r.status === 404 || r.status === 429) continue outer; // try next model
        break outer; // key problem or server error: stop
      }
    }

    if (!upstream) {
      sse(res, "error", { message: errorMessage(lastStatus) });
      return;
    }
    if (!usedSearch) sse(res, "notice", { code: "nosearch" });

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    const handleChunk = (json) => {
      const cand = json.candidates?.[0];
      if (!cand) return;
      for (const part of cand.content?.parts || []) {
        if (part.text) {
          gotText = true;
          sse(res, "text", { delta: part.text });
        }
      }
      for (const c of cand.groundingMetadata?.groundingChunks || []) {
        const w = c.web;
        if (w?.uri && !sources.has(w.uri)) sources.set(w.uri, { title: w.title || w.uri, url: w.uri });
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.search(/\r?\n\r?\n/)) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx).replace(/^\r?\n\r?\n/, "");
        const dataLine = raw
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("");
        if (!dataLine) continue;
        try {
          handleChunk(JSON.parse(dataLine));
        } catch {
          /* ignore malformed chunk */
        }
      }
    }

    if (!gotText) {
      sse(res, "error", { message: "No answer was returned. Please rephrase and try again." });
      return;
    }
    sse(res, "sources", { sources: [...sources.values()] });
    sse(res, "done", {});
  } catch (err) {
    if (!controller.signal.aborted) {
      console.error(err);
      sse(res, "error", { message: "Something went wrong while answering. Please try again." });
    }
  } finally {
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`AI Search (Gemini) running at http://localhost:${PORT}`);
});
