# AI Search backend (Gemini)

Node.js backend for the AI Search page. It asks Gemini (with Google Search) and streams the
answer back with source links. The API key stays on the server.

## Run locally

```bash
npm install
cp .env.example .env      # Windows: copy .env.example .env
# put your key in .env (GEMINI_API_KEY), get one at https://aistudio.google.com/apikey
npm start
```

Open http://localhost:3000

## Settings (.env / host environment variables)

| Name | Meaning | Default |
|---|---|---|
| `GEMINI_API_KEY` | Your Gemini API key (keep secret) | required |
| `MODEL` | Gemini model name | `gemini-2.5-flash` |
| `MAX_TOKENS` | Max length of one answer | `4096` |
| `RATE_LIMIT_PER_MIN` | Requests per IP per minute, `0` = unlimited | `0` (example file sets 5) |
| `ALLOWED_ORIGIN` | Which site may call the backend | `*` |
| `PORT` | Server port | `3000` |

## Free tier notes

- The free tier has daily and per-minute limits set by Google. When it runs out the page shows an
  error until the limit resets.
- Free-tier prompts may be used by Google to improve its products. Do not send private data.
- Check the current limits at https://ai.google.dev/gemini-api/docs/pricing

## Deploy on Render (free)

1. Push this folder to a GitHub repository (never commit `.env`).
2. render.com > New > Web Service > choose the repository.
3. Runtime Node, Build `npm install`, Start `npm start`, Instance type Free.
4. Add environment variable `GEMINI_API_KEY` (and `RATE_LIMIT_PER_MIN`).
5. Copy the URL Render gives you and put it in `API_BASE` in `ai-search-static/index.html`.

The free plan sleeps when idle; the first question after a break can take up to a minute.
