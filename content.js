let isProcessing = false;

// Auto-run on load
chrome.storage.local.get(['geminiApiKey', 'apiMode', 'projectId', 'location', 'modelId', 'targetLang', 'density', 'engineEnabled'], (result) => {
    const mode = result.apiMode || 'aistudio';
    const hasAuth = (mode === 'aistudio' && result.geminiApiKey) || (mode === 'vertex' && result.projectId);
    const isEnabled = result.engineEnabled !== false;

    if (hasAuth && isEnabled && !isProcessing) {
        initLiveTeacher({
            apiKey: result.geminiApiKey,
            apiMode: mode,
            projectId: result.projectId,
            location: result.location,
            modelId: result.modelId || 'gemini-2.5-flash-preview-09-2025',
            targetLang: result.targetLang || 'Japanese',
            density: result.density || 20
        });
    }
});

// Listen for messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "startEngine") {
        console.log("LingoGhost: Starting engine...");
        chrome.storage.local.get(['geminiApiKey', 'apiMode', 'projectId', 'location', 'modelId', 'targetLang', 'density'], (result) => {
            initLiveTeacher({
                apiKey: result.geminiApiKey,
                apiMode: result.apiMode || 'aistudio',
                projectId: result.projectId,
                location: result.location,
                modelId: result.modelId || 'gemini-2.5-flash-preview-09-2025',
                targetLang: result.targetLang || 'Japanese',
                density: result.density || 20
            });
        });
    } else if (request.action === "stopEngine") {
        console.log("LingoGhost: Stopping engine...");
        stopLiveTeacher();
    }
});

// Live Teacher State
let lastScrollY = 0;
let isRequestPending = false;
let lastRequestTime = 0;
let processedNodes = new Set();
let observer = null;
let observerTimeout = null;

function initLiveTeacher(config) {
    console.log("LingoGhost: Live Teacher is awake 👨‍🏫 (Dynamic Mode)");

    // 1. Instant check
    processViewport(config);

    // 2. Watch for dynamic content
    if (observer) observer.disconnect();

    observer = new MutationObserver((mutations) => {
        // Debounce: Reduced to 700ms from 2000ms for faster reaction
        if (observerTimeout) clearTimeout(observerTimeout);

        observerTimeout = setTimeout(() => {
            console.log("LingoGhost: DOM changed significantly, checking...");
            processViewport(config);
        }, 700);
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true
    });

    // 3. Watch for scroll movement
    if (window.lingoScrollInterval) clearInterval(window.lingoScrollInterval);
    window.lingoScrollInterval = setInterval(() => {
        checkScroll(config);
    }, 6000);
}

function stopLiveTeacher() {
    console.log("LingoGhost: Engine stopped 💤");
    if (observer) {
        observer.disconnect();
        observer = null;
    }
    if (observerTimeout) {
        clearTimeout(observerTimeout);
        observerTimeout = null;
    }
    if (window.lingoScrollInterval) {
        clearInterval(window.lingoScrollInterval);
        window.lingoScrollInterval = null;
    }
}

function checkScroll(config) {
    if (isRequestPending) return;

    const currentScrollY = window.scrollY;
    // If moved more than 300px
    if (Math.abs(currentScrollY - lastScrollY) > 300) {
        lastScrollY = currentScrollY;
        processViewport(config);
    }
}

