import json
import logging
import random
import re
import time
from typing import Any, Dict, List, Optional, Tuple

from fastapi import HTTPException
from openai import OpenAI, RateLimitError, APIStatusError, APIConnectionError, APITimeoutError

from app.pipeline.sorter import sort_bubbles_rtl_ttb
from app.schemas import Bubble, ProviderEnum, TranslatePageRequest, TranslatePageResponse

logger = logging.getLogger(__name__)

# Provider configuration defaults as defined in AGENTS.md
PROVIDER_CONFIGS = {
    ProviderEnum.GEMINI: {
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai/",
        "default_model": "gemini-2.0-flash",
        "requires_api_key": True,
    },
    ProviderEnum.OPENROUTER: {
        "base_url": "https://openrouter.ai/api/v1",
        "default_model": "openrouter/free",
        "requires_api_key": True,
    },
    ProviderEnum.OLLAMA: {
        "base_url": "http://host.docker.internal:11434/v1",
        "default_model": "gemma3:4b",
        "requires_api_key": False,
    },
}

# Retry configuration: attempt up to MAX_RETRIES times on transient failures
# (429 rate-limit and 503 service-unavailable).
MAX_RETRIES = 4
RETRY_BASE_DELAY_S = 2.0    # Initial back-off delay in seconds
RETRY_MAX_DELAY_S  = 30.0   # Cap on any single wait
RETRY_JITTER_S     = 0.5    # Random jitter to avoid thundering herd

# HTTP status codes considered transient and worth retrying
TRANSIENT_STATUS_CODES = {429, 503, 502, 504}

SYSTEM_PROMPT = """You are an expert manga localization specialist and translator.
Your task is to analyze the provided manga page image, detect all dialogue bubbles, narration boxes, and sound effects, and translate them into natural, context-aware English.

STRICT RULES:
1. Context-Aware Manga Translation: Never translate speech bubbles in isolation. Consider the entire panel sequence, discourse continuity, character relationships, and emotional tone across the page.
2. Japanese Manga Reading Order: Detected bubbles must be analyzed in strict Japanese reading order: Right-to-Left (RTL), Top-to-Bottom (TTB).
3. Coordinate System: For each detected bubble or text region, provide the bounding box as 'box_2d': [ymin, xmin, ymax, xmax] scaled to integer coordinates 0 to 1000 relative to the image (0 is top/left, 1000 is bottom/right).
4. Glossary Continuity: Utilize and respect established character names, relationships, and terms provided in the incoming glossary. If new character names, terms, or key pronouns are revealed, add them to 'updated_glossary'.

Output Format:
Return ONLY a valid JSON object with the following schema:
{
  "bubbles": [
    {
      "order": 1,
      "box_2d": [ymin, xmin, ymax, xmax],
      "original_text": "Detected Japanese text",
      "translated_text": "English contextual translation"
    }
  ],
  "updated_glossary": {
    "Term/Name": "English Translation or Contextual Note"
  }
}
"""


def extract_json_payload(raw_content: str) -> Dict[str, Any]:
    """Extract and parse JSON from raw LLM output, handling markdown fences or preamble."""
    raw_content = raw_content.strip()

    # Try 1: Match ```json ... ``` markdown code fence
    fence_match = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", raw_content, re.IGNORECASE)
    if fence_match:
        try:
            return json.loads(fence_match.group(1).strip())
        except json.JSONDecodeError:
            pass

    # Try 2: Find outermost { ... }
    first_brace = raw_content.find("{")
    last_brace = raw_content.rfind("}")
    if first_brace != -1 and last_brace != -1 and last_brace > first_brace:
        json_candidate = raw_content[first_brace : last_brace + 1]
        try:
            return json.loads(json_candidate)
        except json.JSONDecodeError:
            pass

    # Try 3: Direct parse
    return json.loads(raw_content)


