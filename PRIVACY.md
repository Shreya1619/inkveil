# Privacy Policy — InkVeil

**Last updated:** November 24, 2026

InkVeil is a browser extension that detects Japanese comic/manga speech bubbles on a page and displays English translated text overlays.

## What Data Is Stored & Sent
- **API Keys & Preferences:** Provider choice, optional custom model name, overlay font size (`10px`–`18px`), and API keys are stored locally in your browser via `chrome.storage.local`. API keys are not hardcoded in the extension or stored on a developer server.
- **Page Captures & Saved Names/Terms:** When you translate a page, the extension captures the target image or canvas (using `captureVisibleTab` fallback if needed) and sends it with session character names/terms to your configured backend or LLM endpoint.
- **No Ad Tracking or Data Sales:** InkVeil does not sell user data, run third-party advertising trackers, or collect browsing analytics on its own servers.

## Third-Party Services
Translations go through the backend and LLM provider you configure (such as Google AI Studio, OpenRouter, or a local Ollama instance). Their privacy policies apply to data sent to those endpoints.

## Contact
Open an issue on the InkVeil GitHub repository for questions or support.