document.addEventListener('DOMContentLoaded', () => {
    const apiModeSelect = document.getElementById('apiMode');
    const apiKeyInput = document.getElementById('apiKey');
    const aiStudioConfig = document.getElementById('aiStudioConfig');
    const vertexConfig = document.getElementById('vertexConfig');
    const projectIdInput = document.getElementById('projectId');
    const locationSelect = document.getElementById('location');
    const modelIdInput = document.getElementById('modelId');

    const targetLangSelect = document.getElementById('targetLang');
    const densityInput = document.getElementById('density');
    const densityValue = document.getElementById('densityValue');
    const saveBtn = document.getElementById('saveBtn');
    const statusDiv = document.getElementById('status');
    const startBtn = document.getElementById('startBtn');
    const stopBtn = document.getElementById('stopBtn');
    const engineStatusDiv = document.getElementById('engineStatus');

    function updateEngineUI(isEnabled) {
        if (isEnabled) {
            engineStatusDiv.textContent = 'Status: RUNNING';
            startBtn.disabled = true;
            startBtn.style.opacity = '0.5';
            stopBtn.disabled = false;
            stopBtn.style.opacity = '1';
        } else {
            engineStatusDiv.textContent = 'Status: STOPPED';
            startBtn.disabled = false;
            startBtn.style.opacity = '1';
            stopBtn.disabled = true;
            stopBtn.style.opacity = '0.5';
        }
    }

    // Toggle Config Visibility
    apiModeSelect.addEventListener('change', () => {
        if (apiModeSelect.value === 'vertex') {
            aiStudioConfig.style.display = 'none';
            vertexConfig.style.display = 'block';
        } else {
            aiStudioConfig.style.display = 'block';
            vertexConfig.style.display = 'none';
        }
    });

    // Load saved settings
    chrome.storage.local.get(['geminiApiKey', 'apiMode', 'projectId', 'location', 'modelId', 'targetLang', 'density', 'engineEnabled'], (result) => {
        const isEnabled = result.engineEnabled !== false; // Default to true if not set
        updateEngineUI(isEnabled);

        if (result.geminiApiKey) apiKeyInput.value = result.geminiApiKey;
        if (result.apiMode) {
            apiModeSelect.value = result.apiMode;
            // Trigger change event to update UI
            apiModeSelect.dispatchEvent(new Event('change'));
        }
        if (result.projectId) projectIdInput.value = result.projectId;
        if (result.location) locationSelect.value = result.location;
        if (result.modelId) modelIdInput.value = result.modelId;

        if (result.targetLang) targetLangSelect.value = result.targetLang;
        if (result.density) {
            densityInput.value = result.density;
            densityValue.textContent = result.density;
        }
    });

    // Start/Stop Logic
    const toggleEngine = (enable) => {
        chrome.storage.local.set({ engineEnabled: enable }, () => {
            updateEngineUI(enable);
            // Notify content script
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                if (tabs[0]) {
                    chrome.tabs.sendMessage(tabs[0].id, {
                        action: enable ? "startEngine" : "stopEngine"
                    });
                }
            });
        });
    };

    startBtn.addEventListener('click', () => toggleEngine(true));
    stopBtn.addEventListener('click', () => toggleEngine(false));

    // Update density label on change
    densityInput.addEventListener('input', () => {
        densityValue.textContent = densityInput.value;
    });

    // Save settings
    saveBtn.addEventListener('click', () => {
        const geminiApiKey = apiKeyInput.value.trim();
        const apiMode = apiModeSelect.value;
        const projectId = projectIdInput.value.trim();
        const location = locationSelect.value;
        const modelId = modelIdInput.value.trim() || 'gemini-2.5-flash-preview-09-2025';

        const targetLang = targetLangSelect.value;
        const density = densityInput.value;

        if (apiMode === 'aistudio' && !geminiApiKey) {
            statusDiv.textContent = 'Please enter an API Key.';
            statusDiv.className = 'error';
            return;
        }

        if (apiMode === 'vertex' && !projectId) {
            statusDiv.textContent = 'Please enter Project ID.';
            statusDiv.className = 'error';
            return;
        }

        // Save settings to Chrome storage
        chrome.storage.local.set({
            geminiApiKey,
            apiMode,
            projectId,
            location,
            modelId,
            targetLang,
            density
        }, () => {
            statusDiv.textContent = 'Settings saved!';
            statusDiv.className = 'success';
            setTimeout(() => {
                statusDiv.textContent = '';
                statusDiv.className = '';
            }, 2000);
        });
    });
});