def _is_transient_error(exc: Exception) -> bool:
    """Return True if the exception represents a transient, retryable API failure."""
    if isinstance(exc, RateLimitError):
        return True
    if isinstance(exc, (APIConnectionError, APITimeoutError)):
        return True
    if isinstance(exc, APIStatusError):
        return exc.status_code in TRANSIENT_STATUS_CODES
    # Catch-all for wrapped status errors surfaced as plain Exception
    msg = str(exc).lower()
    return any(
        token in msg
        for token in ("429", "503", "502", "504", "rate limit", "service unavailable",
                      "overloaded", "too many requests", "quota")
    )


def _backoff_delay(attempt: int) -> float:
    """Exponential back-off with full jitter: delay = min(base * 2^attempt + jitter, max)."""
    exp = min(RETRY_BASE_DELAY_S * (2 ** attempt), RETRY_MAX_DELAY_S)
    jitter = random.uniform(0, RETRY_JITTER_S)
    return exp + jitter


def _user_friendly_error(exc: Exception, provider: str, model: str) -> str:
    """Return a concise, actionable error message for the given API exception."""
    if isinstance(exc, RateLimitError) or "429" in str(exc):
        return (
            f"Rate limit reached on {provider} ({model}). "
            "The free tier quota may be exhausted for today. "
            "Wait a moment and try again, or switch to a different provider in the extension popup."
        )
    if isinstance(exc, APITimeoutError) or "timeout" in str(exc).lower():
        return (
            f"{provider} ({model}) took too long to respond (timeout). "
            "The image may be too large — try a smaller crop, or switch to Ollama for local processing."
        )
    if isinstance(exc, APIConnectionError) or "connection" in str(exc).lower():
        return (
            f"Could not connect to {provider}. "
            "Check your internet connection. If using Ollama, ensure the container is running."
        )
    if "503" in str(exc) or "service unavailable" in str(exc).lower():
        return (
            f"{provider} ({model}) is temporarily unavailable (503). "
            "This is a provider-side issue — wait a minute and retry, or switch provider."
        )
    # Generic fallback
    return f"Translation failed ({provider} / {model}): {exc}"


