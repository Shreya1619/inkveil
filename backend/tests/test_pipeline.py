import json
import pytest
from unittest.mock import MagicMock
from openai import RateLimitError, APIStatusError

from app.schemas import Bubble, ProviderEnum, TranslatePageRequest
from app.pipeline.sorter import sort_bubbles_rtl_ttb, calculate_reading_order_key
from app.pipeline.translator import (
    extract_json_payload,
    MangaTranslator,
    _is_transient_error,
    _backoff_delay,
    _user_friendly_error,
    RETRY_MAX_DELAY_S,
    RETRY_JITTER_S,
)


# ─── Helpers ──────────────────────────────────────────────────────────────────

def make_bubble(order, ymin, xmin, ymax, xmax, orig="text", trans="text") -> Bubble:
    return Bubble(order=order, box_2d=[ymin, xmin, ymax, xmax],
                  original_text=orig, translated_text=trans)


def _make_rate_limit_error() -> RateLimitError:
    response = MagicMock()
    response.status_code = 429
    response.headers = {}
    response.json.return_value = {"error": {"message": "Rate limit exceeded"}}
    return RateLimitError("Rate limit exceeded", response=response, body=None)


def _make_status_error(code: int) -> APIStatusError:
    response = MagicMock()
    response.status_code = code
    response.headers = {}
    response.json.return_value = {}
    return APIStatusError(f"HTTP {code}", response=response, body=None)


# ─── Schema / coordinate clamping ─────────────────────────────────────────────

def test_bubble_valid_box():
    b = Bubble(order=1, box_2d=[100, 200, 300, 400], original_text="日", translated_text="Day")
    assert b.box_2d == [100, 200, 300, 400]


def test_bubble_clamp_below_zero():
    b = Bubble(order=1, box_2d=[-100, -50, 200, 300], original_text="A", translated_text="A")
    assert b.box_2d[0] == 0   # ymin clamped
    assert b.box_2d[1] == 0   # xmin clamped
    assert b.box_2d[2] == 200
    assert b.box_2d[3] == 300


def test_bubble_clamp_above_1000():
    b = Bubble(order=1, box_2d=[800, 700, 1500, 1200], original_text="B", translated_text="B")
    assert b.box_2d[2] == 1000  # ymax clamped
    assert b.box_2d[3] == 1000  # xmax clamped


def test_bubble_clamp_all_extremes():
    b = Bubble(order=1, box_2d=[-999, -999, 9999, 9999], original_text="X", translated_text="X")
    assert b.box_2d == [0, 0, 1000, 1000]


def test_bubble_inverted_coords_swapped():
    # ymin > ymax and xmin > xmax should be auto-corrected
    b = Bubble(order=1, box_2d=[700, 800, 100, 200], original_text="逆", translated_text="Reversed")
    ymin, xmin, ymax, xmax = b.box_2d
    assert ymin <= ymax
    assert xmin <= xmax


# ─── RTL/TTB sorting — simple two-column layout ───────────────────────────────

def test_rtl_ttb_basic_four_bubbles():
    # Right column (x≈800), left column (x≈150)
    b_right_top    = make_bubble(99, 50,  750, 150, 850, orig="右上", trans="RT")
    b_right_bottom = make_bubble(99, 600, 750, 700, 850, orig="右下", trans="RB")
    b_left_top     = make_bubble(99, 100, 150, 200, 250, orig="左上", trans="LT")
    b_left_bottom  = make_bubble(99, 700, 150, 800, 250, orig="左下", trans="LB")

    result = sort_bubbles_rtl_ttb([b_left_bottom, b_right_bottom, b_left_top, b_right_top])

    assert [b.original_text for b in result] == ["右上", "右下", "左上", "左下"]
    assert [b.order for b in result] == [1, 2, 3, 4]


def test_rtl_ttb_three_column_layout():
    # Three columns: right (x≈850), centre (x≈500), left (x≈150)
    # Reading order: right-col top→bottom, then centre top→bottom, then left top→bottom
    bubbles = [
        make_bubble(99,  50, 820, 180, 950, orig="R1"),
        make_bubble(99, 200, 820, 330, 950, orig="R2"),
        make_bubble(99,  50, 450, 180, 580, orig="C1"),
        make_bubble(99, 200, 450, 330, 580, orig="C2"),
        make_bubble(99,  50,  80, 180, 220, orig="L1"),
        make_bubble(99, 200,  80, 330, 220, orig="L2"),
    ]
    result = sort_bubbles_rtl_ttb(bubbles)
    # Right column first, then centre, then left; within each column top→bottom
    origs = [b.original_text for b in result]
    assert origs.index("R1") < origs.index("R2")  # right-col ordered top→bottom
    assert origs.index("C1") < origs.index("C2")  # centre-col ordered top→bottom
    assert origs.index("L1") < origs.index("L2")  # left-col ordered top→bottom
    # Right column appears before left column
    assert origs.index("R1") < origs.index("L1")
    assert origs.index("R2") < origs.index("L2")


def test_rtl_ttb_single_bubble():
    b = make_bubble(5, 100, 200, 300, 400, orig="一人", trans="Alone")
    result = sort_bubbles_rtl_ttb([b])
    assert len(result) == 1
    assert result[0].order == 1


def test_rtl_ttb_empty_list():
    assert sort_bubbles_rtl_ttb([]) == []


def test_rtl_ttb_reindexes_order():
    # Even if input orders are arbitrary, output must be 1..N
    bubbles = [
        make_bubble(42, 500, 100, 600, 300, orig="A"),
        make_bubble(7,  100, 700, 200, 900, orig="B"),
    ]
    result = sort_bubbles_rtl_ttb(bubbles)
    assert result[0].order == 1
    assert result[1].order == 2


