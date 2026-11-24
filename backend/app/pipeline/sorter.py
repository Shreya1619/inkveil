from typing import List
from app.schemas import Bubble


def calculate_reading_order_key(box: List[int]) -> tuple:
    """
    Calculate a sorting key for Japanese Manga Reading Order:
    Primary: Right-to-Left (RTL) -> bubbles further to the right (larger x) come first.
    Secondary: Top-to-Bottom (TTB) -> bubbles higher up (smaller y) come first.

    We discretize the horizontal space into columns/zones or group by panel tiers.
    For general manga pages, dividing horizontal coordinates into columns (e.g. 2-3 panel columns)
    or evaluating (tier_y, -center_x) or (-column_x, center_y) gives the canonical manga flow.
    Canonical standard: Right column first (top to bottom), then Left column (top to bottom).
    """
    ymin, xmin, ymax, xmax = box
    center_x = (xmin + xmax) / 2.0
    center_y = (ymin + ymax) / 2.0

    # Discretize X into columns of ~333px width (Right column = 2, Middle = 1, Left = 0)
    # Right-to-left reading means higher column index comes first.
    col_index = int(center_x // 333)
    # Within each column, top to bottom: smaller center_y comes first.
    return (-col_index, center_y, -center_x)


def sort_bubbles_rtl_ttb(bubbles: List[Bubble]) -> List[Bubble]:
    """
    Sort a list of Bubble objects strictly in Japanese manga reading order (RTL, TTB)
    and re-assign sequential 1-based orders.
    """
    if not bubbles:
        return []

    # Sort using the manga reading order key
    sorted_bubbles = sorted(bubbles, key=lambda b: calculate_reading_order_key(b.box_2d))

    # Re-index order 1..N
    reordered: List[Bubble] = []
    for idx, bubble in enumerate(sorted_bubbles, start=1):
        reordered.append(
            Bubble(
                order=idx,
                box_2d=bubble.box_2d,
                original_text=bubble.original_text,
                translated_text=bubble.translated_text
            )
        )
    return reordered
