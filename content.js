let isProcessing = false;

// Listen for messages from popup (e.g. settings changed)
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "updateSettings") {
        // Re-run if settings changed? For now, we can just log it.
        console.log("Settings updated");
    }
});

// Auto-run on load if we have an API key
// Auto-run on load if we have an API key or Project ID (depending on mode)
chrome.storage.local.get(['geminiApiKey', 'apiMode', 'projectId', 'location', 'modelId', 'targetLang', 'density'], (result) => {
    const mode = result.apiMode || 'aistudio';
    const hasAuth = (mode === 'aistudio' && result.geminiApiKey) || (mode === 'vertex' && result.projectId);

    if (hasAuth && !isProcessing) {
        setTimeout(() => {
            initLiveTeacher({
                apiKey: result.geminiApiKey,
                apiMode: mode,
                projectId: result.projectId,
                location: result.location,
                modelId: 'gemini-2.5-flash-preview-09-2025',
                targetLang: result.targetLang || 'Japanese',
                density: result.density || 20
            });
        }, 3000); // Wait 3s for page to settle
    }
});

// Live Teacher State
let lastScrollY = 0;
let isRequestPending = false;
let lastRequestTime = 0; // Throttle timestamp
let processedNodes = new Set(); // Keep track of nodes we've already seemingly processed

function initLiveTeacher(config) {
    console.log("LingoGhost: Live Teacher is awake 👨‍🏫 (Throttled Mode)");

    // Initial lesson (scan top of page)
    processViewport(config);

    // Watch for movement
    setInterval(() => {
        checkScroll(config);
    }, 6000); // Check every 6s (was 3s)
}

function checkScroll(config) {
    if (isRequestPending) return;

    const currentScrollY = window.scrollY;
    // If moved more than 300px (approx 1 screen scroll)
    if (Math.abs(currentScrollY - lastScrollY) > 300) {
        console.log("LingoGhost: User moved significantly, checking for new lesson...");
        lastScrollY = currentScrollY;
        processViewport(config);
    }
}

function processViewport(config) {
    if (isRequestPending) return;

    // Throttle: Enforce 20s cooldown between requests
    const now = Date.now();
    if (now - lastRequestTime < 20000) {
        console.log("LingoGhost: Throttling request... waiting for cooldown.");
        return;
    }

    isRequestPending = true;
    lastRequestTime = now;

    // Collect Visible Text
    const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
        {
            acceptNode: (node) => {
                // Must have parent
                if (!node.parentElement) return NodeFilter.FILTER_REJECT;
                // Skip tags
                const tag = node.parentElement.tagName.toLowerCase();
                if (['script', 'style', 'noscript', 'textarea', 'input', 'code', 'pre'].includes(tag)) return NodeFilter.FILTER_REJECT;
                // Skip already processed? (Hard to track exact nodes after replacement, but try parent)
                if (node.parentElement.classList.contains('langswitch-text')) return NodeFilter.FILTER_REJECT;

                // Check Visibility
                const rect = node.parentElement.getBoundingClientRect();
                const inViewport = (
                    rect.top >= -100 &&
                    rect.left >= 0 &&
                    rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) + 100 &&
                    rect.right <= (window.innerWidth || document.documentElement.clientWidth)
                );

                if (!inViewport) return NodeFilter.FILTER_REJECT;

                // Length check
                if (node.textContent.trim().length < 20) return NodeFilter.FILTER_REJECT;

                return NodeFilter.FILTER_ACCEPT;
            }
        }
    );

    const textNodes = [];
    let combinedText = "";

    while (walker.nextNode()) {
        const node = walker.currentNode;
        // Double check not in set
        if (processedNodes.has(node)) continue;

        textNodes.push(node);
        combinedText += node.textContent + " ";
        processedNodes.add(node); // Mark as pending

        if (combinedText.length > 1500) break; // Small batch for "Lesson"
    }

    if (combinedText.length < 50) {
        isRequestPending = false;
        return; // Nothing new to teach here
    }

    // 2. Request Translation (Lesson)
    console.log("LingoGhost: Preparing lesson for this section...");
    chrome.runtime.sendMessage({
        action: "translate",
        text: combinedText,
        ...config
    }, (response) => {
        isRequestPending = false;

        if (chrome.runtime.lastError) {
            console.error("LingoGhost runtime error:", chrome.runtime.lastError);
            return;
        }

        if (response && response.success) {
            applyReplacements(textNodes, response.data.replacements);
        } else {
            console.error("LingoGhost error:", response ? response.error : "Unknown error");
        }
    });
}

