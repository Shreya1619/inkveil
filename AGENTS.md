# AGENTS.md — InkVeil Rulebook

This document defines the permanent architectural, engineering, and pipeline rules for the **InkVeil** project. All autonomous AI agents, subagents, and human contributors working within this repository must adhere strictly to these principles.

---

## 1. Zero-Cost Architecture

The system is designed to operate completely free of ongoing cloud infrastructure and subscription costs.

* **Backend Environment**:
  * Runs locally inside a Docker container.
  * Runtime: **Python 3.11** using **FastAPI** and **Pydantic v2**.
* **OpenAI-Compatible LLM Integration**:
  * All LLM interactions must strictly utilize standard OpenAI-compatible client libraries/SDKs.
  * The backend must support three switchable providers configured dynamically per request:
    1. **Google AI Studio Free Tier** (Default)
       * Default Model: `gemini-3.8-flash`
       * Base URL: `https://generativelanguage.googleapis.com/v1beta/openai/`
    2. **OpenRouter Free Tier**
       * Model: `openrouter/free`
       * Base URL: `https://openrouter.ai/api/v1`
    3. **Local Ollama**
       * Model: `gemma4`
       * Base URL: `http://host.docker.internal:11434/v1`
* **Zero Hardcoded Secrets**:
  * Under no circumstances should API keys, tokens, or personal secrets be committed to the repository or hardcoded into the backend code or Docker images.
  * API keys and provider selections are managed securely on the client side in the Chrome extension's local storage (`chrome.storage.local`) and passed per request via request headers or validated request payloads.

---

## 2. Context-Aware Manga Pipeline

High-quality manga translation depends fundamentally on narrative continuity, dialogue flow, and contextual visual-text placement.

* **Target Language (English Only)**:
  * The pipeline strictly and exclusively translates Japanese manga dialogue and text into fluent, natural English (`translated_text`). Non-English target languages and multi-target language selectors are explicitly out of scope to preserve prompt density, glossary accuracy, and zero-cost model token limits.
* **No Isolated Bubbles**:
  * Never translate speech bubbles in isolation. Independent, piecemeal bubble translation destroys discourse coherence, speaker tone, and pronoun consistency.
* **Strict Japanese Manga Reading Order**:
  * Detected speech bubbles, narration boxes, and sound effects must always be sorted geometrically before processing.
  * Sorting rule: **Right-to-Left (RTL), Top-to-Bottom (TTB)**.
  * The pipeline must calculate spatial reading sequences using bounding box coordinates to ensure dialogue order accurately matches panel reading flow.
* **Batch Processing & Persistent Glossary**:
  * The full set of ordered bubbles for an entire page must be passed to the LLM in a single batch prompt.
  * Translations must be paired with a persistent JSON character and term glossary (capturing character names, pronouns, relationship dynamics, honorifics, and series terminology) to preserve consistency across consecutive panels, pages, and chapters.

---

## 3. Chrome Extension Frontend

The user-facing frontend is an unobtrusive browser extension built for performance, simplicity, and ease of deployment.

* **Manifest & Technology Stack**:
  * Built targeting **Manifest V3**.
  * Written exclusively in **vanilla HTML, CSS, and JavaScript**.
  * **No build tools or bundlers** (e.g., Webpack, Vite, Rollup, Babel, npm build steps). The extension directory must be directly loadable as an unpacked extension in Developer Mode.
* **Coordinate System**:
  * Text detection bounding boxes and overlay coordinates must use normalized coordinates formatted as `[ymin, xmin, ymax, xmax]` scaled on a standard **0–1000** integer scale relative to image dimensions.
  * The content script maps these normalized coordinates dynamically to the actual rendered image dimensions on the webpage.
* **Interactive Hover Overlays**:
  * Translated text overlays placed on top of original manga panels must support an inspection state:
  * When a reader hovers over a translated bubble, its CSS opacity must automatically fade down to **15%** (`opacity: 0.15; transition: opacity 0.2s ease;`).
  * This allows readers to effortlessly view and verify the original Japanese artwork, furigana, and kanji underneath.

---

## 4. Engineering & Repository Standards

All contributions must follow professional, maintainable, and verifiable software engineering practices.

* **Modular Directory Layout**:
  ```text
  inkveil/
  ├── AGENTS.md                  # Project rulebook and agent instructions
  ├── backend/
  │   ├── Dockerfile             # Local Docker configuration
  │   ├── requirements.txt       # Python dependencies (Python 3.11)
  │   ├── app/
  │   │   ├── main.py            # FastAPI application entrypoint & CORS
  │   │   ├── config.py          # Provider and runtime settings
  │   │   ├── schemas/           # Pydantic v2 data models
  │   │   └── pipeline/          # Core manga processing logic
  │   │       ├── detector.py    # Text detection & OCR handling
  │   │       ├── sorter.py      # RTL/TTB spatial ordering
  │   │       ├── translator.py  # LLM batch translation & glossary handling
  │   │       └── ...
  │   └── tests/                 # Unit and integration tests (PyTest)
  └── extension/
      ├── manifest.json          # Manifest V3 specification
      ├── popup/                 # Extension popup UI (API key / provider config)
      ├── content/               # Content scripts for DOM inspection & overlay rendering
      └── background/            # Service worker scripts
  ```
* **Strict Pydantic Validation**:
  * All input payloads, backend configuration structures, and pipeline interfaces must be strictly modeled and validated using **Pydantic v2**.
* **Cross-Origin Resource Sharing (CORS)**:
  * The FastAPI application must have CORS middleware configured to accept requests from Chrome extension origins (`chrome-extension://*`) and local development origins.
* **Testing & Verification**:
  * All core logic (spatial RTL/TTB bubble sorting, coordinate normalization/scaling, prompt assembly, and glossary merging) must be thoroughly covered by unit tests using **PyTest** located in `backend/tests/`.
