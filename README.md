# InkVeil

> **Zero-cost, context-aware Japanese-to-English manga translation in your browser.**
> Detects speech bubbles on any Japanese manga page, translates them into natural English in proper Right-to-Left reading order using a free AI vision model, and renders interactive comic-styled overlays — all from a local Docker backend with no recurring cloud fees.

---

## Table of Contents
- [Architecture Overview](#architecture-overview)
- [Core Pipeline: RTL/TTB Batch Translation + Persistent Glossary](#core-pipeline)
- [Zero-Cost LLM Providers](#zero-cost-llm-providers)
- [Project Structure](#project-structure)
- [Docker Setup (Backend)](#docker-setup-backend)
- [Chrome / Edge Extension Setup](#chrome--edge-extension-setup)
- [Usage](#usage)
- [Running Tests](#running-tests)
- [Design Constraints (AGENTS.md)](#design-constraints)

---

## Architecture Overview

```
┌────────────────────────────────┐       ┌───────────────────────────────────────┐
│   InkVeil Extension (MV3)      │       │   Local Docker Backend (port 8000)    │
│   (Manifest V3, Vanilla JS)    │       │   FastAPI + Python 3.11 + Pydantic v2 │
│                                │       │                                       │
│  popup.html / popup.js         │       │  GET  /health                         │
│  ├─ Provider selector          │──────▶│  POST /translate-page                 │
│  ├─ API Key (chrome.storage)   │       │   ├─ Detect bubbles via LLM vision    │
│  ├─ Font size live slider      │       │   ├─ Sort RTL/TTB (sorter.py)         │
│  └─ Translate / Toggle buttons │       │   ├─ Batch translate + glossary merge │
│                                │◀──────│   └─ Return bubbles + updated glossary│
│  content.js                    │       └───────────────────────────────────────┘
│  ├─ Viewport manga detection   │                        │
│  ├─ Two-page spread stitcher   │             OpenAI-compatible SDK
│  ├─ Base64 encode (CORS-safe)  │                        │
│  └─ Auto-expanding overlays    │        ┌───────────────┼───────────────┐
│                                │        │               │               │
│  background.js (service worker)│   Google AI       OpenRouter      Ollama
│  └─ captureVisibleTab fallback │   Studio Free      Free Tier     (local)
└────────────────────────────────┘
```

**Data flow:**
1. User clicks "Translate Main Page" in the InkVeil popup.
2. `content.js` finds the primary manga `<img>` or `<canvas>` in the viewport, checks for adjacent spread partners, and extracts/stitches base64 JPEG data (with tab-capture fallback for tainted canvases).
3. It POSTs `{image_base64, provider, api_key, model, glossary}` to `http://localhost:8000/translate-page`.
4. The backend sends the image to the chosen vision model with a system prompt requesting JSON output — bubbles with bounding boxes `[ymin, xmin, ymax, xmax]` on a 0–1000 scale.
5. The pipeline validates, sorts in RTL/TTB order, merges the glossary, and returns structured JSON.
6. `content.js` renders parchment-styled overlays. Boxes expand vertically (`height: auto`) to enclose all text cleanly. Hovering the 👁 badge or holding **Shift** fades the overlay to 22% ("Peek mode"), and clicking the badge pins the inspection view.

---

## Core Pipeline

### Right-to-Left, Top-to-Bottom Bubble Ordering

Japanese manga is read Right-to-Left, Top-to-Bottom. The backend enforces this geometrically:

```python
# sorter.py — calculates a composite sort key
def calculate_reading_order_key(box):
    ymin, xmin, ymax, xmax = box
    center_x = (xmin + xmax) / 2.0
    center_y = (ymin + ymax) / 2.0
    col_index = int(center_x // 333)        # ~3 columns on a 0-1000 scale
    return (-col_index, center_y, -center_x)  # right-first, then top-down
```

Bubbles are **never translated in isolation** — the entire sorted set for a page is submitted as a single batch prompt, preserving speaker tone, pronoun consistency, and dialogue flow.

### Target Language: English Only

InkVeil is purposefully engineered exclusively for **Japanese-to-English** translation. Detected dialogue, sound effects, and narration boxes are translated into fluent, natural English with manga-appropriate idioms. Non-English target languages are intentionally omitted to avoid prompt bloat, retain maximum glossary precision, and ensure fast responses within zero-cost free-tier token allowances.

### Persistent JSON Glossary

A per-session glossary dict accumulates character names, honorifics, pronouns, and series terminology as pages are translated:

```jsonc
// Example glossary after two pages
{
  "Luffy": "Monkey D. Luffy",
  "Nami-san": "Nami (respectful address)",
  "ゴムゴムの実": "Gum-Gum Fruit"
}
```

The glossary is passed to every `/translate-page` call, the LLM is instructed to respect it, and any newly discovered terms are merged back — existing keys always win to prevent drift.

---

## Zero-Cost LLM Providers

All three providers are accessed via the standard OpenAI-compatible SDK — just swap `base_url` and `api_key`:

| Provider | Model | Base URL | Cost |
|---|---|---|---|
| **Google AI Studio** (default) | `gemini-2.0-flash` | `https://generativelanguage.googleapis.com/v1beta/openai/` | Free tier |
| **OpenRouter** | `openrouter/free` | `https://openrouter.ai/api/v1` | Free tier |
| **Local Ollama** | `gemma3:4b` | `http://host.docker.internal:11434/v1` | Free (local GPU/CPU) |

Switch provider per-request from the extension popup. API keys are stored only in `chrome.storage.local` and sent per-request — **never stored server-side or committed to the repo**.

The backend retries transient `429` / `503` failures automatically with exponential back-off (up to 4 retries, capped at 30 s), and surfaces actionable error messages to the popup.

---

## Project Structure

```text
inkveil/
├── AGENTS.md                    # Permanent project rulebook for AI agents & contributors
├── README.md                    # This file
├── docker-compose.yml           # Compose file — spins up backend on :8000
├── backend/
│   ├── Dockerfile               # python:3.11-slim + uvicorn --reload
│   ├── requirements.txt         # fastapi, uvicorn[standard], pydantic>=2, openai, pillow
│   ├── app/
│   │   ├── main.py              # FastAPI app — GET /health, POST /translate-page, CORS
│   │   ├── schemas.py           # Pydantic v2 models (TranslatePageRequest/Response, Bubble)
│   │   └── pipeline/
│   │       ├── sorter.py        # RTL/TTB geometric bubble ordering
│   │       └── translator.py    # OpenAI-SDK multi-provider + retry/back-off logic
│   └── tests/
│       └── test_pipeline.py     # PyTest — sorting, clamping, glossary, retry helpers
└── extension/
    ├── manifest.json            # Manifest V3
    ├── background.js            # Service worker — captureVisibleTab fallback
    ├── popup.html / popup.js    # Provider/key/model config UI & live font size slider
    ├── content.js               # Viewport capture, spread stitching, backend call, overlays
    ├── styles.css               # Overlay bubble styles, Peek mode
    ├── icon16.png               # 16x16 extension icon
    ├── icon32.png               # 32x32 extension icon
    ├── icon48.png               # 48x48 extension icon
    └── icon128.png              # 128x128 extension icon
```

---

## Docker Setup (Backend)

### Prerequisites
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (Windows / macOS / Linux)
- A free API key from [Google AI Studio](https://aistudio.google.com/) or [OpenRouter](https://openrouter.ai/)

### Start the backend

```bash
# From the repo root:
docker-compose up -d --build
```

This builds the `python:3.11-slim` image, installs dependencies from `requirements.txt`, and starts FastAPI with hot-reload (`uvicorn --reload`) on **http://localhost:8000**.

### Verify it's running

```bash
curl http://localhost:8000/health
# → {"status":"ok"}
```

### Hot-reload during development

The `./backend/app` directory is bind-mounted into the container (`./backend/app:/app/app`), so any edit to Python source files is picked up instantly — no rebuild needed.

### Stop the backend

```bash
docker-compose down
```

---

## Chrome / Edge Extension Setup

The extension is **plain vanilla JS/HTML/CSS with no build step** — load it directly as an unpacked extension.

1. Open Chrome (or Edge) and navigate to `chrome://extensions/` (or `edge://extensions/`).
2. Enable **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked**.
4. Select the `extension/` folder inside this repository.
5. The **InkVeil** extension will appear. Pin it to the toolbar for easy access.

> **Note:** The extension communicates with `http://localhost:8000`. The Docker backend must be running before clicking "Translate Main Page".

### Configure the extension

Click the InkVeil extension icon to open the popup:

| Field | Description |
|---|---|
| **LLM Provider** | Google AI Studio (default), OpenRouter Free, or Local Ollama |
| **API Key** | Your key from AI Studio / OpenRouter (not needed for Ollama) |
| **Custom Model** | Optional — leave blank to use the provider default |
| **Overlay Font Size** | Slider (10px–18px, default 12px) with live overlay updates |

Settings are saved automatically to `chrome.storage.local`.

---

## Usage

1. Open any manga reader page (e.g., MangaDex, Mangakakalot, a local reader).
2. Click the **InkVeil** icon in the toolbar.
3. Click **Translate Main Page**.
   - The extension finds the primary manga image/canvas visible in the viewport (or stitches two-page spreads).
   - Sends it to the local backend for context-aware batch translation.
   - Renders parchment overlays with translated text in correct reading order.
4. **Read** the translation directly on top of the manga panels.
5. **Peek at original art:** Hover the 👁 badge or hold **Shift** while hovering a bubble to fade it to 22% opacity. Click the 👁 badge to toggle a persistent pinned view.
6. **Live Font Size:** Adjust the popup slider to scale text up or down immediately without re-translating.
7. **Toggle Overlays:** Hide/show all overlays with one click.
8. **Clear Saved Names & Terms:** Reset remembered character names and terminology so the next chapter or series starts fresh.

---

## Running Tests

```bash
# Run the full PyTest suite inside the Docker container
docker exec smart-manga-translator-backend pytest -v /app/tests

# Or from the repo root (requires PYTHONPATH set):
# PYTHONPATH=backend python -m pytest backend/tests -v
```

Expected output: all 31 tests pass covering:
- Pydantic coordinate clamping (below 0, above 1000, inverted axes)
- RTL/TTB multi-column and multi-row sort ordering
- Glossary accumulation and key-preservation across pages
- JSON payload extraction (markdown fences, bare JSON, preamble)
- Provider configuration and model resolution
- Retry helper: `_is_transient_error`, `_backoff_delay`, `_user_friendly_error`

---

## Design Constraints

All development must follow [AGENTS.md](./AGENTS.md):

- **Target language (English only)** — dedicated exclusively to translating Japanese manga dialogue into natural English.
- **Zero hardcoded secrets** — API keys live in `chrome.storage.local`, passed per-request.
- **No isolated bubble translation** — always batch the full page.
- **RTL/TTB ordering** — geometrically enforced before every LLM call.
- **OpenAI-compatible SDK only** — no provider-specific SDKs.
- **Manifest V3, vanilla JS** — no bundler, directly loadable as unpacked extension.
- **Coordinate system** — `[ymin, xmin, ymax, xmax]` on 0–1000 integer scale.
- **Hover inspection** — overlays fade to 22% on Shift+hover / Peek badge, click pins inspection state.
- **PyTest coverage** — all core logic tested in `backend/tests/`.