function applyReplacements(nodes, replacements) {
    if (!replacements || replacements.length === 0) return;

    // Create a map for fast lookup
    // Note: This is case-sensitive for the MVP. Improving robustness is a future task.
    const replacementMap = new Map();
    replacements.forEach(item => {
        replacementMap.set(item.original, item.translated);
        // Add lowercase variant too if not present
        if (!replacementMap.has(item.original.toLowerCase())) {
            replacementMap.set(item.original.toLowerCase(), item.translated);
        }
    });

    let count = 0;

    nodes.forEach(node => {
        let text = node.textContent;
        let modified = false;

        // Split by spaces to find words (naive tokenization)
        // We use a regex to preserve punctuation attached to words
        const words = text.split(/(\s+)/);

        const newWords = words.map(word => {
            // Clean punctuation for lookup
            const cleanWord = word.replace(/^[^\w]+|[^\w]+$/g, '');
            const match = replacementMap.get(cleanWord);

            if (match) {
                count++;
                // Reconstruct word with punctuation
                // This is tricky: we just replace the core word.
                return word.replace(cleanWord, match);
            }
            return word;
        });

        if (count > 0) {
            // We can't insert HTML into a text node directly.
            // We have to replace the text node with a span if we want styling.
            // For MVP, let's just replace text content first.
            // node.textContent = newWords.join(''); 

            // BETTER: Replace with SPANs for styling
            const span = document.createElement('span');
            span.className = 'langswitch-text';

            words.forEach(word => {
                const cleanWord = word.replace(/^[^\w]+|[^\w]+$/g, '');
                const match = replacementMap.get(cleanWord);

                if (match) {
                    const translatedWord = word.replace(cleanWord, match);
                    const wordSpan = document.createElement('span');
                    wordSpan.className = 'langswitch-word';
                    wordSpan.textContent = translatedWord;
                    wordSpan.title = `${cleanWord} -> ${match}`; // Tooltip
                    span.appendChild(wordSpan);
                } else {
                    span.appendChild(document.createTextNode(word));
                }
            });

            if (node.parentNode) {
                node.parentNode.replaceChild(span, node);
            }
        }
    });

    console.log(`LingoGhost: Created ${count} quiz words.`);
}

// Global state for quiz
let currentPopup = null;
let userScore = 0;

// Load score on startup
chrome.storage.local.get(['lingoGhostScore'], (result) => {
    userScore = result.lingoGhostScore || 0;
});

function updateScore(points) {
    userScore += points;
    chrome.storage.local.set({ lingoGhostScore: userScore });
}

// Handle clicks on words to show quiz
document.addEventListener('click', (e) => {
    // 1. Close existing popup if clicking outside
    if (currentPopup && !currentPopup.contains(e.target) && !e.target.classList.contains('langswitch-word')) {
        currentPopup.remove();
        currentPopup = null;
    }

    // 2. Open quiz if clicking a word
    if (e.target.classList.contains('langswitch-word')) {
        // Prevent default double-click selection etc
        e.preventDefault();
        e.stopPropagation();

        const wordSpan = e.target;

        // If already solved, ignore or show different msg
        if (wordSpan.classList.contains('solved-correct')) return;

        showQuizPopup(wordSpan);
    }
});