function processViewport(config) {
    if (isRequestPending) return;

    // Check cooling time
    const now = Date.now();
    if (now - lastRequestTime < 20000) {
        return;
    }

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
                // Skip already processed?
                if (node.parentElement.classList.contains('langswitch-text')) return NodeFilter.FILTER_REJECT;
                if (node.parentElement.closest('.lingo-quiz-popup')) return NodeFilter.FILTER_REJECT;

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
                if (node.textContent.trim().length < 5) return NodeFilter.FILTER_REJECT;

                return NodeFilter.FILTER_ACCEPT;
            }
        }
    );

    const textNodes = [];
    let combinedText = "";

    while (walker.nextNode()) {
        const node = walker.currentNode;
        if (processedNodes.has(node)) continue;

        textNodes.push(node);
        combinedText += node.textContent + " ";
        processedNodes.add(node);

        if (combinedText.length > 2000) break;
    }

    // Critical Fix: Only trigger cooldown if we actually found something
    if (combinedText.length < 20) {
        return;
    }

    // Now we commit to a request
    isRequestPending = true;
    lastRequestTime = now;

    // 2. Request Translation (Real API)
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
            console.log("LingoGhost 👻 AI returned these words:", response.data.replacements);
            applyReplacements(textNodes, response.data.replacements);
        } else {
            console.error("LingoGhost error:", response ? response.error : "Unknown error");
        }
    });
}

// Refactored applyReplacements with Frequency Cap
function applyReplacements(nodes, replacements) {
    if (!replacements || replacements.length === 0) return;

    // 1. Build a robust map containing full data
    const replacementMap = new Map();
    replacements.forEach(item => {
        replacementMap.set(item.original, item);
        const lower = item.original.toLowerCase();
        if (!replacementMap.has(lower)) {
            replacementMap.set(lower, item);
        }
    });

    // 2. Create Regex
    const sortedKeys = Array.from(replacementMap.keys()).sort((a, b) => b.length - a.length);
    if (sortedKeys.length === 0) return;

    const escapeRegExp = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patternString = sortedKeys.map(key => {
        const escaped = escapeRegExp(key);
        if (/^[a-zA-Z0-9_]+$/.test(key)) {
            return `\\b${escaped}\\b`;
        }
        return escaped;
    }).join('|');

    const regex = new RegExp(`(${patternString})`, 'g');

    // 3. Frequency Cap Map (Prevents spamming the same word)
    const usageCounts = new Map();
    const MAX_REPEATS = 3; // Allows max 3 replacements per word type per batch

    let count = 0;

    nodes.forEach(node => {
        const text = node.textContent;
        if (!regex.test(text)) return;
        regex.lastIndex = 0;
        const parts = text.split(regex);
        if (parts.length === 1) return;

        const container = document.createElement('span');
        container.className = 'langswitch-text';

        parts.forEach(part => {
            let matchData = replacementMap.get(part);
            if (!matchData) matchData = replacementMap.get(part.toLowerCase());

            // Check Frequency Cap
            let shouldReplace = false;
            if (matchData) {
                const currentUsage = usageCounts.get(matchData.original) || 0;
                if (currentUsage < MAX_REPEATS) {
                    shouldReplace = true;
                    // Increment count
                    usageCounts.set(matchData.original, currentUsage + 1);
                }
            }

            if (shouldReplace && matchData) {
                count++;
                const wordSpan = document.createElement('span');
                wordSpan.className = 'langswitch-word lingo-ghost';
                wordSpan.textContent = matchData.translated;

                wordSpan.dataset.original = matchData.original;
                wordSpan.dataset.alternatives = JSON.stringify(matchData.alternatives || []);

                container.appendChild(wordSpan);
            } else {
                container.appendChild(document.createTextNode(part));
            }
        });

        if (node.parentNode) {
            node.parentNode.replaceChild(container, node);
            processedNodes.add(container);
        }
    });

    console.log(`LingoGhost: Created ${count} quiz words.`);
}

// Global state for quiz
let currentPopup = null;
let activeWord = null;
let hideTimeout = null;
let userScore = 0;

// Load score
chrome.storage.local.get(['lingoGhostScore'], (result) => {
    userScore = result.lingoGhostScore || 0;
});

function updateScore(points) {
    userScore += points;
    chrome.storage.local.set({ lingoGhostScore: userScore });
}

