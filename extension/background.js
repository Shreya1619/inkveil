/**
 * Smart Manga Translator — Manifest V3 Service Worker
 *
 * Handles privileged operations that content scripts cannot perform directly:
 *   - Capturing the visible tab as a JPEG data URL (requires the "tabs" permission
 *     and can only be called from a background/service-worker context).
 */

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "CAPTURE_VISIBLE_TAB") {
    // sender.tab is set when the message originates from a content script
    const windowId = sender.tab ? sender.tab.windowId : chrome.windows.WINDOW_ID_CURRENT;

    chrome.tabs.captureVisibleTab(
      windowId,
      { format: "jpeg", quality: 92 },
      (dataUrl) => {
        if (chrome.runtime.lastError) {
          sendResponse({
            success: false,
            error: chrome.runtime.lastError.message || "captureVisibleTab failed",
          });
        } else {
          sendResponse({ success: true, dataUrl });
        }
      }
    );

    // Return true to keep the message channel open for the async callback
    return true;
  }
});