# ─── Glossary merging ─────────────────────────────────────────────────────────

def test_glossary_merge_preserves_existing_keys():
    """New keys from LLM must be added; pre-existing keys must NOT be overwritten."""
    existing = {"Naruto": "Naruto Uzumaki", "Sasuke": "Sasuke Uchiha"}
    llm_returned = {"Sakura": "Sakura Haruno", "Sasuke": "OVERWRITE_ATTEMPT"}

    merged = dict(existing)
    # Simulate the merge logic from translator.py (existing keys win)
    for k, v in llm_returned.items():
        merged.setdefault(k, v)   # setdefault keeps existing value

    assert merged["Sasuke"] == "Sasuke Uchiha"   # original preserved
    assert merged["Sakura"] == "Sakura Haruno"   # new key added
    assert merged["Naruto"] == "Naruto Uzumaki"  # untouched


def test_glossary_merge_accumulates_across_pages():
    """Simulates calling translate_page on three consecutive pages."""
    glossary = {}

    page_responses = [
        {"Luffy": "Monkey D. Luffy"},
        {"Zoro": "Roronoa Zoro", "Luffy": "ignore"},
        {"Nami": "Nami", "Zoro": "ignore"},
    ]

    for llm_glossary in page_responses:
        for k, v in llm_glossary.items():
            glossary.setdefault(k, v)

    assert glossary["Luffy"] == "Monkey D. Luffy"
    assert glossary["Zoro"]  == "Roronoa Zoro"
    assert glossary["Nami"]  == "Nami"
    assert len(glossary) == 3


# ─── JSON payload extraction ──────────────────────────────────────────────────

def test_extract_json_payload_markdown_fence():
    raw = '```json\n{"bubbles": [], "updated_glossary": {"X": "Y"}}\n```'
    parsed = extract_json_payload(raw)
    assert parsed["updated_glossary"]["X"] == "Y"


def test_extract_json_payload_bare():
    raw = '{"bubbles": [], "updated_glossary": {}}'
    assert extract_json_payload(raw)["bubbles"] == []


def test_extract_json_payload_preamble():
    raw = 'Sure! {"bubbles": [{"order":1,"box_2d":[0,0,100,100],"original_text":"A","translated_text":"B"}], "updated_glossary": {}}'
    parsed = extract_json_payload(raw)
    assert parsed["bubbles"][0]["translated_text"] == "B"


def test_extract_json_payload_invalid_raises():
    with pytest.raises(Exception):
        extract_json_payload("this is not json at all")


# ─── Provider resolution ──────────────────────────────────────────────────────

def test_provider_gemini_defaults():
    url, model, key = MangaTranslator.resolve_provider_config(ProviderEnum.GEMINI, api_key="k")
    assert "googleapis" in url
    assert model == "gemini-2.0-flash"


def test_provider_openrouter_defaults():
    url, model, _ = MangaTranslator.resolve_provider_config(ProviderEnum.OPENROUTER, api_key="k")
    assert "openrouter.ai" in url
    assert model == "openrouter/free"


def test_provider_ollama_no_key_required():
    url, model, key = MangaTranslator.resolve_provider_config(ProviderEnum.OLLAMA, api_key=None)
    assert "11434" in url
    assert key == "ollama"


def test_provider_custom_model_override():
    _, model, _ = MangaTranslator.resolve_provider_config(
        ProviderEnum.GEMINI, custom_model="gemini-2.5-pro", api_key="k"
    )
    assert model == "gemini-2.5-pro"


def test_provider_missing_api_key_raises_http_400():
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as exc_info:
        MangaTranslator.resolve_provider_config(ProviderEnum.GEMINI, api_key=None)
    assert exc_info.value.status_code == 400


# ─── Retry / transient-error helpers ─────────────────────────────────────────

def test_is_transient_rate_limit():
    assert _is_transient_error(_make_rate_limit_error()) is True


def test_is_transient_503():
    assert _is_transient_error(_make_status_error(503)) is True


def test_is_transient_502():
    assert _is_transient_error(_make_status_error(502)) is True


def test_is_not_transient_401():
    assert _is_transient_error(_make_status_error(401)) is False


def test_is_not_transient_400():
    assert _is_transient_error(_make_status_error(400)) is False


def test_is_transient_string_keywords():
    assert _is_transient_error(Exception("429 too many requests")) is True
    assert _is_transient_error(Exception("Service Unavailable 503")) is True
    assert _is_transient_error(Exception("quota exceeded")) is True
    assert _is_transient_error(Exception("overloaded server")) is True
    assert _is_transient_error(Exception("unauthorized 401")) is False


def test_backoff_delay_grows_with_attempt():
    d = [_backoff_delay(a) for a in range(5)]
    for i in range(1, 5):
        assert d[i] > d[i - 1], f"delay[{i}]={d[i]} should exceed delay[{i-1}]={d[i-1]}"


def test_backoff_delay_capped():
    for attempt in range(10, 20):
        assert _backoff_delay(attempt) <= RETRY_MAX_DELAY_S + RETRY_JITTER_S


def test_user_friendly_rate_limit_message():
    msg = _user_friendly_error(_make_rate_limit_error(), "gemini", "gemini-2.0-flash")
    assert "rate limit" in msg.lower() or "quota" in msg.lower()
    assert "gemini" in msg.lower()


def test_user_friendly_503_message():
    msg = _user_friendly_error(_make_status_error(503), "openrouter", "openrouter/free")
    assert "503" in msg or "unavailable" in msg.lower()
