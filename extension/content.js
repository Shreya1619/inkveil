(() => {
  // Prevent duplicate execution if injected multiple times
  if (window.__INKVEIL_INJECTED__ || window.__SMART_MANGA_TRANSLATOR_INJECTED__) {
    return;
  }
  window.__INKVEIL_INJECTED__ = true;
  window.__SMART_MANGA_TRANSLATOR_INJECTED__ = true;

  const GLOSSARY_SESSION_KEY = "inkveil_session_glossary";
  const BACKEND_URL = "http://localhost:8000/translate-page";

  // Minimum dimension threshold to exclude UI icons, avatars, thumbnails, ads
  const MIN_DIMENSION_PX = 250;

  // Active overlay font size (default 12px, synced with popup & storage)
  let currentFontSize = "12px";

  // Load persisted font size preference on initialization
  try {
    chrome.storage.local.get(["overlayFontSize"], (data) => {
      if (data && data.overlayFontSize) {
        currentFontSize = typeof data.overlayFontSize === "number"
          ? `${data.overlayFontSize}px`
          : data.overlayFontSize;
        applyFontSizeToAllOverlays(currentFontSize);
      }
    });

    // Listen for storage changes to keep font size in sync across tabs/popups
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.overlayFontSize) {
        applyFontSizeToAllOverlays(changes.overlayFontSize.newValue);
      }
    });
  } catch (e) {
    // Context might be unready
  }

  /**
   * Applies the chosen font size to all currently rendered overlay text spans.
   */
  function applyFontSizeToAllOverlays(fontSize) {
    if (!fontSize) return;
    currentFontSize = typeof fontSize === "number" ? `${fontSize}px` : fontSize;
    const textNodes = document.querySelectorAll(".manga-overlay-text");
    textNodes.forEach((node) => {
      node.style.fontSize = currentFontSize;
    });
  }

  /**
   * Compute an in-viewport intersection area score for a DOMRect.
   * Fully-visible elements score highest; elements off-screen score 0.
   * Elements partially visible (clipped by viewport edges) score their
   * intersecting area, favoring elements "closest to" the viewport.
   */
  function viewportIntersectionScore(rect) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const ix = Math.max(0, Math.min(rect.right, vw) - Math.max(rect.left, 0));
    const iy = Math.max(0, Math.min(rect.bottom, vh) - Math.max(rect.top, 0));
    return ix * iy; // 0 means entirely off-screen
  }

  /**
   * Compute a composite score for a candidate element.
   * Priority 1: intersection area with viewport (non-zero strongly preferred).
   * Priority 2: total rendered area (larger page images win over thumbnails).
   * Returns { element, elementType, score, viewportScore, totalArea }.
   */
  function scoreElement(el) {
    const rect = el.getBoundingClientRect();
    const renderedW = rect.width;
    const renderedH = rect.height;

    // Reject invisible or tiny elements
    if (renderedW < MIN_DIMENSION_PX && renderedH < MIN_DIMENSION_PX) {
      return null;
    }

    const viewportScore = viewportIntersectionScore(rect);
    const totalArea = renderedW * renderedH;

    // Natural pixel area for <img> elements (more reliable than rendered area)
    const naturalArea =
      el.tagName === "IMG"
        ? (el.naturalWidth || 0) * (el.naturalHeight || 0)
        : 0;

    // Composite score: heavily weight in-viewport area, break ties with total area
    // Multiply viewport intersection by a large factor so any on-screen element
    // beats any off-screen element regardless of native resolution.
    const score = viewportScore * 1e6 + Math.max(naturalArea, totalArea);

    return {
      element: el,
      elementType: el.tagName === "CANVAS" ? "canvas" : "img",
      score,
      viewportScore,
      totalArea,
    };
  }

  /**
   * Finds the best candidate manga element on the page.
   * Scans all visible <img> and <canvas> elements, scoring them by
   * viewport intersection area first, then by total rendered area.
   * Ignores off-screen thumbnails when a large in-viewport element exists.
   *
   * @returns {{ element: Element, elementType: "img"|"canvas" } | null}
   */
  function findMainMangaElement() {
    const candidates = Array.from(
      document.querySelectorAll("img, canvas")
    );

    let best = null;

    for (const el of candidates) {
      const result = scoreElement(el);
      if (!result) continue;

      // Skip elements that are hidden via CSS
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || parseFloat(style.opacity) === 0) {
        continue;
      }

      if (!best || result.score > best.score) {
        best = result;
      }
    }

    return best ? { element: best.element, elementType: best.elementType } : null;
  }

  /**
   * Checks if there is an adjacent/sibling visible <img> or <canvas> of similar size
   * (e.g. the other half of a two-page manga spread, with area >= 60% of primaryEl
   * and overlapping vertical bounds).
   *
   * @param {Element} primaryEl  The primary detected manga element.
   * @returns {{ element: Element, elementType: "img"|"canvas" } | null}
   */
  function findSpreadPartner(primaryEl) {
    const pRect = primaryEl.getBoundingClientRect();
    const pArea = pRect.width * pRect.height;
    if (pArea <= 0) return null;

    const candidates = Array.from(document.querySelectorAll("img, canvas"));
    let bestPartner = null;
    let bestScore = 0;

    for (const el of candidates) {
      if (el === primaryEl) continue;

      // Skip elements that are hidden via CSS
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || parseFloat(style.opacity) === 0) {
        continue;
      }

      const cRect = el.getBoundingClientRect();
      const cArea = cRect.width * cRect.height;
      if (cArea <= 0) continue;

      // Area ratio check: similar size, area >= 60% of primaryEl (and not disproportionately huge)
      const areaRatio = cArea / pArea;
      if (areaRatio < 0.6 || areaRatio > 1.7) {
        continue;
      }

      // Vertical bounds overlap check: spread panels sit horizontally side-by-side
      const vOverlap = Math.max(0, Math.min(pRect.bottom, cRect.bottom) - Math.max(pRect.top, cRect.top));
      const minH = Math.min(pRect.height, cRect.height);
      if (minH <= 0 || (vOverlap / minH) < 0.6) {
        continue;
      }

      // Horizontal adjacency check: one element is on the left, one on the right
      const hGap = Math.max(0, Math.max(pRect.left, cRect.left) - Math.min(pRect.right, cRect.right));
      const maxW = Math.max(pRect.width, cRect.width);
      if (hGap > maxW * 0.5) {
        // Gap too wide to be an adjacent spread panel
        continue;
      }

      // Score by vertical alignment and area similarity
      const vScore = vOverlap / minH;
      const sizeScore = Math.min(areaRatio, 1 / areaRatio);
      const score = vScore * 10 + sizeScore * 5 - (hGap / maxW);

      if (score > bestScore) {
        bestScore = score;
        bestPartner = {
          element: el,
          elementType: el.tagName === "CANVAS" ? "canvas" : "img",
        };
      }
    }

    return bestPartner;
  }

  /**
   * Decodes a base64 string into an HTMLImageElement for canvas drawing/stitching.
   */
  function loadImageFromBase64(b64) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = (e) => reject(new Error("Failed to decode image data for spread stitching"));
      img.src = "data:image/jpeg;base64," + b64;
    });
  }

  /**
   * Stitches two spread panels side-by-side onto a canvas:
   * [ Left Page | Right Page ]
   * In Japanese manga reading order (RTL), the Right Page is read first (order 1..K),
   * followed by the Left Page (order K+1..N).
   */
  async function stitchSpreadPanels(b64Left, b64Right) {
    const [imgLeft, imgRight] = await Promise.all([
      loadImageFromBase64(b64Left),
      loadImageFromBase64(b64Right),
    ]);

    const wLeft = imgLeft.naturalWidth || imgLeft.width;
    const hLeft = imgLeft.naturalHeight || imgLeft.height;
    const wRight = imgRight.naturalWidth || imgRight.width;
    const hRight = imgRight.naturalHeight || imgRight.height;

    const totalW = wLeft + wRight;
    const totalH = Math.max(hLeft, hRight);

    const stitchCanvas = document.createElement("canvas");
    stitchCanvas.width = totalW;
    stitchCanvas.height = totalH;
    const ctx = stitchCanvas.getContext("2d");

    // Clean background
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, totalW, totalH);

    // Left page drawn at x=0
    ctx.drawImage(imgLeft, 0, 0, wLeft, hLeft);
    // Right page drawn at x=wLeft
    ctx.drawImage(imgRight, wLeft, 0, wRight, hRight);

    const dataUrl = stitchCanvas.toDataURL("image/jpeg", 0.92);
    const stitchedB64 = dataUrl.split(",")[1];

    return {
      stitchedB64,
      wLeft,
      hLeft,
      wRight,
      hRight,
      totalW,
      totalH,
    };
  }

  /**
   * Extract base64 from a <canvas> element directly via toDataURL.
   * Returns the raw base64 string (no data URI prefix) on success.
   * Throws a SecurityError subtype if the canvas is cross-origin tainted
   * so the caller can detect and handle it specifically.
   */
  function canvasToBase64(canvas) {
    try {
      const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
      const b64 = dataUrl.split(",")[1];
      if (!b64) {
        throw new Error("canvas.toDataURL returned an empty result.");
      }
      return b64;
    } catch (err) {
      // Re-throw as a typed taint error so callers can branch on it
      if (err.name === "SecurityError" || (err.message && err.message.toLowerCase().includes("tainted"))) {
        const taintErr = new Error(
          "TAINTED_CANVAS: The manga canvas is cross-origin tainted. " +
          "(Original: " + err.message + ")"
        );
        taintErr.name = "TaintedCanvasError";
        throw taintErr;
      }
      throw new Error("Failed to extract canvas image data: " + err.message);
    }
  }

  /**
   * Ask the background service worker to capture the entire visible tab as JPEG,
   * then crop it to the bounding rect of `targetEl`, scaling by devicePixelRatio.
   *
   * @param {Element} targetEl  The <canvas> (or any element) to crop to.
   * @returns {Promise<string>} Raw base64 string of the cropped JPEG.
   */
  async function captureVisibleTabCropped(targetEl) {
    // 1. Request a full-tab screenshot from the background service worker
    const response = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: "CAPTURE_VISIBLE_TAB" }, resolve);
    });

    if (!response || !response.success) {
      throw new Error(
        "captureVisibleTab failed: " +
        (response && response.error ? response.error : "No response from background script.")
      );
    }

    const { dataUrl } = response;

    // 2. Decode the full-tab screenshot into an ImageBitmap
    const fullImg = await createImageBitmap(
      await (await fetch(dataUrl)).blob()
    );

    // 3. Crop to the element's bounding rect, corrected for devicePixelRatio
    const dpr = window.devicePixelRatio || 1;
    const rect = targetEl.getBoundingClientRect();

    const cropX = Math.round(rect.left * dpr);
    const cropY = Math.round(rect.top * dpr);
    const cropW = Math.round(rect.width * dpr);
    const cropH = Math.round(rect.height * dpr);

    // Guard against zero or out-of-bounds crop dimensions
    if (cropW <= 0 || cropH <= 0) {
      fullImg.close();
      throw new Error(
        "Element has zero visible area in the viewport — cannot crop screenshot."
      );
    }

    const offscreen = new OffscreenCanvas(cropW, cropH);
    const ctx = offscreen.getContext("2d");
    ctx.drawImage(fullImg, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
    fullImg.close();

    // 4. Encode as JPEG and return raw base64
    const blob = await offscreen.convertToBlob({ type: "image/jpeg", quality: 0.92 });
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result.split(",")[1]);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  /**
   * Safely convert an <img> element to a base64 string, handling CORS.
   * Method 1: Fetch as Blob (works when extension has host_permissions for the image origin).
   * Method 2: Temporary off-screen canvas fallback.
   */
  async function imageToBase64(img) {
    const src = img.currentSrc || img.src;
    if (!src) {
      throw new Error("Target manga image has no src attribute.");
    }

    // Method 1: Fetch as Blob
    try {
      const resp = await fetch(src, { mode: "cors" });
      if (resp.ok) {
        const blob = await resp.blob();
        return await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => {
            const b64 = reader.result.split(",")[1];
            resolve(b64);
          };
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
      }
    } catch (fetchErr) {
      console.warn("[InkVeil] Blob fetch failed, trying canvas fallback:", fetchErr);
    }

    // Method 2: Off-screen canvas draw
    return new Promise((resolve, reject) => {
      try {
        const canvas = document.createElement("canvas");
        const w = img.naturalWidth || img.clientWidth || 800;
        const h = img.naturalHeight || img.clientHeight || 1200;
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
        resolve(dataUrl.split(",")[1]);
      } catch (canvasErr) {
        reject(
          new Error(
            "CORS error: cannot read image pixel data via canvas. " +
            "The image server may need to send CORS headers. " +
            "(Original error: " + canvasErr.message + ")"
          )
        );
      }
    });
  }

  /**
   * Retrieves persistent session glossary.
   */
  function getSessionGlossary() {
    try {
      const saved = sessionStorage.getItem(GLOSSARY_SESSION_KEY) || sessionStorage.getItem("smart_manga_session_glossary");
      return saved ? JSON.parse(saved) : {};
    } catch (e) {
      return {};
    }
  }

  /**
   * Updates persistent session glossary.
   */
  function saveSessionGlossary(glossary) {
    try {
      sessionStorage.setItem(GLOSSARY_SESSION_KEY, JSON.stringify(glossary));
    } catch (e) {
      console.error("Failed to save glossary:", e);
    }
  }

  /**
   * Cleans up existing overlay layers for a given target element or the entire document.
   */
  function removeOverlays(el = null) {
    if (el) {
      if (el.__manga_overlay_layer__) {
        const layer = el.__manga_overlay_layer__;
        layer.__syncResizeListener__ &&
          window.removeEventListener("resize", layer.__syncResizeListener__);
        layer.__syncScrollListener__ &&
          window.removeEventListener("scroll", layer.__syncScrollListener__);
        layer.remove();
        el.__manga_overlay_layer__ = null;
      }
    } else {
      const layers = document.querySelectorAll(".smart-manga-overlay-layer");
      layers.forEach((layer) => {
        layer.__syncResizeListener__ &&
          window.removeEventListener("resize", layer.__syncResizeListener__);
        layer.__syncScrollListener__ &&
          window.removeEventListener("scroll", layer.__syncScrollListener__);
        layer.remove();
      });
      const elements = document.querySelectorAll("img, canvas");
      elements.forEach((elem) => {
        elem.__manga_overlay_layer__ = null;
      });
    }
  }

  /**
   * Helper to extract base64 from either an <img> or a <canvas> element.
   */
  async function extractElementBase64(el, type) {
    if (type === "canvas") {
      try {
        return canvasToBase64(el);
      } catch (err) {
        if (err.name === "TaintedCanvasError") {
          console.warn(
            "[InkVeil] Canvas is cross-origin tainted. " +
            "Falling back to captureVisibleTab screenshot crop..."
          );
          return await captureVisibleTabCropped(el);
        }
        throw err;
      }
    } else {
      return await imageToBase64(el);
    }
  }

  /**
   * Renders translated comic speech bubbles directly over the manga element (img or canvas).
   * The overlay div tracks the target element's exact bounding rect and updates on resize.
   */
  function renderOverlays(el, bubbles) {
    removeOverlays(el);

    const layer = document.createElement("div");
    layer.className = "smart-manga-overlay-layer";

    // Position overlay layer to exactly match the target element's bounding rect
    function syncLayerPosition() {
      const rect = el.getBoundingClientRect();
      layer.style.position = "absolute";
      layer.style.top = `${rect.top + window.scrollY}px`;
      layer.style.left = `${rect.left + window.scrollX}px`;
      layer.style.width = `${rect.width}px`;
      layer.style.height = `${rect.height}px`;
      layer.style.pointerEvents = "none";
      layer.style.zIndex = "999999";
    }

    syncLayerPosition();
    document.body.appendChild(layer);
    el.__manga_overlay_layer__ = layer;

    // Store listener refs so removeOverlays can clean them up properly
    layer.__syncResizeListener__ = syncLayerPosition;
    layer.__syncScrollListener__ = syncLayerPosition;

    // Track position on window resize AND scroll
    window.addEventListener("resize", syncLayerPosition);
    window.addEventListener("scroll", syncLayerPosition);

    // Render each bubble
    bubbles.forEach((bubble) => {
      const [ymin, xmin, ymax, xmax] = bubble.box_2d;
      const topPct = (ymin / 1000) * 100;
      const leftPct = (xmin / 1000) * 100;
      const widthPct = ((xmax - xmin) / 1000) * 100;
      const heightPct = ((ymax - ymin) / 1000) * 100;

      const bubbleEl = document.createElement("div");
      bubbleEl.className = "manga-overlay-box";
      bubbleEl.style.top = `${topPct}%`;
      bubbleEl.style.left = `${leftPct}%`;
      bubbleEl.style.width = `${widthPct}%`;
      bubbleEl.style.minWidth = `max(72px, ${widthPct}%)`;
      bubbleEl.style.minHeight = `max(28px, ${heightPct}%)`;
      bubbleEl.style.height = "auto";

      // ── Reading-order badge (top-right) ──────────────────────────────────
      const badge = document.createElement("span");
      badge.className = "manga-order-badge";
      badge.textContent = bubble.order;
      badge.title = `Bubble #${bubble.order}`;

      // ── Translated text ───────────────────────────────────────────────────
      const textSpan = document.createElement("span");
      textSpan.className = "manga-overlay-text";
      textSpan.textContent = bubble.translated_text;
      if (currentFontSize) {
        textSpan.style.fontSize = currentFontSize;
      }

      // ── Peek button (bottom-left eye icon) ───────────────────────────────
      // Hovering the Peek button — or holding Shift while hovering the box —
      // fades the box to 22% opacity so the original Japanese art is visible.
      // Clicking the Peek button pins/unpins this faded inspection state.
      const peekBtn = document.createElement("span");
      peekBtn.className = "manga-peek-btn";
      peekBtn.title = `Original: ${bubble.original_text}`;
      peekBtn.textContent = "👁";

      // Peek button: mouseenter/mouseleave toggle .manga-peek on the box
      peekBtn.addEventListener("mouseenter", () => {
        bubbleEl.classList.add("manga-peek");
      });
      peekBtn.addEventListener("mouseleave", () => {
        bubbleEl.classList.remove("manga-peek");
      });

      // Peek button click: toggle persistent .manga-peek-pinned class
      peekBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        bubbleEl.classList.toggle("manga-peek-pinned");
      });

      // Shift+hover on the box itself also triggers peek mode
      bubbleEl.addEventListener("mouseenter", (e) => {
        if (e.shiftKey) bubbleEl.classList.add("manga-peek");
      });
      bubbleEl.addEventListener("mousemove", (e) => {
        if (e.shiftKey) {
          bubbleEl.classList.add("manga-peek");
        } else {
          bubbleEl.classList.remove("manga-peek");
        }
      });
      bubbleEl.addEventListener("mouseleave", () => {
        // Only remove hover-driven peek; keep click-pinned state
        bubbleEl.classList.remove("manga-peek");
      });

      bubbleEl.appendChild(badge);
      bubbleEl.appendChild(textSpan);
      bubbleEl.appendChild(peekBtn);
      layer.appendChild(bubbleEl);
    });
  }

  /**
   * Main Translation Workflow.
   * Finds the primary <img> or <canvas> in the viewport, checks for an adjacent
   * two-page spread partner (sibling of similar size and overlapping vertical bounds),
   * stitches or processes in strict Japanese manga reading order (RTL/TTB), calls
   * the backend, and renders overlays cleanly on both spread panels.
   */
  async function handleTranslatePage() {
    const found = findMainMangaElement();
    if (!found) {
      throw new Error(
        "No manga image or canvas detected on this page. " +
        "Please ensure a manga reader page is open and the image is visible."
      );
    }

    const { element: mainEl, elementType } = found;

    // Check for a two-page spread partner (adjacent canvas/img with area >= 60% and vertical overlap)
    const partner = findSpreadPartner(mainEl);

    let isSpread = false;
    let b64 = null;
    let spreadInfo = null;
    let leftItem = null;
    let rightItem = null;

    if (partner) {
      // Determine Left page vs Right page in the horizontal spread
      const mainRect = mainEl.getBoundingClientRect();
      const partRect = partner.element.getBoundingClientRect();

      if (mainRect.left < partRect.left) {
        leftItem = { element: mainEl, elementType };
        rightItem = { element: partner.element, elementType: partner.elementType };
      } else {
        leftItem = { element: partner.element, elementType: partner.elementType };
        rightItem = { element: mainEl, elementType };
      }

      try {
        console.log("[InkVeil] Two-page spread detected! Stitching left & right panels in RTL order...");
        // Scroll both into view
        rightItem.element.scrollIntoView({ behavior: "smooth", block: "nearest" });
        leftItem.element.scrollIntoView({ behavior: "smooth", block: "nearest" });

        const [b64Left, b64Right] = await Promise.all([
          extractElementBase64(leftItem.element, leftItem.elementType),
          extractElementBase64(rightItem.element, rightItem.elementType),
        ]);

        spreadInfo = await stitchSpreadPanels(b64Left, b64Right);
        b64 = spreadInfo.stitchedB64;
        isSpread = true;
      } catch (stitchErr) {
        console.warn("[InkVeil] Spread stitching failed, falling back to single panel:", stitchErr);
        isSpread = false;
        spreadInfo = null;
      }
    }

    if (!isSpread) {
      mainEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
      b64 = await extractElementBase64(mainEl, elementType);
    }

    // Load user configuration from extension local storage
    const settings = await new Promise((resolve) => {
      chrome.storage.local.get(["provider", "apiKey", "model", "overlayFontSize"], resolve);
    });

    if (settings && settings.overlayFontSize) {
      currentFontSize = typeof settings.overlayFontSize === "number"
        ? `${settings.overlayFontSize}px`
        : settings.overlayFontSize;
    }

    const provider = settings.provider || "gemini";
    const apiKey = settings.apiKey || "";
    const model = settings.model || null;
    const currentGlossary = getSessionGlossary();

    const payload = {
      image_base64: b64,
      provider: provider,
      api_key: apiKey,
      model: model,
      glossary: currentGlossary,
    };

    // Call local backend endpoint
    const response = await fetch(BACKEND_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      let errorMsg = `Server error ${response.status}`;
      try {
        const errorJson = await response.json();
        if (errorJson.detail) {
          errorMsg = errorJson.detail;
        }
      } catch (e) {
        // fallback
      }
      throw new Error(errorMsg);
    }

    const data = await response.json();

    // Persist updated glossary
    if (data.updated_glossary) {
      saveSessionGlossary(data.updated_glossary);
    }

    // Clean up previous overlays
    removeOverlays();

    if (isSpread && spreadInfo && leftItem && rightItem) {
      // Map bubbles between Right panel (Page 1 in Japanese manga) and Left panel (Page 2)
      const { wLeft, totalW, totalH, hLeft, hRight } = spreadInfo;
      const splitFraction = wLeft / totalW;
      const splitX = splitFraction * 1000;

      const rightBubbles = [];
      const leftBubbles = [];

      for (const bubble of (data.bubbles || [])) {
        const [ymin, xmin, ymax, xmax] = bubble.box_2d;
        const centerX = (xmin + xmax) / 2;

        if (centerX >= splitX) {
          // Right page panel
          const rxMin = Math.max(0, Math.min(1000, Math.round(((xmin - splitX) / (1000 - splitX)) * 1000)));
          const rxMax = Math.max(0, Math.min(1000, Math.round(((xmax - splitX) / (1000 - splitX)) * 1000)));
          const ryMin = Math.max(0, Math.min(1000, Math.round((ymin * totalH) / hRight)));
          const ryMax = Math.max(0, Math.min(1000, Math.round((ymax * totalH) / hRight)));

          rightBubbles.push({
            ...bubble,
            box_2d: [ryMin, rxMin, ryMax, rxMax],
          });
        } else {
          // Left page panel
          const lxMin = Math.max(0, Math.min(1000, Math.round((xmin / splitX) * 1000)));
          const lxMax = Math.max(0, Math.min(1000, Math.round((xmax / splitX) * 1000)));
          const lyMin = Math.max(0, Math.min(1000, Math.round((ymin * totalH) / hLeft)));
          const lyMax = Math.max(0, Math.min(1000, Math.round((ymax * totalH) / hLeft)));

          leftBubbles.push({
            ...bubble,
            box_2d: [lyMin, lxMin, lyMax, lxMax],
          });
        }
      }

      renderOverlays(rightItem.element, rightBubbles);
      renderOverlays(leftItem.element, leftBubbles);

      return {
        success: true,
        bubbleCount: (data.bubbles || []).length,
        modelUsed: data.model_used,
        isSpread: true,
        elementType: `${rightItem.elementType}+${leftItem.elementType} (spread)`,
      };
    } else {
      // Single panel render
      renderOverlays(mainEl, data.bubbles || []);

      return {
        success: true,
        bubbleCount: (data.bubbles || []).length,
        modelUsed: data.model_used,
        isSpread: false,
        elementType,
      };
    }
  }

  /**
   * Toggle visibility of all current overlay layers.
   * Decides direction from the FIRST layer's current state so all layers
   * move in sync even if they somehow drifted.
   * @returns {boolean} true  = overlays are now visible
   *                    false = overlays are now hidden
   */
  function toggleOverlays() {
    const layers = Array.from(document.querySelectorAll(".smart-manga-overlay-layer"));
    if (layers.length === 0) return false;

    // Determine target state from the first layer
    const shouldHide = !layers[0].classList.contains("manga-overlays-hidden");

    layers.forEach((layer) => {
      if (shouldHide) {
        layer.classList.add("manga-overlays-hidden");
      } else {
        layer.classList.remove("manga-overlays-hidden");
      }
    });

    // visible = NOT hidden
    return !shouldHide;
  }

  // Listen for messages from popup
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "TRANSLATE_MAIN_PAGE") {
      handleTranslatePage()
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true; // Keep message channel open for async response
    }

    if (request.action === "TOGGLE_OVERLAYS") {
      const visible = toggleOverlays();
      sendResponse({ success: true, visible });
      return false;
    }

    if (request.action === "SET_FONT_SIZE") {
      applyFontSizeToAllOverlays(request.fontSize);
      sendResponse({ success: true, fontSize: currentFontSize });
      return false;
    }

    if (request.action === "RESET_GLOSSARY") {
      sessionStorage.removeItem(GLOSSARY_SESSION_KEY);
      sessionStorage.removeItem("smart_manga_session_glossary");
      sendResponse({ success: true });
      return false;
    }
  });

  console.log("InkVeil content script active.");
})();
