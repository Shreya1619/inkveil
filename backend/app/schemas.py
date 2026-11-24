from enum import Enum
from typing import Dict, List, Optional
from pydantic import BaseModel, Field, field_validator


class ProviderEnum(str, Enum):
    GEMINI = "gemini"
    OPENROUTER = "openrouter"
    OLLAMA = "ollama"


class Bubble(BaseModel):
    order: int = Field(..., description="1-based reading order index (Right-to-Left, Top-to-Bottom)")
    box_2d: List[int] = Field(
        ...,
        description="Bounding box [ymin, xmin, ymax, xmax] scaled 0-1000",
        min_length=4,
        max_length=4
    )
    original_text: str = Field(..., description="Original detected Japanese text")
    translated_text: str = Field(..., description="English contextual translation")

    @field_validator("box_2d")
    @classmethod
    def validate_box(cls, v: List[int]) -> List[int]:
        if len(v) != 4:
            raise ValueError("box_2d must have exactly 4 coordinates [ymin, xmin, ymax, xmax]")
        ymin, xmin, ymax, xmax = v
        # Clamp to 0-1000
        ymin = max(0, min(1000, int(ymin)))
        xmin = max(0, min(1000, int(xmin)))
        ymax = max(0, min(1000, int(ymax)))
        xmax = max(0, min(1000, int(xmax)))
        if ymax < ymin:
            ymin, ymax = ymax, ymin
        if xmax < xmin:
            xmin, xmax = xmax, xmin
        return [ymin, xmin, ymax, xmax]


class TranslatePageRequest(BaseModel):
    image_base64: str = Field(..., description="Base64-encoded manga page image")
    api_key: Optional[str] = Field(default=None, description="API Key for the selected provider (not required for Ollama)")
    provider: ProviderEnum = Field(
        default=ProviderEnum.GEMINI,
        description="LLM provider: gemini | openrouter | ollama"
    )
    model: Optional[str] = Field(
        default=None,
        description="Optional custom model override"
    )
    glossary: Dict[str, str] = Field(
        default_factory=dict,
        description="Persistent character names and term glossary"
    )


class TranslatePageResponse(BaseModel):
    bubbles: List[Bubble] = Field(default_factory=list, description="Ordered translated dialogue bubbles")
    updated_glossary: Dict[str, str] = Field(
        default_factory=dict,
        description="Updated persistent glossary with newly encountered terms"
    )
    model_used: str = Field(..., description="Identifier of the model used for translation")


class HealthResponse(BaseModel):
    status: str = Field(default="ok")
