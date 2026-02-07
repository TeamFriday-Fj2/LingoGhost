// Configuration: Single Source of Truth for Default Model
const DEFAULT_MODEL = 'gemini-2.5-flash-preview-09-2025';

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "translate") {
        console.log("LingoGhost Background: Received translate request", request);
        handleTranslation(request.text, request.targetLang, request.density, request)
            .then(response => {
                console.log("LingoGhost Background: Success", response);
                sendResponse({ success: true, data: response });
            })
            .catch(error => {
                console.error("LingoGhost Background: Failure", error);
                sendResponse({ success: false, error: error.message || error.toString() });
            });
        return true; // Keep message channel open for async response
    }

    if (request.action === "updateWordStats") {
        updateStats(request.word, request.isCorrect);
    }
});

// Simple stats tracking
function updateStats(word, isCorrect) {
    chrome.storage.local.get(['lingoGhostStats'], (result) => {
        const stats = result.lingoGhostStats || {};
        if (!stats[word]) {
            stats[word] = { success: 0, fails: 0, lastSeen: Date.now() };
        }

        if (isCorrect) stats[word].success++;
        else stats[word].fails++;

        stats[word].lastSeen = Date.now();
        chrome.storage.local.set({ lingoGhostStats: stats });
    });
}

function getFailedWords(stats) {
    if (!stats) return [];
    // Filter words where failed > success OR recently failed
    return Object.keys(stats).filter(word => {
        const s = stats[word];
        return (s.fails > s.success) || (s.fails > 0 && (Date.now() - s.lastSeen < 86400000)); // Prioritize recent fails
    }).slice(0, 10); // Limit to top 10 to avoid huge prompts
}


async function handleTranslation(text, targetLang, density, config) {
    const { apiMode, apiKey, projectId, location, modelId } = config;
    let apiUrl = '';
    let token = '';

    // Use the provided model, or fallback to the hardcoded default
    const currentModel = modelId || DEFAULT_MODEL;

    // NEW: Get failed words (Memory)
    let failedWords = [];
    try {
        const result = await new Promise(resolve => chrome.storage.local.get(['lingoGhostStats'], resolve));
        failedWords = getFailedWords(result.lingoGhostStats);
        console.log("LingoGhost Memory: Prioritizing words:", failedWords);
    } catch (e) {
        console.warn("Failed to load memory:", e);
    }


    console.log(`LingoGhost Background: Processing with Mode=${apiMode}, Model=${currentModel}`);

    // Choose API Mode
    if (apiMode === 'vertex') {
        if (!projectId || !location) {
            throw new Error("Missing Project ID or Location for Vertex AI.");
        }

        // Get OAuth Token
        try {
            token = await new Promise((resolve, reject) => {
                chrome.identity.getAuthToken({ interactive: true }, (authToken) => {
                    if (chrome.runtime.lastError) {
                        reject(new Error(chrome.runtime.lastError.message));
                    } else {
                        resolve(authToken);
                    }
                });
            });
            console.log("LingoGhost Background: OAuth Token acquired");
        } catch (e) {
            console.error("Auth Error:", e);
            throw new Error("OAuth2 Error. Ensure `oauth2` client_id in manifest.json is correct. " + e.message);
        }

        apiUrl = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${currentModel}:generateContent`;

    } else {
        // Default: AI Studio
        if (!apiKey) throw new Error("Missing API Key for Google AI Studio.");
        apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${currentModel}:generateContent?key=${apiKey}`;
    }

    // limit text length
    const truncatedText = text.substring(0, 5000);

    // Inject Memory into Prompt
    const priorityInstruction = failedWords.length > 0
        ? `7. CRITICAL: If the text contains any of these words (or their variations), YOU MUST select them for replacement:_ [${failedWords.join(', ')}]`
        : '';

    // Live Teacher Mode: frequent, small requests.
    // We only want 1 or 2 words per "lesson" to avoid overwhelming the user and saving tokens.
    const maxWords = 5;

    const prompt = `
    You are a language learning assistant.
    Goal: Select ${maxWords} distinct, interesting word(s) (nouns, adjectives, verbs) from the text and translate them into ${targetLang}.
    
    Rules:
    1. Select simple, common words suitable for learning.
    2. Provide the translation that fits the CONTEXT.
    3. Do NOT translate proper names or specialized technical terms.
    4. For each word, provide 2 DISTINCTIVE INCORRECT options (distractors) in the TRANSLATED LANGUAGE (${targetLang}).
       - e.g. If Original="Cat", Translated="Gato" (Spanish), Alternatives MUST be other Spanish words like ["Perro", "Pajaro"].
       - Do NOT provide English/Original Language distractors.
    5. Output MUST be valid JSON.
    6. Format: { "replacements": [ { "original": "word", "translated": "traducción", "alternatives": ["incorrect_in_target_lang1", "incorrect_in_target_lang2"] }, ... ] }
    ${priorityInstruction}
    8. Return ONLY the JSON object, no markdown formatting.
    
    Text to process:
    "${truncatedText}"
  `;

    const requestBody = {
        contents: [{
            parts: [{ text: prompt }]
        }],
        generationConfig: {
            responseMimeType: "application/json"
        }
    };

    const headers = { "Content-Type": "application/json" };
    if (token) {
        headers["Authorization"] = `Bearer ${token}`;
    }

    console.log(`LingoGhost Background: Fetching from ${apiUrl}`);

    try {
        const response = await fetch(apiUrl, {
            method: "POST",
            headers: headers,
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ error: { message: response.statusText } }));
            console.error("LingoGhost API Error Data:", errorData);
            throw new Error(`API Error (${response.status}): ${errorData.error?.message || JSON.stringify(errorData)}`);
        }

        const data = await response.json();

        const candidate = data.candidates && data.candidates[0];
        if (!candidate || !candidate.content || !candidate.content.parts) {
            console.error("Invalid response structure:", data);
            throw new Error("Invalid response structure from Gemini API");
        }

        let jsonString = candidate.content.parts[0].text;
        // Clean markdown
        jsonString = jsonString.replace(/```json\n?|\n?```/g, '').trim();

        const result = JSON.parse(jsonString);
        return result;

    } catch (error) {
        console.error("LingoGhost Logic Error:", error);
        throw error;
    }
}