// ---- HOVER LOGIC ----
document.addEventListener('mouseover', (e) => {
    const target = e.target;

    if (target.classList.contains('lingo-ghost')) {
        if (hideTimeout) {
            clearTimeout(hideTimeout);
            hideTimeout = null;
        }

        if (currentPopup && currentPopup.dataset.owner === target.textContent) {
            return;
        }

        showQuizPopup(target);
    }
    else if (currentPopup && (currentPopup.contains(target) || target.closest('.lingo-quiz-popup'))) {
        if (hideTimeout) {
            clearTimeout(hideTimeout);
            hideTimeout = null;
        }
    }
});

document.addEventListener('mouseout', (e) => {
    const target = e.target;

    if (target.classList.contains('lingo-ghost') || (currentPopup && currentPopup.contains(target))) {
        hideTimeout = setTimeout(() => {
            if (currentPopup) {
                currentPopup.remove();
                currentPopup = null;
                activeWord = null;
            }
        }, 400);
    }
});


function showQuizPopup(targetElement) {
    if (currentPopup) currentPopup.remove();

    const translatedWord = targetElement.textContent;
    const correctOriginal = targetElement.dataset.original;

    if (!correctOriginal) return;

    const cleanCorrectTrans = translatedWord.trim();
    const allAlternatives = JSON.parse(targetElement.dataset.alternatives || '[]');

    let options = [cleanCorrectTrans];
    const distractors = allAlternatives.sort(() => Math.random() - 0.5).slice(0, 2);
    options = [...options, ...distractors];
    options = options.sort(() => Math.random() - 0.5);

    const popup = document.createElement('div');
    popup.className = 'lingo-quiz-popup';
    popup.dataset.owner = translatedWord;

    // Positioning
    const rectification = targetElement.getBoundingClientRect();
    const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
    const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;

    let top = rectification.bottom + scrollTop + 8;
    let left = rectification.left + scrollLeft;

    if (rectification.bottom + 200 > window.innerHeight) {
        top = rectification.top + scrollTop - 100; // Adjusted for smaller height
    }

    popup.style.top = `${top}px`;
    popup.style.left = `${left}px`;

    // Minimalist Horizontal UI
    popup.innerHTML = `
        <span class="lingo-origin-text">${correctOriginal}</span>
        ${options.map(opt => `
            <div class="lingo-opt-btn" data-val="${opt}">${opt}</div>
        `).join('')}
    `;

    popup.addEventListener('mouseover', () => {
        if (hideTimeout) {
            clearTimeout(hideTimeout);
            hideTimeout = null;
        }
    });

    document.body.appendChild(popup);
    currentPopup = popup;

    const btns = popup.querySelectorAll('.lingo-opt-btn');
    btns.forEach(btn => {
        btn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            const val = btn.dataset.val;
            const isCorrect = (val === cleanCorrectTrans);

            if (currentPopup) currentPopup.remove();
            currentPopup = null;
            activeWord = null;

            if (isCorrect) {
                targetElement.textContent = targetElement.dataset.original;
                targetElement.className = 'lingo-solved';
                targetElement.removeAttribute('title');

                updateScore(10);

                chrome.runtime.sendMessage({
                    action: "updateWordStats",
                    word: correctOriginal,
                    isCorrect: true
                });

            } else {
                showGhostAnimation(ev.clientX, ev.clientY);
                recordMistake(correctOriginal);
                updateScore(-5);

                chrome.runtime.sendMessage({
                    action: "updateWordStats",
                    word: correctOriginal,
                    isCorrect: false
                });
            }
        });
    });
}

function showGhostAnimation(x, y) {
    const ghost = document.createElement('div');
    ghost.className = 'ghost-anim-element';
    ghost.textContent = '👻';
    ghost.style.left = `${x}px`;
    ghost.style.top = `${y}px`;

    document.body.appendChild(ghost);

    setTimeout(() => {
        ghost.remove();
    }, 1500);
}

function recordMistake(word) {
    chrome.storage.local.get(['mistake_history'], (result) => {
        let history = result.mistake_history || {};

        if (history[word]) {
            history[word] += 1;
        } else {
            history[word] = 1;
        }

        chrome.storage.local.set({ mistake_history: history });
    });
}