function showQuizPopup(targetElement) {
    if (currentPopup) currentPopup.remove();

    const contextWord = targetElement.textContent;
    const correctAnswer = targetElement.dataset.original;

    if (!correctAnswer) {
        console.warn("LingoGhost: Missing original word data for quiz.");
        return;
    }

    // Clean up correct answer for comparison
    const cleanCorrect = correctAnswer.replace(/^[^\w]+|[^\w]+$/g, '');

    const alternatives = JSON.parse(targetElement.dataset.alternatives || '[]');

    // Prepare options (1 correct + 3 wrongs)
    let options = [cleanCorrect, ...alternatives];
    // Shuffle options
    options = options.sort(() => Math.random() - 0.5);

    // Build DOM
    const popup = document.createElement('div');
    popup.className = 'lingo-quiz-popup';
    popup.style.cssText = `
        position: absolute;
        z-index: 10000;
        background: white;
        border: 1px solid #ccc;
        box-shadow: 0 4px 15px rgba(0,0,0,0.2);
        border-radius: 8px;
        padding: 15px;
        width: 250px;
        font-family: sans-serif;
        font-size: 14px;
        color: #333;
    `;

    popup.innerHTML = `
        <div style="display:flex; justify-content:space-between; margin-bottom:10px; border-bottom:1px solid #eee; padding-bottom:5px;">
            <strong>LingoGhost 👻</strong>
            <span style="background:#e8f0fe; color:#1967d2; padding:2px 6px; border-radius:10px; font-size:11px;">Score: ${userScore}</span>
        </div>
        <div style="margin-bottom:10px;">
            What does <strong style="color:#d93025;">${contextWord}</strong> mean?
        </div>
        <div class="lingo-options" style="display:flex; flex-direction:column; gap:8px;">
            ${options.map(opt => `
                <button class="lingo-opt-btn" data-val="${opt}" style="
                    padding:8px; border:1px solid #ddd; background:#f8f9fa; border-radius:4px; cursor:pointer; text-align:left;
                ">${opt}</button>
            `).join('')}
        </div>
    `;

    // Position popup
    const rectification = targetElement.getBoundingClientRect();
    const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
    const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;

    popup.style.top = `${rectification.bottom + scrollTop + 10}px`;
    popup.style.left = `${rectification.left + scrollLeft}px`;

    document.body.appendChild(popup);
    currentPopup = popup;

    // Add click listeners to options
    const btns = popup.querySelectorAll('.lingo-opt-btn');
    btns.forEach(btn => {
        btn.addEventListener('click', () => {
            const val = btn.dataset.val;
            const isCorrect = (val === cleanCorrect);

            // 1. Visual Feedback immediately
            if (isCorrect) {
                btn.style.background = '#e6f4ea';
                btn.style.borderColor = '#1e8e3e';
                btn.style.color = '#137333';
                btn.innerText += ' ✅';
                updateScore(10);
            } else {
                btn.style.background = '#fce8e6';
                btn.style.borderColor = '#d93025';
                btn.style.color = '#c5221f';
                btn.innerText += ' ❌';
                // Highlight correct one too so they learn
                btns.forEach(b => {
                    if (b.dataset.val === cleanCorrect) {
                        b.style.background = '#e6f4ea';
                        b.style.borderColor = '#1e8e3e';
                    }
                });
                updateScore(-2); // Smaller penalty
            }

            // 2. Send stats to "Memory" (Background)
            chrome.runtime.sendMessage({
                action: "updateWordStats",
                word: cleanCorrect, // The English meaning
                isCorrect: isCorrect
            });

            // 3. Revert to original text after short delay
            setTimeout(() => {
                if (currentPopup) currentPopup.remove();
                currentPopup = null;

                // Revert text to original
                targetElement.textContent = targetElement.dataset.original;

                // Style to show it was interacted with
                targetElement.classList.add('lingo-revealed');
                targetElement.style.color = isCorrect ? '#137333' : '#c5221f'; // Green or Red text
                targetElement.style.textDecoration = 'none';
                targetElement.style.borderBottom = 'none';
                targetElement.style.backgroundColor = 'transparent';

                // Remove pointer events so they don't click again immediately
                targetElement.style.pointerEvents = 'none';
            }, 1200);
        });
    });
}
