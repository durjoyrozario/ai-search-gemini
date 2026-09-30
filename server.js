import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 3000);
const MODEL = process.env.MODEL || "gemini-2.5-flash";
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
- Do not invent facts. If you cannot find something, say so.`;

const app = express();

// CORS: lets the static page (GitHub Pages or an Android app's index.html) call this backend.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: "20kb" }));
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

    const url = `${API_BASE}/v1beta/models/${encodeURIComponent(MODEL)}:streamGenerateContent?alt=sse`;
    const upstream = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", "x-goog-api-key": API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: query }] }],
        tools: [{ google_search: {} }],
        generationConfig: { maxOutputTokens: MAX_TOKENS },
      }),
    });

    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text().catch(() => "");
      console.error("Gemini error", upstream.status, detail.slice(0, 500));
      const message =
        upstream.status === 429
          ? "The free usage limit was reached. Please try again in a little while."
          : "Something went wrong while answering. Please try again.";
      sse(res, "error", { message });
      return;
    }

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
