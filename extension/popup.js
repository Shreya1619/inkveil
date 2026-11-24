document.addEventListener("DOMContentLoaded", () => {
  const providerSelect = document.getElementById("provider-select");
  const apiKeyInput = document.getElementById("api-key-input");
  const apiKeyHelp = document.getElementById("api-key-help");
  const toggleKeyBtn = document.getElementById("toggle-key-btn");
  const modelInput = document.getElementById("model-input");
  const fontSizeSlider = document.getElementById("font-size-slider");
  const fontSizeVal = document.getElementById("font-size-val");
  const translateBtn = document.getElementById("translate-btn");
  const toggleOverlaysBtn = document.getElementById("toggle-overlays-btn");
  const clearGlossaryBtn = document.getElementById("clear-glossary-btn");
  const statusMsg = document.getElementById("status-msg");

  const DEFAULT_MODELS = {
    gemini: "gemini-3.8-flash",
    openrouter: "openrouter/free",
    ollama: "gemma4"
  };

  function setStatus(text, type = "normal") {
    statusMsg.textContent = text;
    statusMsg.className = type === "ok" ? "status-ok" : type === "err" ? "status-err" : "";
  }

  function updateProviderUI() {
    const provider = providerSelect.value;
    modelInput.placeholder = `Default: ${DEFAULT_MODELS[provider] || ""}`;
    if (provider === "ollama") {
      apiKeyHelp.textContent = "Local Ollama does not require an API key.";
      apiKeyInput.disabled = true;
      apiKeyInput.placeholder = "(Not needed for Ollama)";
    } else {
      apiKeyHelp.textContent = "Stored locally in chrome.storage.local";
      apiKeyInput.disabled = false;
      apiKeyInput.placeholder = "Paste your API key here";
    }
  }

  // Load saved configuration
  chrome.storage.local.get(["provider", "apiKey", "model", "overlayFontSize"], (data) => {
    if (data.provider) {
      providerSelect.value = data.provider;
    }
    if (data.apiKey) {
      apiKeyInput.value = data.apiKey;
    }
    if (data.model) {
      modelInput.value = data.model;
    }
    if (data.overlayFontSize) {
      const parsed = parseInt(data.overlayFontSize, 10);
      if (!isNaN(parsed)) {
        fontSizeSlider.value = parsed;
        fontSizeVal.textContent = `${parsed}px`;
      }
    } else {
      fontSizeSlider.value = 12;
      fontSizeVal.textContent = "12px";
    }
    updateProviderUI();
  });

  // Save settings when changed
  function saveSettings() {
    chrome.storage.local.set({
      provider: providerSelect.value,
      apiKey: apiKeyInput.value.trim(),
      model: modelInput.value.trim(),
      overlayFontSize: `${fontSizeSlider.value}px`
    }, () => {
      setStatus("Settings saved", "ok");
      setTimeout(() => {
        if (statusMsg.textContent === "Settings saved") {
          setStatus("Ready");
        }
      }, 1500);
    });
  }

  providerSelect.addEventListener("change", () => {
    updateProviderUI();
    saveSettings();
  });
  apiKeyInput.addEventListener("input", saveSettings);
  modelInput.addEventListener("input", saveSettings);

  // Live font size control: save & message active content script
  fontSizeSlider.addEventListener("input", () => {
    const val = `${fontSizeSlider.value}px`;
    fontSizeVal.textContent = val;
    saveSettings();
    sendMessageToContent({ action: "SET_FONT_SIZE", fontSize: val }).catch(() => {
      // Content script may not be loaded on active tab yet
    });
  });

  // Toggle API key visibility
  toggleKeyBtn.addEventListener("click", () => {
    if (apiKeyInput.type === "password") {
      apiKeyInput.type = "text";
      toggleKeyBtn.textContent = "Hide";
    } else {
      apiKeyInput.type = "password";
      toggleKeyBtn.textContent = "Show";
    }
  });

  async function getActiveTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0];
  }

  async function sendMessageToContent(message) {
    const tab = await getActiveTab();
    if (!tab || !tab.id) {
      throw new Error("No active tab found.");
    }

    try {
      return await chrome.tabs.sendMessage(tab.id, message);
    } catch (err) {
      // Content script might not be injected yet. Inject it dynamically and retry once.
      try {
        await chrome.scripting.insertCSS({
          target: { tabId: tab.id },
          files: ["styles.css"]
        });
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["content.js"]
        });
        return await chrome.tabs.sendMessage(tab.id, message);
      } catch (injectErr) {
        throw new Error("Cannot access active tab or inject script: " + injectErr.message);
      }
    }
  }

  // Handle Translate Button
  translateBtn.addEventListener("click", async () => {
    const provider = providerSelect.value;
    const apiKey = apiKeyInput.value.trim();
    if (provider !== "ollama" && !apiKey) {
      setStatus("Error: API Key is required for " + provider, "err");
      return;
    }

    translateBtn.disabled = true;
    setStatus("Processing page image...", "normal");

    try {
      const response = await sendMessageToContent({ action: "TRANSLATE_MAIN_PAGE" });
      if (response && response.success) {
        const spreadLabel = response.isSpread ? " (2-page spread)" : "";
        setStatus(`Translated ${response.bubbleCount} bubbles${spreadLabel} using ${response.modelUsed}!`, "ok");
      } else {
        setStatus(response?.error || "Translation failed", "err");
      }
    } catch (err) {
      setStatus(err.message, "err");
    } finally {
      translateBtn.disabled = false;
    }
  });

  // Handle Toggle Overlays Button
  toggleOverlaysBtn.addEventListener("click", async () => {
    try {
      const resp = await sendMessageToContent({ action: "TOGGLE_OVERLAYS" });
      if (resp && resp.visible !== undefined) {
        setStatus(resp.visible ? "Overlays visible" : "Overlays hidden", "ok");
      }
    } catch (err) {
      setStatus(err.message, "err");
    }
  });

  // Handle Clear Saved Names & Terms Button
  clearGlossaryBtn.addEventListener("click", async () => {
    try {
      await sendMessageToContent({ action: "RESET_GLOSSARY" });
      setStatus("Saved names & terms cleared for this session", "ok");
    } catch (err) {
      setStatus(err.message, "err");
    }
  });
});
