import logging
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.pipeline.translator import translate_manga_page
from app.schemas import HealthResponse, TranslatePageRequest, TranslatePageResponse

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger("manga_translator_api")

app = FastAPI(
    title="Smart Manga Translator Backend",
    version="1.0.0",
    description="Local Dockerized translation backend for Smart Manga Translator"
)

# Enable CORS for Chrome Extension origins and local development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_origin_regex=r"^chrome-extension://.*",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health", response_model=HealthResponse, tags=["Health"])
def health_check() -> HealthResponse:
    """Health check endpoint to verify backend service status."""
    return HealthResponse(status="ok")


@app.post("/translate-page", response_model=TranslatePageResponse, tags=["Translation"])
def translate_page(request: TranslatePageRequest) -> TranslatePageResponse:
    """
    Context-aware manga page translation endpoint.
    Processes the entire page with OpenAI-compatible vision providers,
    extracts dialogue bubbles in Japanese reading order (RTL, TTB),
    and maintains glossary continuity across requests.
    """
    return translate_manga_page(request)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=True)