class MangaTranslator:
    @staticmethod
    def resolve_provider_config(
        provider: ProviderEnum,
        custom_model: Optional[str] = None,
        api_key: Optional[str] = None,
    ) -> Tuple[str, str, str]:
        """Resolves (base_url, model, effective_api_key) for the selected provider."""
        config = PROVIDER_CONFIGS.get(provider)
        if not config:
            raise HTTPException(
                status_code=400,
                detail=f"Unsupported provider '{provider}'. Must be one of: {list(PROVIDER_CONFIGS.keys())}",
            )

        base_url = config["base_url"]
        model = custom_model.strip() if custom_model and custom_model.strip() else config["default_model"]

        if config["requires_api_key"]:
            if not api_key or not api_key.strip():
                raise HTTPException(
                    status_code=400,
                    detail=f"API key is required for provider '{provider.value}'. Please configure it in extension settings.",
                )
            effective_key = api_key.strip()
        else:
            effective_key = (api_key.strip() if api_key and api_key.strip() else "ollama")

        return base_url, model, effective_key

    @staticmethod
    def clean_base64_image(image_base64: str) -> str:
        """Strip data URI prefix if present and remove extra whitespace."""
        cleaned = image_base64.strip()
        cleaned = re.sub(r"^data:image\/[a-zA-Z0-9\+\-\.]+;base64,", "", cleaned)
        return cleaned

    @classmethod
    def translate_page(cls, req: TranslatePageRequest) -> TranslatePageResponse:
        base_url, model_to_use, effective_key = cls.resolve_provider_config(
            provider=req.provider,
            custom_model=req.model,
            api_key=req.api_key,
        )

        clean_b64 = cls.clean_base64_image(req.image_base64)
        if not clean_b64:
            raise HTTPException(status_code=400, detail="Empty or invalid image_base64 provided.")

        # Disable the SDK's own retry logic — we control retries ourselves
        # so we can log each attempt and apply our own back-off schedule.
        client = OpenAI(
            base_url=base_url,
            api_key=effective_key,
            timeout=120.0,
            max_retries=0,
        )

        user_content = [
            {
                "type": "text",
                "text": (
                    f"Translate this manga page. Established glossary:\n"
                    f"{json.dumps(req.glossary, ensure_ascii=False, indent=2)}\n\n"
                    f"Detect all bubbles in Right-to-Left, Top-to-Bottom order and return strict JSON."
                ),
            },
            {
                "type": "image_url",
                "image_url": {
                    "url": f"data:image/jpeg;base64,{clean_b64}"
                },
            },
        ]

        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_content},
        ]

        last_exc: Optional[Exception] = None

        for attempt in range(MAX_RETRIES + 1):
            try:
                if attempt > 0:
                    delay = _backoff_delay(attempt - 1)
                    logger.warning(
                        f"[Retry {attempt}/{MAX_RETRIES}] Retrying {req.provider.value} / {model_to_use} "
                        f"after {delay:.1f}s (last error: {last_exc})"
                    )
                    time.sleep(delay)

                logger.info(
                    f"[Attempt {attempt + 1}/{MAX_RETRIES + 1}] Sending translation request to "
                    f"{req.provider.value} using model {model_to_use}"
                )
                completion = client.chat.completions.create(
                    model=model_to_use,
                    messages=messages,
                    temperature=0.2,
                )
                raw_text = completion.choices[0].message.content or ""
                # Success — break out of retry loop
                break

            except Exception as exc:
                last_exc = exc
                if _is_transient_error(exc) and attempt < MAX_RETRIES:
                    logger.warning(
                        f"[Attempt {attempt + 1}] Transient error from {req.provider.value}: {exc}"
                    )
                    continue  # will sleep then retry
                else:
                    # Non-transient, or exhausted retries
                    friendly_msg = _user_friendly_error(exc, req.provider.value, model_to_use)
                    logger.error(
                        f"Translation failed after {attempt + 1} attempt(s) "
                        f"({req.provider.value} / {model_to_use}): {exc}",
                        exc_info=True,
                    )
                    raise HTTPException(status_code=502, detail=friendly_msg)
        else:
            # Loop exhausted all retries without a break (all attempts raised)
            friendly_msg = _user_friendly_error(last_exc, req.provider.value, model_to_use)
            logger.error(
                f"All {MAX_RETRIES + 1} attempts failed for "
                f"{req.provider.value} / {model_to_use}: {last_exc}",
                exc_info=True,
            )
            raise HTTPException(status_code=502, detail=friendly_msg)

        # ── Parse LLM output ──────────────────────────────────────────────────
        try:
            parsed = extract_json_payload(raw_text)
        except Exception as e:
            logger.error(f"Failed to parse LLM response into JSON: {raw_text}", exc_info=True)
            raise HTTPException(
                status_code=500,
                detail=f"LLM output could not be parsed as valid JSON: {str(e)}",
            )

        raw_bubbles = parsed.get("bubbles", [])
        validated_bubbles: List[Bubble] = []
        for idx, b in enumerate(raw_bubbles, start=1):
            try:
                validated_bubbles.append(
                    Bubble(
                        order=b.get("order", idx),
                        box_2d=b.get("box_2d", [0, 0, 100, 100]),
                        original_text=b.get("original_text", ""),
                        translated_text=b.get("translated_text", ""),
                    )
                )
            except Exception as b_err:
                logger.warning(f"Skipping malformed bubble item {b}: {b_err}")

        # Strictly sort in Japanese manga reading order (RTL, TTB)
        sorted_bubbles = sort_bubbles_rtl_ttb(validated_bubbles)

        # Merge glossary
        returned_glossary = parsed.get("updated_glossary", {})
        merged_glossary = dict(req.glossary)
        if isinstance(returned_glossary, dict):
            merged_glossary.update(returned_glossary)

        return TranslatePageResponse(
            bubbles=sorted_bubbles,
            updated_glossary=merged_glossary,
            model_used=model_to_use,
        )


def translate_manga_page(request: TranslatePageRequest) -> TranslatePageResponse:
    """Convenience wrapper for MangaTranslator.translate_page."""
    return MangaTranslator.translate_page(request)
