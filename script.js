// ===== Configuration =====
// API is on the same domain (Vercel serverless function at /api/chat)
const BACKEND_URL = '';


// ===== DOM Elements =====
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');
const chatMessages = document.getElementById('chat-messages');
const fileInput = document.getElementById('file-input');
const attachBtn = document.getElementById('attach-btn');
const filePreviewArea = document.getElementById('file-preview-area');
const filePreview = document.getElementById('file-preview');
const dropZoneOverlay = document.getElementById('drop-zone-overlay');
const clearChatBtn = document.getElementById('clear-chat');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const chatSend = document.getElementById('chat-send');
const modeScreen = document.getElementById('mode-screen');
const modeIndicator = document.getElementById('mode-indicator');
const heroModeText = document.getElementById('hero-mode-text');
const switchModeBtn = document.getElementById('switch-mode');

// ===== Safe localStorage helpers =====
function safeGetItem(key, fallback) {
    try { const v = localStorage.getItem(key); return v !== null ? v : (fallback !== undefined ? fallback : null); } catch (e) { return fallback !== undefined ? fallback : null; }
}
function safeSetItem(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* storage unavailable */ }
}
function safeRemoveItem(key) {
    try { localStorage.removeItem(key); } catch (e) { /* storage unavailable */ }
}

// ===== State =====
let pendingFile = null;
let conversationHistory = [];
const MAX_HISTORY = 20;
let isProcessing = false;
let appMode = safeGetItem('app_mode', ''); // 'online' or 'offline'
let currentChatId = null; // current Firestore chat document ID

// ===== WebLLM State =====
let webllmEngine = null;
let isModelLoaded = false;
let isModelLoading = false;
let useWebLLM = false; // true if user chose to download model
const WEBLLM_MODEL_ID_DESKTOP = 'SmolLM2-1.7B-Instruct-q4f16_1-MLC';
const WEBLLM_MODEL_ID_MOBILE = 'SmolLM2-360M-Instruct-q4f16_1-MLC';

function getWebLLMModelId() {
    return isMobileDevice() ? WEBLLM_MODEL_ID_MOBILE : WEBLLM_MODEL_ID_DESKTOP;
}

function getModelDisplayInfo() {
    if (isMobileDevice()) {
        return { name: 'SmolLM2 360M Instruct', size: '~200 MB', detail: '~200 MB download · Cached forever · Runs locally via WebGPU' };
    }
    return { name: 'SmolLM2 1.7B Instruct', size: '~1 GB', detail: '~1 GB download · Cached forever · Runs locally via WebGPU' };
}

// ===== Device Detection =====
function isMobileDevice() {
    return ('ontouchstart' in window || navigator.maxTouchPoints > 0) && window.innerWidth <= 768;
}



// ===== Mode Management =====
function setMode(mode) {
    appMode = mode;
    safeSetItem('app_mode', mode);
    updateModeUI();
}

function updateModeUI() {
    if (appMode === 'online') {
        statusDot.className = 'status-dot online';
        statusText.textContent = 'Online AI (Gemini)';
        modeIndicator.textContent = '🌐 Online';
        modeIndicator.className = 'mode-indicator mode-online';
        heroModeText.textContent = 'Online Mode — Full AI Power';
    } else if (appMode === 'offline') {
        statusDot.className = 'status-dot offline';
        statusText.textContent = 'Offline — Local AI';
        modeIndicator.textContent = '📡 Offline';
        modeIndicator.className = 'mode-indicator mode-offline';
        heroModeText.textContent = 'Offline Mode — No Key Needed';
    }
}

function showModeScreen() {
    modeScreen.classList.remove('hidden');
    modeScreen.style.display = '';
}

function hideModeScreen() {
    modeScreen.classList.add('hidden');
    setTimeout(() => { modeScreen.style.display = 'none'; }, 500);
}

// ===== Initialize =====
document.addEventListener('DOMContentLoaded', () => {
    document.body.style.opacity = '0';
    document.body.style.transition = 'opacity 0.6s ease';
    requestAnimationFrame(() => { document.body.style.opacity = '1'; });

    // Migrate old single key
    const oldKey = safeGetItem('gemini_api_key', null);
    if (oldKey) {
        safeRemoveItem('gemini_api_key');
    }
    // Clean up old API key storage (keys now server-side)
    safeRemoveItem('gemini_api_keys');
    safeRemoveItem('groq_api_key');

    // Setup user profile from Firebase auth
    setupUserProfile();

    // Show mode screen if no mode selected, otherwise go straight to app
    if (!appMode) {
        showModeScreen();
    } else {
        modeScreen.style.display = 'none';
        updateModeUI();
        if (appMode === 'offline') {
            chatMessages.innerHTML = '';
            initOfflineWithWebLLM();
        }
        // Chat history loading is now handled inside setupUserProfile's auth observer
    }
});

// ===== User Profile Setup =====
function setupUserProfile() {
    if (typeof auth !== 'undefined') {
        auth.onAuthStateChanged((user) => {
            if (!user) return;
            const avatarEl = document.getElementById('user-avatar');
            const nameEl = document.getElementById('user-name');
            const signoutBtn = document.getElementById('signout-btn');

            if (avatarEl && user.photoURL) {
                // Add cache buster for Google profile photos to bypass stale 403s
                avatarEl.src = user.photoURL + "?sz=128&_t=" + Date.now();
            }
            if (nameEl) nameEl.textContent = user.displayName || user.email || 'User';
            if (signoutBtn) {
                // Use onclick to prevent duplicate listeners if auth state changes multiple times
                signoutBtn.onclick = () => window.signOutUser();
            }

            // Now that user is definitely loaded, fetch chat history
            if (appMode) {
                loadChatList();
            }
        });
    }
}

// ===== Chat History Sidebar =====
const sidebarToggle = document.getElementById('sidebar-toggle');
const chatSidebar = document.getElementById('chat-sidebar');
const newChatBtn = document.getElementById('new-chat-btn');
const sidebarCloseBtn = document.getElementById('sidebar-close-btn');

if (sidebarToggle && chatSidebar) {
    sidebarToggle.addEventListener('click', () => {
        chatSidebar.classList.toggle('open');
    });
}

if (sidebarCloseBtn && chatSidebar) {
    sidebarCloseBtn.addEventListener('click', () => {
        chatSidebar.classList.remove('open');
    });
}

if (newChatBtn) {
    newChatBtn.addEventListener('click', () => {
        startNewChat();
    });
}

function startNewChat() {
    currentChatId = null;
    conversationHistory = [];
    chatMessages.innerHTML = '';
    addBotMessage("Hey there! 👋 I'm your AI Assistant. Choose a mode from the welcome screen, then ask me anything!");
    // Auto-close sidebar on mobile
    if (window.innerWidth <= 768 && chatSidebar) {
        chatSidebar.classList.remove('open');
    }
}

async function loadChatList() {
    const user = window._currentUser || (typeof auth !== 'undefined' ? auth.currentUser : null);
    if (!user || typeof db === 'undefined') return;

    try {
        // Fetch all conversations for the user so NO legacy history is hidden
        const snapshot = await db.collection('users').doc(user.uid).collection('chats')
            .orderBy('updatedAt', 'desc').limit(30).get();

        const container = document.getElementById('sidebar-chats');
        if (!container) return;

        if (snapshot.empty) {
            container.innerHTML = '<div class="sidebar-empty">No conversations yet.<br>Start chatting!</div>';
            // Force a new chat to initialize properly if they have zero history
            if (!currentChatId) {
                startNewChat();
            }
            return;
        }

        container.innerHTML = '';
        snapshot.forEach(doc => {
            const data = doc.data();
            const el = document.createElement('div');
            el.className = 'sidebar-chat-item' + (doc.id === currentChatId ? ' active' : '');
            el.innerHTML = `
                <span class="sidebar-chat-title">${escapeHtml(data.title || 'Untitled Chat')}</span>
                <span class="sidebar-chat-time">${formatChatTime(data.updatedAt)}</span>
                <button class="sidebar-chat-delete" data-id="${doc.id}" title="Delete">×</button>
            `;
            el.addEventListener('click', (e) => {
                if (e.target.classList.contains('sidebar-chat-delete')) {
                    e.stopPropagation();
                    deleteChat(e.target.dataset.id);
                    return;
                }
                loadChat(doc.id);
                // Auto-close sidebar on mobile after selecting a chat
                if (window.innerWidth <= 768 && chatSidebar) {
                    chatSidebar.classList.remove('open');
                }
            });
            container.appendChild(el);
        });
    } catch (err) {
        console.error('Error loading chat list:', err);
    }
}

function formatChatTime(timestamp) {
    if (!timestamp) return '';
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    const now = new Date();
    const diff = now - date;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    if (diff < 604800000) return Math.floor(diff / 86400000) + 'd ago';
    return date.toLocaleDateString();
}

async function loadChat(chatId) {
    const user = window._currentUser || (typeof auth !== 'undefined' ? auth.currentUser : null);
    if (!user || typeof db === 'undefined') return;

    try {
        const doc = await db.collection('users').doc(user.uid).collection('chats').doc(chatId).get();
        if (!doc.exists) return;

        const data = doc.data();
        currentChatId = chatId;
        conversationHistory = data.messages || [];

        // Render messages safely, supporting both new and legacy formats
        chatMessages.innerHTML = '';
        conversationHistory.forEach(msg => {
            const text = msg.parts ? msg.parts.map(p => p.text).join('') : (msg.text || msg.content || '');
            if (msg.role === 'user') {
                addRawMessage(`<p>${escapeHtml(text)}</p>`, 'user');
            } else {
                addBotMessage(text);
            }
        });

        if (chatSidebar) chatSidebar.classList.remove('open');
        loadChatList(); // refresh to highlight active
    } catch (err) {
        console.error('Error loading chat:', err);
    }
}

async function saveChat(userText, fileMetadata) {
    const user = window._currentUser || (typeof auth !== 'undefined' ? auth.currentUser : null);
    if (!user || typeof db === 'undefined') return;

    try {
        const chatData = {
            title: conversationHistory.length <= 2 ?
                userText.substring(0, 60) + (userText.length > 60 ? '...' : '') :
                undefined, // keep existing title
            messages: conversationHistory.slice(-MAX_HISTORY),
            mode: appMode || 'online',
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        };

        // Attach file metadata if present
        if (fileMetadata) {
            if (!chatData.files) chatData.files = firebase.firestore.FieldValue.arrayUnion(fileMetadata);
            else chatData.files = firebase.firestore.FieldValue.arrayUnion(fileMetadata);
        }

        // Remove undefined fields
        Object.keys(chatData).forEach(k => chatData[k] === undefined && delete chatData[k]);

        if (currentChatId) {
            await db.collection('users').doc(user.uid).collection('chats').doc(currentChatId).update(chatData);
        } else {
            chatData.title = userText.substring(0, 60) + (userText.length > 60 ? '...' : '');
            chatData.createdAt = firebase.firestore.FieldValue.serverTimestamp();
            const docRef = await db.collection('users').doc(user.uid).collection('chats').add(chatData);
            currentChatId = docRef.id;
        }

        loadChatList();
    } catch (err) {
        console.error('Error saving chat:', err);
    }
}

async function deleteChat(chatId) {
    const user = window._currentUser || (typeof auth !== 'undefined' ? auth.currentUser : null);
    if (!user || typeof db === 'undefined') return;

    try {
        await db.collection('users').doc(user.uid).collection('chats').doc(chatId).delete();
        if (chatId === currentChatId) startNewChat();
        loadChatList();
    } catch (err) {
        console.error('Error deleting chat:', err);
    }
}

// ===== Mode Selection Events =====
document.getElementById('select-online').addEventListener('click', () => {
    hideModeScreen();
    setMode('online');
    addBotMessage("🌐 **Online Mode activated!** Full Gemini AI is ready. Ask me anything — I can answer any question, generate code, analyze images, and more! 🚀");
    // Only reload if not already viewing online chats to save a database hit
    if (!chatMessages.innerHTML.includes('Online Mode')) {
        loadChatList();
    }
});

document.getElementById('select-offline').addEventListener('click', () => {
    hideModeScreen();
    setMode('offline');
    chatMessages.innerHTML = '';
    initOfflineWithWebLLM();
    if (!chatMessages.innerHTML.includes('Offline Mode')) {
        loadChatList();
    }
});

// ===== WebLLM Initialization =====
async function checkWebGPU() {
    if (!navigator.gpu) return false;
    try {
        const adapter = await navigator.gpu.requestAdapter();
        return !!adapter;
    } catch { return false; }
}

async function initOfflineWithWebLLM() {
    const mobile = isMobileDevice();
    const hasWebGPU = await checkWebGPU();

    if (!hasWebGPU) {
        // No WebGPU — fall back to basic built-in AI (same message for PC and mobile)
        const platform = mobile ? '📱' : '📡';
        addBotMessage(`${platform} **Offline Mode activated!** No API key needed.\n\nYour browser doesn't support WebGPU, so I'm using the basic built-in AI.\n\n- 🔢 **Math & calculations** — try *"5 + 3"*\n- 📖 **Definitions** — try *"what is an API?"*\n- 💻 **Code snippets** — *"add two numbers in python"*\n- 📄 **File analysis** — upload a .txt, .csv, or .json file\n\n💡 *For full AI power, use Chrome/Edge with WebGPU support, or switch to **Online Mode**.*`);
        return;
    }

    if (isModelLoaded && webllmEngine) {
        addBotMessage(`🧠 **Offline Mode activated!** Full AI brain is loaded.\n\nI can answer **any question**, generate code, write essays, analyze text — just like Online Mode, but 100% offline! 🚀\n\nAsk me anything!`);
        useWebLLM = true;
        return;
    }

    // Wait for the WebLLM library to load (up to 15 seconds — it may come from SW cache)
    if (typeof window.webllm === 'undefined') {
        addBotMessage(`📡 **Offline Mode activated!** Loading AI engine...`);
        const loaded = await new Promise(resolve => {
            if (typeof window.webllm !== 'undefined') { resolve(true); return; }
            const timeout = setTimeout(() => resolve(false), 15000);
            window.addEventListener('webllm-ready', () => {
                clearTimeout(timeout);
                resolve(true);
            }, { once: true });
        });
        if (!loaded) {
            addBotMessage(`⚠️ **WebLLM library couldn't load.** Make sure you have internet connection for the first load.\n\nUsing basic built-in AI for now.\n\n💡 *Refresh the page with internet, then try Offline Mode again to download the AI model.*`);
            return;
        }
    }

    // Check if model was previously downloaded — trust localStorage flag,
    // with verification via Cache API / IndexedDB where possible
    const wasPreviouslyDownloaded = safeGetItem('webllm_model_cached', '') === 'true';

    if (wasPreviouslyDownloaded) {
        // Try to auto-load from cache — if cache was cleared, loadModelFromCache()
        // catch block will handle it and show the download modal
        await loadModelFromCache();
    } else if (safeGetItem('webllm_skipped', '') === 'true') {
        // User previously chose to skip — go straight to basic AI
        useWebLLM = false;
        addBotMessage(`📡 **Basic Offline Mode activated!** Using built-in AI.\n\nI can help with:\n\n- 🔢 **Math & calculations** — try *"5 + 3"* or *"15% of 200"*\n- 📖 **Definitions** — try *"what is an API?"*\n- 💻 **Code references** — try *"javascript code"* or *"python code"*\n- 📄 **File analysis** — upload a .txt, .csv, or .json file\n\n💡 *Want full AI power offline? Go to 🔄 Switch Mode → Offline to download the AI model.*`);
    } else {
        // First time — show download modal
        showModelDownloadModal();
    }
}

// Check if WebLLM model data exists in browser caches (IndexedDB or Cache API)
async function checkModelCached() {
    try {
        // WebLLM stores model weights in Cache API, check there first
        const cacheNames = await caches.keys();
        if (cacheNames.some(name => name.toLowerCase().includes('webllm') || name.toLowerCase().includes('mlc') || name.toLowerCase().includes('tvmjs'))) {
            return true;
        }
    } catch { /* Cache API not available or error */ }

    try {
        // Fallback: also check IndexedDB
        if (typeof indexedDB.databases === 'function') {
            const dbs = await indexedDB.databases();
            if (dbs.some(db => db.name && (db.name.toLowerCase().includes('webllm') || db.name.toLowerCase().includes('mlc') || db.name.toLowerCase().includes('tvmjs')))) {
                return true;
            }
        }
    } catch { /* indexedDB.databases() not available */ }

    // If we can't confirm via APIs but localStorage flag says yes, trust the flag
    // The loadModelFromCache() catch block handles the case where cache was actually cleared
    return safeGetItem('webllm_model_cached', '') === 'true';
}

// Auto-load a previously cached model (fast, no re-download)
async function loadModelFromCache() {
    const modelInfo = getModelDisplayInfo();
    addBotMessage(`⏳ **Loading AI brain from cache...** This should be quick!`);
    isModelLoading = true;
    try {
        const WebLLM = window.webllm || webllm;
        webllmEngine = await WebLLM.CreateMLCEngine(getWebLLMModelId(), {
            initProgressCallback: (progress) => {
                const pct = Math.round(progress.progress * 100);
                statusText.textContent = `Loading AI model... ${pct}%`;
            }
        });

        isModelLoaded = true;
        useWebLLM = true;
        isModelLoading = false;
        // Re-confirm the cached flag
        safeSetItem('webllm_model_cached', 'true');

        addBotMessage(`🧠 **AI Brain loaded from cache!** Ready in seconds — no download needed! 🚀\n\nI can answer **any question**, generate code, write essays, analyze text — just like Online Mode, but 100% offline!\n\nAsk me anything!`);
        updateModeUI();
    } catch (err) {
        console.error('WebLLM cache load error:', err);
        isModelLoading = false;
        // Cache might be cleared — remove flag and show download modal
        safeSetItem('webllm_model_cached', '');
        addBotMessage(`⚠️ **Cached model not found.** It may have been cleared by your browser.\n\nWould you like to download it again?`);
        showModelDownloadModal();
    }
}

function showModelDownloadModal() {
    const modelModal = document.getElementById('model-modal');
    if (!modelModal) return;

    // Dynamically update modal content based on device
    const info = getModelDisplayInfo();
    const nameEl = modelModal.querySelector('.model-info-name');
    const detailEl = modelModal.querySelector('.model-info-detail');
    const downloadBtn = document.getElementById('model-download-btn');
    if (nameEl) nameEl.textContent = info.name;
    if (detailEl) detailEl.textContent = info.detail;
    if (downloadBtn) downloadBtn.textContent = `⬇️ Download AI Model (${info.size})`;

    modelModal.classList.remove('hidden');
}

function hideModelModal() {
    const modelModal = document.getElementById('model-modal');
    if (modelModal) modelModal.classList.add('hidden');
}

// Model download button
const modelDownloadBtn = document.getElementById('model-download-btn');
if (modelDownloadBtn) {
    modelDownloadBtn.addEventListener('click', async () => {
        const progressContainer = document.getElementById('model-progress-container');
        const progressFill = document.getElementById('model-progress-fill');
        const modelStatus = document.getElementById('model-status');

        modelDownloadBtn.disabled = true;
        modelDownloadBtn.textContent = 'Downloading...';
        progressContainer.style.display = 'block';

        try {
            const WebLLM = window.webllm || webllm;
            webllmEngine = await WebLLM.CreateMLCEngine(getWebLLMModelId(), {
                initProgressCallback: (progress) => {
                    const pct = Math.round(progress.progress * 100);
                    progressFill.style.width = pct + '%';
                    if (progress.text) {
                        modelStatus.textContent = progress.text;
                    } else {
                        modelStatus.textContent = `Downloading... ${pct}%`;
                    }
                }
            });

            isModelLoaded = true;
            useWebLLM = true;
            isModelLoading = false;

            // Save flag so we know model is cached for next time
            safeSetItem('webllm_model_cached', 'true');

            progressFill.style.width = '100%';
            modelStatus.textContent = '✅ Model loaded! Ready to chat!';

            setTimeout(() => {
                hideModelModal();
                addBotMessage(`🧠 **AI Brain downloaded & ready!** \n\nI now work exactly like Online Mode — but 100% offline! I can:\n\n- 💬 Answer **any question** intelligently\n- 💻 **Generate & debug code** in any language\n- ✍️ **Write essays, emails, stories**\n- 📊 **Analyze & summarize** text\n- 🧮 **Math, science, reasoning**\n\nThis model is cached — next time you open the app, it loads instantly without internet! 🚀\n\nAsk me anything!`);
            }, 1000);

        } catch (err) {
            console.error('WebLLM load error:', err);
            progressFill.style.width = '0%';
            modelStatus.textContent = '❌ Failed: ' + (err.message || 'Unknown error');
            modelDownloadBtn.disabled = false;
            modelDownloadBtn.textContent = '⬇️ Retry Download';
        }
    });
}

// Skip model download button
const modelSkipBtn = document.getElementById('model-skip-btn');
if (modelSkipBtn) {
    modelSkipBtn.addEventListener('click', () => {
        hideModelModal();
        useWebLLM = false;
        safeSetItem('webllm_skipped', 'true');
        addBotMessage(`📡 **Basic Offline Mode activated!** No model downloaded.\n\nI can help with:\n\n- 🔢 **Math & calculations** — try *"5 + 3"* or *"15% of 200"*\n- 📖 **Definitions** — try *"what is an API?"*\n- 💻 **Code references** — try *"javascript code"* or *"python code"*\n- 📄 **File analysis** — upload a .txt, .csv, or .json file\n- 😄 **Jokes & quotes** — try *"tell me a joke"*\n\n💡 *For full AI power offline, go to 🔄 Switch Mode → Offline → Download AI Model.*`);
    });
}

// ===== WebLLM Chat Generation =====
async function callWebLLM(userText, file) {
    isProcessing = true;
    chatSend.disabled = true;
    statusText.textContent = 'Local AI thinking...';
    showTypingIndicator();

    try {
        const messages = [];
        messages.push({ role: 'system', content: 'You are a helpful, smart AI assistant. Provide clear, accurate, well-formatted answers. Use markdown for formatting. You are running locally in the browser via WebLLM.' });

        // Add conversation history
        conversationHistory.slice(-6).forEach(turn => {
            messages.push({
                role: turn.role === 'model' ? 'assistant' : 'user',
                content: turn.parts.map(p => p.text).join('')
            });
        });

        // Add file context if present
        let userContent = userText;
        if (file && file.isText) {
            userContent = `[File: ${file.name}]\n\n${file.data.substring(0, 30000)}\n\n---\n\n${userText}`;
        } else if (file && (file.isImage || file.isPdf)) {
            userContent = `[User attached a ${file.isImage ? 'image' : 'PDF'} file: ${file.name}. Note: This local model cannot process images/PDFs directly.]\n\n${userText}`;
        }
        messages.push({ role: 'user', content: userContent });

        const reply = await webllmEngine.chat.completions.create({
            messages,
            temperature: 0.7,
            max_tokens: 2048
        });

        removeTypingIndicator();
        const aiText = reply.choices[0]?.message?.content || "I couldn't generate a response. Please try again.";

        conversationHistory.push({ role: 'user', parts: [{ text: userText }] });
        conversationHistory.push({ role: 'model', parts: [{ text: aiText }] });
        if (conversationHistory.length > MAX_HISTORY) conversationHistory = conversationHistory.slice(-MAX_HISTORY);

        addBotMessage(aiText);
        updateModeUI();

    } catch (err) {
        console.error('WebLLM generation error:', err);
        removeTypingIndicator();
        addBotMessage(`❌ **Local AI error:** ${err.message || 'Unknown error'}. Try again or switch to basic offline mode.`);
    }

    isProcessing = false;
    chatSend.disabled = false;
}

// Switch mode button in nav
switchModeBtn.addEventListener('click', (e) => {
    e.preventDefault();
    showModeScreen();
});


// ===== Navbar Scroll Effect =====
const navbar = document.getElementById('navbar');
const navToggle = document.getElementById('nav-toggle');
const navLinks = document.getElementById('nav-links');

window.addEventListener('scroll', () => {
    if (navbar) navbar.classList.toggle('scrolled', window.scrollY > 50);
});

// ===== Mobile Nav Toggle =====
if (navToggle) {
    navToggle.addEventListener('click', () => {
        navToggle.classList.toggle('active');
        navLinks.classList.toggle('active');
    });
}

navLinks.querySelectorAll('a').forEach(link => {
    link.addEventListener('click', () => {
        navToggle.classList.remove('active');
        navLinks.classList.remove('active');
    });
});

// ===== Scroll-triggered Animations =====
const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            const delay = Array.from(entry.target.parentElement.children).indexOf(entry.target) * 100;
            setTimeout(() => entry.target.classList.add('visible'), delay);
            observer.unobserve(entry.target);
        }
    });
}, { threshold: 0.15, rootMargin: '0px 0px -50px 0px' });

document.querySelectorAll('[data-animate]').forEach(el => observer.observe(el));

// ===== Smooth Scroll =====
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
        if (this.id === 'change-api-key' || this.id === 'switch-mode') return;
        e.preventDefault();
        const target = document.querySelector(this.getAttribute('href'));
        if (target) target.scrollIntoView({ behavior: 'smooth' });
    });
});

// ===== File Handling =====
attachBtn.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
        handleFile(e.target.files[0]);
    }
});

const chatDemo = document.querySelector('.chat-demo');

chatDemo.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZoneOverlay.classList.add('active');
});

chatDemo.addEventListener('dragleave', (e) => {
    if (!chatDemo.contains(e.relatedTarget)) {
        dropZoneOverlay.classList.remove('active');
    }
});

chatDemo.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZoneOverlay.classList.remove('active');
    if (e.dataTransfer.files.length > 0) {
        handleFile(e.dataTransfer.files[0]);
    }
});

// ===== Save File Metadata to Firestore (FREE — no billing needed) =====
// Small files (<500KB) are saved with their data as base64 in Firestore
// Larger files save metadata only (name, type, size)
async function saveFileToFirestore(file) {
    const user = window._currentUser || (typeof auth !== 'undefined' ? auth.currentUser : null);
    if (!user || typeof db === 'undefined') return null;

    try {
        const MAX_INLINE_SIZE = 500 * 1024; // 500KB — Firestore doc limit is 1MB
        const fileDoc = {
            name: file.name,
            type: file.type,
            size: file.size,
            isImage: file.isImage || false,
            isPdf: file.isPdf || false,
            isText: file.isText || false,
            uploadedAt: new Date().toISOString()
        };

        // Store actual file data only if small enough for Firestore
        if (file.size <= MAX_INLINE_SIZE) {
            fileDoc.data = file.data; // base64 for images/pdf, text for text files
            fileDoc.stored = true;
        } else {
            fileDoc.stored = false; // metadata only for large files
        }

        // Save to user's files subcollection
        const docRef = await db.collection('users').doc(user.uid)
            .collection('files').add(fileDoc);

        fileDoc.id = docRef.id;
        return fileDoc;
    } catch (err) {
        console.error('File save to Firestore failed:', err);
        return null;
    }
}

function handleFile(file) {
    const maxSize = 20 * 1024 * 1024;
    if (file.size > maxSize) {
        addBotMessage("⚠️ File is too large. Maximum size is 20MB.");
        return;
    }

    const imageTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp'];
    const isImage = imageTypes.includes(file.type);
    const textTypes = ['text/plain', 'text/csv', 'application/json'];
    const isText = textTypes.includes(file.type) || file.name.endsWith('.txt') || file.name.endsWith('.csv') || file.name.endsWith('.json');
    const isPdf = file.type === 'application/pdf' || file.name.endsWith('.pdf');

    const reader = new FileReader();

    if (isImage || isPdf) {
        reader.onload = (e) => {
            const base64 = e.target.result.split(',')[1];
            pendingFile = {
                name: file.name,
                type: file.type || (isPdf ? 'application/pdf' : 'application/octet-stream'),
                size: file.size,
                data: base64,
                isImage, isPdf,
                dataUrl: isImage ? e.target.result : null
            };
            showFilePreview();
        };
        reader.readAsDataURL(file);
    } else if (isText) {
        reader.onload = (e) => {
            pendingFile = {
                name: file.name,
                type: file.type || 'text/plain',
                size: file.size,
                data: e.target.result,
                isImage: false, isPdf: false, isText: true
            };
            showFilePreview();
        };
        reader.readAsText(file);
    } else {
        reader.onload = (e) => {
            pendingFile = {
                name: file.name,
                type: file.type || 'application/octet-stream',
                size: file.size,
                data: e.target.result,
                isImage: false, isPdf: false, isText: true
            };
            showFilePreview();
        };
        reader.readAsText(file);
    }
}

function showFilePreview() {
    if (!pendingFile) return;
    const icon = pendingFile.isImage ? '🖼️' : pendingFile.isPdf ? '📕' : '📄';
    const sizeStr = formatFileSize(pendingFile.size);
    const safeName = escapeHtml(pendingFile.name);
    let thumbHtml = (pendingFile.isImage && pendingFile.dataUrl)
        ? `<img src="${pendingFile.dataUrl}" alt="preview">`
        : icon;

    filePreview.innerHTML = `
        <div class="file-preview-thumb">${thumbHtml}</div>
        <div class="file-preview-info">
            <div class="file-preview-name">${safeName}</div>
            <div class="file-preview-size">${sizeStr}</div>
        </div>
        <button class="file-preview-remove" id="remove-file" title="Remove file">✕</button>
    `;
    filePreviewArea.style.display = 'block';
    attachBtn.classList.add('has-file');
    document.getElementById('remove-file').addEventListener('click', clearPendingFile);
    chatInput.placeholder = `Ask about "${pendingFile.name}" or just send it...`;
}

function clearPendingFile() {
    pendingFile = null;
    filePreviewArea.style.display = 'none';
    filePreview.innerHTML = '';
    attachBtn.classList.remove('has-file');
    fileInput.value = '';
    chatInput.placeholder = 'Type your message or upload a file...';
}

// Use shared formatFileSize from OfflineAI.formatSize
function formatFileSize(bytes) {
    return OfflineAI.formatSize(bytes);
}

// ===== Clear Chat =====
clearChatBtn.addEventListener('click', () => {
    conversationHistory = [];
    chatMessages.innerHTML = `
        <div class="chat-msg bot">
            <div class="msg-avatar">AI</div>
            <div class="msg-content">
                <p>Chat cleared! 🧹 Ready for a new conversation.</p>
            </div>
        </div>
    `;
    clearPendingFile();
});

// ===== Chat Submission =====
chatForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (isProcessing) return;

    // Must select a mode first
    if (!appMode) {
        showModeScreen();
        return;
    }

    const msg = chatInput.value.trim();
    const hasFile = pendingFile !== null;
    if (!msg && !hasFile) return;

    // Build display
    let userDisplayHtml = '';
    if (hasFile) {
        const safeFileName = escapeHtml(pendingFile.name);
        if (pendingFile.isImage && pendingFile.dataUrl) {
            userDisplayHtml += `<div class="msg-file-preview"><img src="${pendingFile.dataUrl}" alt="${safeFileName}"><div class="msg-file-name">📎 ${safeFileName}</div></div>`;
        } else {
            userDisplayHtml += `<div class="msg-file-preview"><div class="msg-file-name">${pendingFile.isPdf ? '📕' : '📄'} ${safeFileName} (${formatFileSize(pendingFile.size)})</div></div>`;
        }
    }
    if (msg) {
        userDisplayHtml += `<p>${escapeHtml(msg)}</p>`;
    } else if (hasFile) {
        userDisplayHtml += `<p>${escapeHtml(getAutoPrompt(pendingFile))}</p>`;
    }

    addRawMessage(userDisplayHtml, 'user');

    const userText = msg || getAutoPrompt(pendingFile);
    const currentFile = pendingFile;
    chatInput.value = '';
    clearPendingFile();

    // Save file to Firestore (async, non-blocking for AI response)
    let fileMetadata = null;
    if (currentFile) {
        saveFileToFirestore(currentFile).then(meta => {
            fileMetadata = meta;
        }).catch(err => console.error('File save failed:', err));
    }

    // Route based on mode
    if (appMode === 'online') {
        await callBackendAPI(userText, currentFile);
    } else if (appMode === 'offline' && isModelLoaded && useWebLLM && webllmEngine) {
        await callWebLLM(userText, currentFile);
    } else {
        await callOfflineAI(userText, currentFile);
    }

    // Wait for file save if still pending
    if (currentFile && !fileMetadata) {
        fileMetadata = await saveFileToFirestore(currentFile).catch(() => null);
    }

    // Auto-save to Firestore (with file metadata if present)
    saveChat(userText, fileMetadata);
});
window._mainScriptReady = true;

function getAutoPrompt(file) {
    if (file.isImage) return "Please analyze and describe this image in detail. If there's text in it, extract it (OCR).";
    if (file.isPdf) return "Please summarize this PDF document. Extract the key points and main ideas.";
    if (file.name.endsWith('.csv')) return "Please analyze this CSV data. Summarize the structure, key columns, and interesting patterns.";
    if (file.name.endsWith('.json')) return "Please analyze this JSON data. Summarize the structure and key information.";
    return "Please summarize this document. Extract the key points and main ideas.";
}

// =========================================================
// ===== OFFLINE AI ENGINE (Enhanced) =====
// =========================================================
const OfflineAI = {
    greetings: ['hello', 'hi', 'hey', 'hola', 'greetings', 'good morning', 'good afternoon', 'good evening', 'whats up', "what's up", 'sup', 'yo'],
    farewells: ['bye', 'goodbye', 'see you', 'later', 'farewell', 'good night', 'take care'],

    respond(userText, file) {
        if (file) return this.processFile(userText, file);
        return this.handleText(userText);
    },

    handleText(text) {
        const lower = text.toLowerCase().trim();

        if (this.greetings.some(g => lower === g || lower.startsWith(g + ' ') || lower.startsWith(g + '!'))) {
            const replies = [
                "Hey there! 👋 I'm running in **Enhanced Offline Mode**!\n\nTry:\n- 🔢 Math: *\"factorial 10\"*, *\"sin(45)\"*, *\"5^3\"*\n- 🔄 Convert: *\"100 km to miles\"*, *\"30°C to F\"*\n- 💻 Code: *\"python code\"*, *\"typescript\"*\n- 🎲 Random: *\"generate password\"*, *\"flip a coin\"*\n- 📖 Define: *\"what is machine learning?\"*\n- 📊 Analyze: paste any long text!\n- 😄 Fun: *\"tell me a joke\"*",
                "Hello! 😊 **Enhanced Offline AI** ready — math, conversions, code, definitions, text analysis, all without internet!",
                "Hi! 🚀 Offline AI at your service with **enhanced** features! Try *\"100 kg to lbs\"*, *\"factorial 8\"*, or *\"generate password\"*!"
            ];
            return replies[Math.floor(Math.random() * replies.length)];
        }

        if (this.farewells.some(g => lower.includes(g))) {
            return "Goodbye! 👋 Come back anytime — I'm always here, online or offline! 😊";
        }

        if (lower.includes('time') || lower.includes('date') || lower.includes('today') || lower.includes('day is it')) {
            return this.getDateTime(lower);
        }

        // Unit conversion (before math to catch "X to Y" patterns)
        const convResult = this.convertUnit(lower);
        if (convResult) return convResult;

        const mathResult = this.tryMath(lower);
        if (mathResult !== null) return mathResult;

        // Random generators
        if (lower.includes('password') || (lower.includes('random') && !lower.includes('access')) || lower.includes('generate') || lower.includes('flip') || lower.includes('coin') || lower.includes('dice') || lower.includes('roll') || lower.includes('uuid')) {
            const rnd = this.generateRandom(lower);
            if (rnd) return rnd;
        }

        // Base conversion
        if (lower.includes('to binary') || lower.includes('to hex') || lower.includes('to octal') || lower.includes('to decimal') || lower.includes('from binary') || lower.includes('from hex')) {
            const baseResult = this.convertBase(lower);
            if (baseResult) return baseResult;
        }

        if (lower.startsWith('what is ') || lower.startsWith('what are ') || lower.startsWith('define ') || lower.startsWith('meaning of ') || lower.startsWith("what's ")) {
            return this.defineWord(lower);
        }

        if (lower.startsWith('who ') || lower.startsWith('when ') || lower.startsWith('where ') || lower.startsWith('why ') || lower.startsWith('how ')) {
            return this.answerQuestion(lower);
        }

        if (lower.includes('joke') || lower.includes('funny') || lower.includes('make me laugh')) return this.tellJoke();
        if (lower.includes('motivat') || lower.includes('inspir') || lower.includes('quote') || lower.includes('encourage')) return this.motivate();
        if (lower.includes('help') || lower === '?' || lower.includes('what can you do')) return this.showHelp();

        if (lower.includes('translate')) {
            return "🌐 **Translation** requires Online Mode. Switch via 🔄 Switch Mode for 95+ languages!";
        }

        // Text tools
        if (lower.startsWith('reverse ') || lower.startsWith('sort ') || lower.startsWith('uppercase ') || lower.startsWith('lowercase ')) {
            return this.textTools(text);
        }

        // Advanced text analysis
        if (lower.startsWith('analyze:') || lower.startsWith('analyse:') || lower.startsWith('sentiment:')) {
            return this.analyzeTextAdvanced(text.replace(/^(analyze|analyse|sentiment):\s*/i, ''));
        }

        if (lower.includes('code') || lower.includes('program') || lower.includes('javascript') || lower.includes('python') || lower.includes('html') || lower.includes('css') || lower.includes('function') || lower.includes('bug') || lower.includes('error') || lower.includes('java') || lower.includes('react') || lower.includes('node') || lower.includes('typescript') || lower.includes('c++') || lower.includes('rust') || lower.includes('golang') || lower.includes('sql') || this.detectFuzzyLanguage(lower)) {
            return this.codeHelp(lower);
        }

        // Smart code request detection — catches "give me X in Y", "write a X", "how to X in Y"
        if (this.isCodeRequest(lower)) {
            return this.codeHelp(lower);
        }

        if (lower.includes('weather')) {
            return "🌤️ Weather info requires internet. Switch to **Online Mode** for real-time info!";
        }

        if (lower.includes('count') || lower.includes('how many')) return this.countAnalysis(text);

        const words = text.split(/\s+/).length;
        if (words > 20) return this.summarizeText(text);

        return this.smartFallback(text);
    },

    tryMath(text) {
        // Factorial
        const factMatch = text.match(/(?:factorial\s*(?:of\s*)?|(\d+)\s*!)(\d+)?/i);
        if (factMatch) {
            const n = parseInt(factMatch[1] || factMatch[2]);
            if (n >= 0 && n <= 170) {
                let result = 1; for (let i = 2; i <= n; i++) result *= i;
                return `🔢 **${n}!** = **${n <= 20 ? result : result.toExponential(4)}**`;
            }
        }

        // Trig (degrees)
        const trigMatch = text.match(/(sin|cos|tan)\s*\(?\s*(\d+(?:\.\d+)?)\s*\)?/i);
        if (trigMatch) {
            const fn = trigMatch[1].toLowerCase();
            const deg = parseFloat(trigMatch[2]);
            const rad = deg * Math.PI / 180;
            const result = fn === 'sin' ? Math.sin(rad) : fn === 'cos' ? Math.cos(rad) : Math.tan(rad);
            return `🔢 **${fn}(${deg}°)** = **${result.toFixed(6).replace(/\.?0+$/, '')}**`;
        }

        // Logarithm
        const logMatch = text.match(/(?:log|ln)\s*\(?\s*(\d+(?:\.\d+)?)\s*\)?/i);
        if (logMatch) {
            const num = parseFloat(logMatch[1]);
            const isLn = text.toLowerCase().includes('ln');
            const result = isLn ? Math.log(num) : Math.log10(num);
            return `🔢 **${isLn ? 'ln' : 'log₁₀'}(${num})** = **${result.toFixed(6).replace(/\.?0+$/, '')}**`;
        }

        // Power: n^p or n to the power of p
        const powMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:\^|\*\*|to the power of)\s*(\d+(?:\.\d+)?)/i);
        if (powMatch) {
            const base = parseFloat(powMatch[1]), exp = parseFloat(powMatch[2]);
            const result = Math.pow(base, exp);
            return `🔢 **${base}^${exp}** = **${isFinite(result) ? (Number.isInteger(result) ? result : result.toFixed(4)) : '∞'}**`;
        }

        // Combinations nCr
        const combMatch = text.match(/(\d+)\s*(?:c|choose)\s*(\d+)/i);
        if (combMatch) {
            const n = parseInt(combMatch[1]), r = parseInt(combMatch[2]);
            if (r <= n && n <= 170) {
                const fact = (x) => { let f = 1; for (let i = 2; i <= x; i++) f *= i; return f; };
                const result = fact(n) / (fact(r) * fact(n - r));
                return `🔢 **C(${n},${r})** = **${Math.round(result)}**`;
            }
        }

        // Percentage
        const pctMatch = text.match(/(\d+(?:\.\d+)?)\s*%\s*of\s*(\d+(?:\.\d+)?)/i);
        if (pctMatch) {
            const result = (parseFloat(pctMatch[1]) / 100) * parseFloat(pctMatch[2]);
            return `🔢 **${pctMatch[1]}% of ${pctMatch[2]}** = **${result}**`;
        }

        // Square root
        const sqrtMatch = text.match(/square root of\s*(\d+(?:\.\d+)?)|sqrt\s*\(?(\d+(?:\.\d+)?)\)?/i);
        if (sqrtMatch) {
            const num = parseFloat(sqrtMatch[1] || sqrtMatch[2]);
            return `🔢 **√${num}** = **${Math.sqrt(num).toFixed(4)}**`;
        }

        // Arithmetic expression
        let expr = text
            .replace(/plus|add(?:ed)?(?:\s+to)?/gi, '+')
            .replace(/minus|subtract(?:ed)?(?:\s+from)?/gi, '-')
            .replace(/times|multiplied by/gi, '*')
            .replace(/divided by|÷/gi, '/')
            .replace(/what(?:'s| is)?\s*/gi, '')
            .replace(/calculate|solve|compute/gi, '')
            .replace(/[=?]/g, '')
            .trim();

        const cleanExpr = expr.replace(/[^0-9\+\-\*\/\.\(\)\s\%]/g, '').trim();
        if (cleanExpr && /\d/.test(cleanExpr) && /[\+\-\*\/\%]/.test(cleanExpr)) {
            try {
                const result = this.safeEval(cleanExpr);
                if (typeof result === 'number' && isFinite(result)) {
                    return `🔢 **${cleanExpr}** = **${Number.isInteger(result) ? result : result.toFixed(6).replace(/\.?0+$/, '')}**`;
                }
            } catch (e) { /* not valid */ }
        }
        return null;
    },

    // Safe math evaluator — no eval/Function, just basic arithmetic parsing
    safeEval(expr) {
        const tokens = expr.match(/(\d+\.?\d*|[+\-*/%()])/g);
        if (!tokens) throw new Error('Invalid');
        let pos = 0;
        const peek = () => tokens[pos];
        const consume = () => tokens[pos++];
        function parseExpr() {
            let left = parseTerm();
            while (peek() === '+' || peek() === '-') {
                const op = consume();
                const right = parseTerm();
                left = op === '+' ? left + right : left - right;
            }
            return left;
        }
        function parseTerm() {
            let left = parseFactor();
            while (peek() === '*' || peek() === '/' || peek() === '%') {
                const op = consume();
                const right = parseFactor();
                if (op === '*') left *= right;
                else if (op === '/') { if (right === 0) throw new Error('Div0'); left /= right; }
                else left %= right;
            }
            return left;
        }
        function parseFactor() {
            if (peek() === '(') { consume(); const v = parseExpr(); consume(); return v; }
            if (peek() === '-') { consume(); return -parseFactor(); }
            return parseFloat(consume());
        }
        const result = parseExpr();
        if (pos < tokens.length) throw new Error('Unexpected');
        return result;
    },

    // ===== Enhanced Date/Time =====
    getDateTime(lower) {
        const now = new Date();
        const dayOfYear = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86400000);
        const weekNum = Math.ceil(dayOfYear / 7);
        let result = `🕐 **Current Time:** ${now.toLocaleTimeString()}\n📅 **Date:** ${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`;
        result += `\n📊 **Day of Year:** ${dayOfYear}/365 · **Week:** ${weekNum}/52`;
        result += `\n🌍 **Timezone:** ${Intl.DateTimeFormat().resolvedOptions().timeZone}`;
        if (lower.includes('unix') || lower.includes('timestamp')) result += `\n⏱️ **Unix:** ${Math.floor(now.getTime() / 1000)}`;
        return result;
    },

    // ===== Unit Conversion =====
    convertUnit(text) {
        const m = text.match(/([\d.]+)\s*(°?[a-zA-Z²³/]+)\s+(?:to|in|as|into)\s+(°?[a-zA-Z²³/]+)/i);
        if (!m) return null;
        const val = parseFloat(m[1]), from = m[2].toLowerCase().replace('°', ''), to = m[3].toLowerCase().replace('°', '');
        const key = `${from}>${to}`;
        const conversions = {
            'c>f': v => [v * 9 / 5 + 32, '°F'], 'f>c': v => [(v - 32) * 5 / 9, '°C'],
            'km>miles': v => [v * 0.621371, 'miles'], 'miles>km': v => [v * 1.60934, 'km'],
            'km>m': v => [v * 1000, 'm'], 'm>km': v => [v / 1000, 'km'],
            'm>ft': v => [v * 3.28084, 'ft'], 'ft>m': v => [v * 0.3048, 'm'],
            'm>cm': v => [v * 100, 'cm'], 'cm>m': v => [v / 100, 'm'],
            'cm>inches': v => [v * 0.393701, 'inches'], 'inches>cm': v => [v * 2.54, 'cm'],
            'in>cm': v => [v * 2.54, 'cm'], 'cm>in': v => [v * 0.393701, 'in'],
            'kg>lbs': v => [v * 2.20462, 'lbs'], 'lbs>kg': v => [v * 0.453592, 'kg'],
            'kg>g': v => [v * 1000, 'g'], 'g>kg': v => [v / 1000, 'kg'],
            'lb>kg': v => [v * 0.453592, 'kg'], 'kg>lb': v => [v * 2.20462, 'lb'],
            'oz>g': v => [v * 28.3495, 'g'], 'g>oz': v => [v * 0.035274, 'oz'],
            'l>gal': v => [v * 0.264172, 'gal'], 'gal>l': v => [v * 3.78541, 'L'],
            'liters>gallons': v => [v * 0.264172, 'gallons'], 'gallons>liters': v => [v * 3.78541, 'liters'],
            'mph>kmh': v => [v * 1.60934, 'km/h'], 'kmh>mph': v => [v * 0.621371, 'mph'],
            'mph>km/h': v => [v * 1.60934, 'km/h'], 'km/h>mph': v => [v * 0.621371, 'mph'],
            'mb>gb': v => [v / 1024, 'GB'], 'gb>mb': v => [v * 1024, 'MB'],
            'gb>tb': v => [v / 1024, 'TB'], 'tb>gb': v => [v * 1024, 'GB'],
            'kb>mb': v => [v / 1024, 'MB'], 'mb>kb': v => [v * 1024, 'KB'],
            'bytes>kb': v => [v / 1024, 'KB'], 'kb>bytes': v => [v * 1024, 'bytes'],
            'mi>km': v => [v * 1.60934, 'km'], 'km>mi': v => [v * 0.621371, 'mi'],
            'yard>m': v => [v * 0.9144, 'm'], 'm>yard': v => [v * 1.09361, 'yards'],
            'yards>m': v => [v * 0.9144, 'm'], 'm>yards': v => [v * 1.09361, 'yards'],
        };
        const fn = conversions[key];
        if (!fn) return null;
        const [result, unit] = fn(val);
        return `🔄 **${val} ${m[2]}** = **${result.toFixed(4).replace(/\.?0+$/, '')} ${unit}**`;
    },

    // ===== Base Conversion =====
    convertBase(text) {
        const num = text.match(/(\d+)/);
        if (!num) return null;
        const n = parseInt(num[1]);
        if (isNaN(n) || n < 0) return null;
        if (text.includes('to binary') || text.includes('in binary')) {
            return `🔢 **${n}** in binary = **${n.toString(2)}**`;
        }
        if (text.includes('to hex') || text.includes('in hex')) {
            return `🔢 **${n}** in hex = **0x${n.toString(16).toUpperCase()}**`;
        }
        if (text.includes('to octal') || text.includes('in octal')) {
            return `🔢 **${n}** in octal = **0o${n.toString(8)}**`;
        }
        if (text.includes('from binary') || text.includes('binary to decimal')) {
            const dec = parseInt(num[1], 2);
            return isNaN(dec) ? null : `🔢 Binary **${num[1]}** = **${dec}** in decimal`;
        }
        if (text.includes('from hex') || text.includes('hex to decimal')) {
            const hexMatch = text.match(/([0-9a-fA-F]+)/);
            if (hexMatch) {
                const dec = parseInt(hexMatch[1], 16);
                return `🔢 Hex **${hexMatch[1].toUpperCase()}** = **${dec}** in decimal`;
            }
        }
        // Show all bases
        if (text.includes('to decimal') || text.includes('all base') || text.includes('convert')) {
            return `🔢 **${n}:**\n- Binary: **${n.toString(2)}**\n- Octal: **0o${n.toString(8)}**\n- Hex: **0x${n.toString(16).toUpperCase()}**`;
        }
        return null;
    },

    // ===== Random Generators =====
    generateRandom(text) {
        const lower = text.toLowerCase();
        if (lower.includes('password')) {
            const len = parseInt((text.match(/(\d+)/) || [])[1]) || 16;
            const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*_-+=';
            let pw = '';
            const arr = new Uint32Array(len);
            crypto.getRandomValues(arr);
            for (let i = 0; i < len; i++) pw += chars[arr[i] % chars.length];
            return `🔐 **Generated Password (${len} chars):**\n\n\`${pw}\`\n\n*Cryptographically random. Copy and store safely!*`;
        }
        if (lower.includes('uuid')) {
            const uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
                const r = crypto.getRandomValues(new Uint8Array(1))[0] % 16;
                return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
            });
            return `🆔 **UUID:** \`${uuid}\``;
        }
        if (lower.includes('coin') || lower.includes('flip')) {
            const result = crypto.getRandomValues(new Uint8Array(1))[0] % 2 === 0 ? 'Heads' : 'Tails';
            return `🪙 **Coin Flip:** ${result === 'Heads' ? '🟡' : '⚪'} **${result}!**`;
        }
        if (lower.includes('dice') || lower.includes('roll')) {
            const sides = parseInt((text.match(/d(\d+)/i) || [])[1]) || 6;
            const result = (crypto.getRandomValues(new Uint8Array(1))[0] % sides) + 1;
            return `🎲 **Rolled a d${sides}:** **${result}!**`;
        }
        if (lower.includes('number') || lower.includes('random')) {
            const nums = text.match(/(\d+)/g);
            const min = nums && nums.length >= 1 ? parseInt(nums[0]) : 1;
            const max = nums && nums.length >= 2 ? parseInt(nums[1]) : 100;
            const result = Math.floor(Math.random() * (max - min + 1)) + min;
            return `🎯 **Random Number (${min}-${max}):** **${result}**`;
        }
        return null;
    },

    // ===== Text Tools =====
    textTools(text) {
        const lower = text.toLowerCase();
        if (lower.startsWith('reverse ')) {
            const input = text.substring(8);
            return `🔄 **Reversed:** ${input.split('').reverse().join('')}`;
        }
        if (lower.startsWith('sort ')) {
            const input = text.substring(5);
            const sorted = input.split(/\s+/).sort().join(' ');
            return `🔤 **Sorted:** ${sorted}`;
        }
        if (lower.startsWith('uppercase ')) {
            return `🔠 **UPPERCASE:** ${text.substring(10).toUpperCase()}`;
        }
        if (lower.startsWith('lowercase ')) {
            return `🔡 **lowercase:** ${text.substring(10).toLowerCase()}`;
        }
        return `🔧 Text tools: try *"reverse hello"*, *"sort these words now"*, *"uppercase hello world"*`;
    },

    // ===== Advanced Text Analysis =====
    analyzeTextAdvanced(text) {
        const words = text.split(/\s+/).filter(w => w.length > 0);
        const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
        const syllables = text.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).reduce((sum, w) => {
            let s = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').match(/[aeiouy]{1,2}/g);
            return sum + Math.max((s ? s.length : 0), 1);
        }, 0);
        const avgWordsPerSent = words.length / Math.max(sentences.length, 1);
        const avgSyllPerWord = syllables / Math.max(words.length, 1);
        const flesch = 206.835 - (1.015 * avgWordsPerSent) - (84.6 * avgSyllPerWord);
        const fleschClamped = Math.max(0, Math.min(100, flesch));
        let level = fleschClamped > 80 ? 'Easy' : fleschClamped > 60 ? 'Standard' : fleschClamped > 40 ? 'Moderate' : fleschClamped > 20 ? 'Difficult' : 'Very Difficult';

        // Sentiment
        const pos = ['good', 'great', 'amazing', 'excellent', 'wonderful', 'fantastic', 'love', 'happy', 'best', 'awesome', 'beautiful', 'perfect', 'brilliant', 'enjoy', 'like', 'nice', 'positive', 'success', 'win', 'joy'];
        const neg = ['bad', 'terrible', 'awful', 'horrible', 'hate', 'worst', 'ugly', 'sad', 'fail', 'poor', 'wrong', 'stupid', 'boring', 'annoying', 'negative', 'lose', 'angry', 'fear', 'pain', 'broken'];
        let posCount = 0, negCount = 0;
        words.forEach(w => {
            const lw = w.toLowerCase().replace(/[^a-z]/g, '');
            if (pos.includes(lw)) posCount++;
            if (neg.includes(lw)) negCount++;
        });
        const sentiment = posCount > negCount ? '😊 Positive' : negCount > posCount ? '😟 Negative' : '😐 Neutral';

        // Keywords
        const freq = {};
        const stopWords = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'is', 'it', 'was', 'are', 'be', 'has', 'had', 'do', 'did', 'not', 'this', 'that', 'with', 'from', 'have', 'been', 'they', 'will', 'would', 'could', 'should', 'about', 'their', 'there', 'which', 'were', 'what', 'when', 'your', 'than', 'them', 'then', 'also', 'into', 'some']);
        words.forEach(w => {
            const c = w.toLowerCase().replace(/[^a-z0-9]/g, '');
            if (c.length > 3 && !stopWords.has(c)) freq[c] = (freq[c] || 0) + 1;
        });
        const topWords = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 8);

        let result = `📊 **Advanced Text Analysis:**\n\n`;
        result += `**📈 Stats:**\n- Words: **${words.length}** · Sentences: **${sentences.length}** · Characters: **${text.length}**\n`;
        result += `- Avg words/sentence: **${avgWordsPerSent.toFixed(1)}**\n\n`;
        result += `**📖 Readability:** ${fleschClamped.toFixed(0)}/100 — **${level}**\n`;
        result += `**💭 Sentiment:** ${sentiment} (👍${posCount} 👎${negCount})\n`;
        if (topWords.length > 0) {
            result += `\n**🔑 Keywords:** ${topWords.map(([w, c]) => `*${w}*(${c})`).join(', ')}`;
        }
        return result;
    },

    defineWord(text) {
        const definitions = {
            'algorithm': '**Algorithm** — A step-by-step procedure for solving a problem, especially in computing.',
            'api': '**API (Application Programming Interface)** — A set of protocols that allow software applications to communicate with each other.',
            'ai': '**AI (Artificial Intelligence)** — Simulation of human intelligence by computer systems, including learning and reasoning.',
            'machine learning': '**Machine Learning** — A subset of AI where systems automatically learn from data without explicit programming.',
            'deep learning': '**Deep Learning** — A subset of machine learning using neural networks with many layers to analyze complex patterns.',
            'neural network': '**Neural Network** — A computing system inspired by biological neural networks, used in AI for pattern recognition.',
            'html': '**HTML (HyperText Markup Language)** — The standard language for creating web page structure.',
            'css': '**CSS (Cascading Style Sheets)** — A language for describing the visual presentation of HTML documents.',
            'javascript': '**JavaScript** — A dynamic programming language for creating interactive web pages and applications.',
            'python': '**Python** — A high-level programming language known for readability, used in web dev, data science, and AI.',
            'java': '**Java** — A widely-used, class-based, object-oriented programming language designed for portability.',
            'react': '**React** — A JavaScript library by Facebook for building user interfaces with reusable components.',
            'node': '**Node.js** — A JavaScript runtime that allows running JavaScript on the server side.',
            'typescript': '**TypeScript** — A typed superset of JavaScript that compiles to plain JavaScript.',
            'database': '**Database** — An organized collection of structured data stored and accessed electronically.',
            'sql': '**SQL (Structured Query Language)** — A language for managing and querying relational databases.',
            'cloud computing': '**Cloud Computing** — Delivery of computing services over the internet on a pay-as-you-go basis.',
            'blockchain': '**Blockchain** — A decentralized, secure digital ledger for recording transactions.',
            'internet': '**Internet** — A global network of interconnected computers using TCP/IP protocol.',
            'software': '**Software** — Instructions and programs used to operate computers.',
            'hardware': '**Hardware** — Physical components of a computer system (CPU, RAM, etc).',
            'variable': '**Variable** — A named storage location in memory that holds a value.',
            'function': '**Function** — A reusable block of code that performs a specific task.',
            'loop': '**Loop** — A construct that repeats code while a condition is true (for, while, do-while).',
            'array': '**Array** — A data structure storing a collection of elements by index.',
            'object': '**Object** — A data structure containing properties (data) and methods (functions).',
            'recursion': '**Recursion** — A technique where a function calls itself to solve smaller sub-problems.',
            'compiler': '**Compiler** — Translates source code into machine code before execution.',
            'interpreter': '**Interpreter** — Executes source code line by line without prior compilation.',
            'server': '**Server** — A computer/program that provides services to other computers over a network.',
            'frontend': '**Frontend** — The client-side of a website that users interact with directly.',
            'backend': '**Backend** — The server-side that handles logic, databases, and authentication.',
            'git': '**Git** — A distributed version control system for tracking code changes.',
            'docker': '**Docker** — A platform for creating, deploying, and running applications in containers.',
            'kubernetes': '**Kubernetes** — An open-source system for automating deployment and scaling of containerized apps.',
            'devops': '**DevOps** — A set of practices combining software development and IT operations.',
            'agile': '**Agile** — An iterative approach to project management and software development.',
            'scrum': '**Scrum** — An Agile framework for managing and completing complex projects in sprints.',
            'rest': '**REST (Representational State Transfer)** — An architectural style for designing networked APIs using HTTP methods.',
            'graphql': '**GraphQL** — A query language for APIs that lets clients request exactly the data they need.',
            'json': '**JSON (JavaScript Object Notation)** — A lightweight data format for storing and exchanging data.',
            'xml': '**XML (Extensible Markup Language)** — A markup language for encoding documents in a human/machine-readable format.',
            'encryption': '**Encryption** — Converting data into a code to prevent unauthorized access.',
            'firewall': '**Firewall** — A network security system that monitors and controls incoming/outgoing traffic.',
            'vpn': '**VPN (Virtual Private Network)** — Creates a secure, encrypted connection over the internet.',
            'dns': '**DNS (Domain Name System)** — Translates domain names (google.com) into IP addresses.',
            'http': '**HTTP (HyperText Transfer Protocol)** — The protocol for transferring web pages on the internet.',
            'https': '**HTTPS** — HTTP with encryption (SSL/TLS) for secure communication.',
            'cpu': '**CPU (Central Processing Unit)** — The primary processor that executes instructions in a computer.',
            'ram': '**RAM (Random Access Memory)** — Temporary, fast memory used by the CPU for active tasks.',
            'gpu': '**GPU (Graphics Processing Unit)** — A processor specialized for rendering graphics and parallel computations.',
            'ssd': '**SSD (Solid State Drive)** — A fast storage device using flash memory (no moving parts).',
            'linux': '**Linux** — An open-source operating system kernel used in servers, phones, and embedded devices.',
            'operating system': '**Operating System** — Software that manages hardware and provides services for applications (Windows, macOS, Linux).',
            'binary': '**Binary** — A base-2 number system using only 0s and 1s, the foundation of computing.',
            'boolean': '**Boolean** — A data type with only two values: true or false.',
            'class': '**Class** — A blueprint for creating objects with shared properties and methods (OOP concept).',
            'inheritance': '**Inheritance** — An OOP concept where a class derives properties from a parent class.',
            'polymorphism': '**Polymorphism** — The ability of different objects to respond to the same method in different ways.',
            'encapsulation': '**Encapsulation** — Bundling data and methods that operate on it within a class, restricting direct access.',
            'abstraction': '**Abstraction** — Hiding complex details and showing only the essential features.',
            'stack': '**Stack** — A LIFO (Last In, First Out) data structure. Think of a stack of plates.',
            'queue': '**Queue** — A FIFO (First In, First Out) data structure. Think of a line at a store.',
            'linked list': '**Linked List** — A data structure where elements (nodes) point to the next element.',
            'hash table': '**Hash Table** — A data structure mapping keys to values using a hash function for fast lookup.',
            'tree': '**Tree (Data Structure)** — A hierarchical structure with a root node and child nodes.',
            'graph': '**Graph (Data Structure)** — A collection of nodes connected by edges, used for networks.',
            'big o': '**Big O Notation** — Describes the performance/complexity of an algorithm (e.g., O(n), O(log n)).',
            'sorting': '**Sorting** — Arranging data in order. Common algorithms: QuickSort, MergeSort, BubbleSort.',
            'binary search': '**Binary Search** — Efficiently finding an item in a sorted list by repeatedly halving the search range. O(log n).',
            'regex': '**Regex (Regular Expression)** — A pattern used to match character combinations in strings.',
            'responsive design': '**Responsive Design** — Web design that adapts to different screen sizes using flexible layouts.',
            'pwa': '**PWA (Progressive Web App)** — A web app that behaves like a native app with offline support.',
            'websocket': '**WebSocket** — A protocol for full-duplex, real-time communication between client and server.',
            'oauth': '**OAuth** — An open standard for secure delegated access (e.g., "Login with Google").',
            'jwt': '**JWT (JSON Web Token)** — A compact token format for securely transmitting information between parties.',
            'ci cd': '**CI/CD** — Continuous Integration/Continuous Deployment — automating build, test, and deploy processes.',
            'microservices': '**Microservices** — An architecture where an app is built as a collection of small, independent services.',
            'monolith': '**Monolith** — A single, unified application architecture (opposite of microservices).',
            'cache': '**Cache** — Temporary storage for frequently accessed data, improving speed.',
            'cdn': '**CDN (Content Delivery Network)** — A distributed network of servers that delivers content to users from the nearest location.',
            'bandwidth': '**Bandwidth** — The maximum data transfer rate of a network, measured in bits per second.',
            'latency': '**Latency** — The delay between a request and a response in a network.',
            'ip address': '**IP Address** — A unique numerical label assigned to each device on a network.',
            'tcp': '**TCP (Transmission Control Protocol)** — A reliable, connection-oriented protocol for data transmission.',
            'udp': '**UDP (User Datagram Protocol)** — A fast, connectionless protocol suited for streaming and gaming.',
            'ssh': '**SSH (Secure Shell)** — A protocol for secure remote login and command execution.',
            'virtual machine': '**Virtual Machine (VM)** — A software emulation of a physical computer.',
            'container': '**Container** — A lightweight, isolated environment for running applications (e.g., Docker containers).',
            'npm': '**npm (Node Package Manager)** — The default package manager for Node.js.',
            'webpack': '**Webpack** — A module bundler for JavaScript applications.',
            'vite': '**Vite** — A fast, modern build tool for web development with hot module replacement.',
            'api gateway': '**API Gateway** — A server that acts as a single entry point for a set of microservices.',
            'load balancer': '**Load Balancer** — Distributes network traffic across multiple servers for reliability.',
            'nosql': '**NoSQL** — Non-relational databases for flexible, scalable data storage (MongoDB, Redis, etc).',
            'orm': '**ORM (Object-Relational Mapping)** — A technique for converting data between incompatible systems using OOP.',
            'middleware': '**Middleware** — Software that sits between the OS and applications, handling communication.',
            'singleton': '**Singleton** — A design pattern restricting a class to a single instance.',
            'observer pattern': '**Observer Pattern** — A design pattern where objects subscribe to events from a subject.',
            'mvc': '**MVC (Model-View-Controller)** — An architecture separating data, UI, and logic.',
            'atom': '**Atom** — The smallest unit of matter that retains the properties of an element.',
            'photon': '**Photon** — A particle of light with zero mass, traveling at the speed of light.',
            'evolution': '**Evolution** — The process of change in living organisms over generations through natural selection.',
            'dna': '**DNA (Deoxyribonucleic Acid)** — The molecule carrying genetic instructions for life.',
            'quantum computing': '**Quantum Computing** — Computing using quantum bits (qubits) that can exist in multiple states simultaneously.',
        };

        const searchTerm = text
            .replace(/^(what is|what are|define|meaning of|what's|whats)\s*/i, '')
            .replace(/[?.!]/g, '')
            .trim()
            .toLowerCase();

        for (const [key, value] of Object.entries(definitions)) {
            if (searchTerm.includes(key) || key.includes(searchTerm)) {
                return `📖 ${value}`;
            }
        }

        return `📖 I don't have an offline definition for **"${searchTerm}"**.\n\n💡 Switch to **Online Mode** (🔄 Switch Mode) for definitions of any term!\n\n*Offline, I know: algorithm, API, AI, HTML, CSS, JavaScript, Python, Java, React, Node.js, database, SQL, Git, Docker, and 40+ more tech terms.*`;
    },

    answerQuestion(text) {
        const lower = text.toLowerCase();
        const qa = [
            { q: ['who created javascript', 'who invented javascript'], a: '**Brendan Eich** created JavaScript in 1995 at Netscape.' },
            { q: ['who created python', 'who invented python'], a: '**Guido van Rossum** created Python, first released in 1991.' },
            { q: ['who created html', 'who invented html'], a: '**Tim Berners-Lee** invented HTML in 1991 at CERN.' },
            { q: ['who created java', 'who invented java'], a: '**James Gosling** created Java at Sun Microsystems, released in 1995.' },
            { q: ['who created react', 'who made react'], a: '**Jordan Walke** at Facebook created React, open-sourced in 2013.' },
            { q: ['who created linux', 'who invented linux'], a: '**Linus Torvalds** created Linux in 1991 as a free, open-source OS kernel.' },
            { q: ['who created c++', 'who invented c++'], a: '**Bjarne Stroustrup** created C++ in 1979 at Bell Labs.' },
            { q: ['who created git', 'who invented git'], a: '**Linus Torvalds** created Git in 2005 for Linux kernel development.' },
            { q: ['who created typescript', 'who invented typescript'], a: '**Anders Hejlsberg** at Microsoft created TypeScript, released in 2012.' },
            { q: ['who created rust', 'who invented rust'], a: '**Graydon Hoare** at Mozilla created Rust, first stable release in 2015.' },
            { q: ['who created go', 'who invented golang'], a: '**Robert Griesemer, Rob Pike, and Ken Thompson** at Google created Go, released in 2009.' },
            { q: ['who is elon musk'], a: '**Elon Musk** is CEO of Tesla and SpaceX, owner of X (Twitter), and co-founder of Neuralink and PayPal.' },
            { q: ['who is jeff bezos'], a: '**Jeff Bezos** founded Amazon in 1994 and Blue Origin space company.' },
            { q: ['how does the internet work'], a: 'The **internet** connects computers worldwide through cables, routers, and servers. Data is broken into packets, sent via TCP/IP, routed through nodes, and reassembled.' },
            { q: ['how to learn programming', 'how to learn coding', 'how to start coding'], a: '🎯 **Learn to Code:**\n1. Pick Python or JavaScript\n2. Use freeCodeCamp, Codecademy, or Khan Academy\n3. Build small projects\n4. Practice daily\n5. Join coding communities\n6. Learn by doing!' },
            { q: ['how many planets'], a: 'There are **8 planets**: Mercury, Venus, Earth, Mars, Jupiter, Saturn, Uranus, and Neptune.' },
            { q: ['speed of light'], a: 'The **speed of light** is approximately **299,792,458 m/s** (~186,282 miles/sec).' },
            { q: ['speed of sound'], a: 'The **speed of sound** in air is approximately **343 m/s** (~1,235 km/h) at 20°C.' },
            { q: ['largest ocean'], a: 'The **Pacific Ocean** — the largest, covering ~165.25 million km².' },
            { q: ['tallest mountain'], a: '**Mount Everest** at **8,849 meters** (29,032 feet).' },
            { q: ['longest river'], a: 'The **Nile River** (~6,650 km) is traditionally considered the longest, though the Amazon may be longer.' },
            { q: ['largest country'], a: '**Russia** is the largest country by area (~17.1 million km²).' },
            { q: ['smallest country'], a: '**Vatican City** is the smallest country (~0.44 km²).' },
            { q: ['most spoken language'], a: '**English** is the most widely spoken language (~1.5 billion speakers). **Mandarin Chinese** has the most native speakers (~920 million).' },
            { q: ['what is gravity', 'how does gravity work'], a: '**Gravity** is a force that attracts objects with mass toward each other. More mass = stronger pull. Described by Newton\'s law and Einstein\'s general relativity.' },
            { q: ['what is pi', 'value of pi'], a: '**π (Pi)** ≈ **3.14159265358979...** — the ratio of a circle\'s circumference to its diameter. It\'s irrational and infinite.' },
            { q: ['what is fibonacci'], a: '**Fibonacci Sequence:** 0, 1, 1, 2, 3, 5, 8, 13, 21, 34... Each number is the sum of the two preceding ones.' },
            { q: ['what is prime', 'prime number'], a: 'A **prime number** is greater than 1 and divisible only by 1 and itself. Examples: 2, 3, 5, 7, 11, 13, 17, 19, 23...' },
            { q: ['how to make a website', 'how to build a website'], a: '🌐 **Build a Website:**\n1. Learn **HTML** (structure)\n2. Learn **CSS** (styling)\n3. Learn **JavaScript** (interactivity)\n4. Use a code editor (VS Code)\n5. Host on GitHub Pages, Netlify, or Vercel\n6. Practice with small projects!' },
            { q: ['how old is the earth'], a: 'The **Earth** is approximately **4.54 billion years old**.' },
            { q: ['how old is the universe'], a: 'The **universe** is approximately **13.8 billion years old**, based on cosmic microwave background observations.' },
            { q: ['how does wifi work'], a: '**WiFi** uses radio waves (2.4/5/6 GHz) to transmit data wirelessly between devices and a router connected to the internet.' },
            { q: ['distance to moon'], a: 'The **Moon** is approximately **384,400 km** (238,855 miles) from Earth on average.' },
            { q: ['distance to sun'], a: 'The **Sun** is approximately **149.6 million km** (93 million miles) from Earth — 1 AU (Astronomical Unit).' },
            { q: ['boiling point of water'], a: 'Water boils at **100°C (212°F)** at sea level (standard atmospheric pressure).' },
            { q: ['freezing point of water'], a: 'Water freezes at **0°C (32°F)** at standard atmospheric pressure.' },
        ];

        for (const item of qa) {
            if (item.q.some(q => lower.includes(q))) return `💡 ${item.a}`;
        }

        return `🤔 That's a great question! In **Offline Mode**, I have limited knowledge.\n\nFor detailed answers to any question, switch to **Online Mode** (🔄 Switch Mode) for full Gemini AI!\n\n💡 *Offline, I can help with: math, definitions, code references, file analysis, jokes, and common facts.*`;
    },

    tellJoke() {
        const jokes = [
            "Why do programmers prefer dark mode? Because light attracts bugs! 🐛😄",
            "Why did the developer go broke? He used up all his cache! 💰😂",
            "How do you comfort a JavaScript bug? You console it! 💬😄",
            "Why do Java developers wear glasses? Because they can't C#! 👓😂",
            "A QA engineer walks into a bar. Orders 1 beer. Orders 0 beers. Orders 999999 beers. Orders -1 beers. Orders a lizard. 🦎😂",
            "There are 10 types of people: those who understand binary and those who don't! 🔢😄",
            "Why did the programmer quit? He didn't get arrays! (a raise) 📊😂",
            "What's a programmer's favorite hangout? Foo Bar! 🍺😄",
            "Why was the JavaScript developer sad? Because he didn't Node how to Express himself! 😂",
            "!false — it's funny because it's true! 😄",
        ];
        return jokes[Math.floor(Math.random() * jokes.length)];
    },

    motivate() {
        const quotes = [
            "💫 *\"The only way to do great work is to love what you do.\"* — Steve Jobs",
            "🚀 *\"First, solve the problem. Then, write the code.\"* — John Johnson",
            "🌟 *\"Code is like humor. When you have to explain it, it's bad.\"* — Cory House",
            "💎 *\"Believe you can and you're halfway there.\"* — Theodore Roosevelt",
            "🔥 *\"The best error message is the one that never shows up.\"* — Thomas Fuchs",
            "⚡ *\"Talk is cheap. Show me the code.\"* — Linus Torvalds",
            "🎯 *\"The only impossible journey is the one you never begin.\"* — Tony Robbins",
            "✨ *\"Simplicity is the soul of efficiency.\"* — Austin Freeman",
        ];
        return quotes[Math.floor(Math.random() * quotes.length)];
    },

    showHelp() {
        return `🤖 **Enhanced Offline Mode — What I Can Do:**\n\n**🔢 Math & Science**\n- Arithmetic: \`5 + 3\`, \`100 / 4\`\n- Percentages: \`15% of 200\`\n- Powers: \`2^10\`, \`5 to the power of 3\`\n- Factorial: \`factorial 10\` or \`10!\`\n- Trig: \`sin(45)\`, \`cos(60)\`, \`tan(30)\`\n- Roots: \`square root of 144\`\n- Log: \`log(100)\`, \`ln(10)\`\n- Combinations: \`10 choose 3\`\n\n**🔄 Unit Conversion**\n- Temperature: \`30 C to F\`\n- Length: \`100 km to miles\`, \`5 ft to m\`\n- Weight: \`70 kg to lbs\`\n- Data: \`500 MB to GB\`\n- Speed: \`60 mph to kmh\`\n\n**💻 Code References**\n- JavaScript, Python, TypeScript, HTML/CSS, React, C++, SQL\n\n**📖 Knowledge Base**\n- 100+ tech/science definitions\n- 40+ factual Q&A pairs\n\n**🎲 Random Generators**\n- \`generate password\` (with custom length)\n- \`generate uuid\`, \`flip a coin\`, \`roll dice\`\n\n**🔢 Base Conversion**\n- \`255 to binary\`, \`255 to hex\`\n\n**🔧 Text Tools**\n- \`reverse hello world\`\n- \`sort these words alphabetically\`\n- \`uppercase your text\`\n\n**📊 Analysis**\n- \`analyze: paste your text here\`\n- Readability score, sentiment, keywords\n\n**📄 File Analysis**\n- Text, CSV, JSON summaries\n\n**🕐 Date & Time**\n- Current time, date, timezone, day of year\n\n**😄 Fun**\n- Jokes & motivational quotes\n\n**⚡ Want full AI?** Switch to **Online Mode** (🔄) for image analysis, translations, code generation, and more!`;
    },

    codeHelp(text) {
        const lower = text.toLowerCase();

        // ===== Detect language from the query (with fuzzy matching) =====
        let lang = 'python'; // default
        const fuzzyLang = this.detectFuzzyLanguage(lower);
        if (fuzzyLang) lang = fuzzyLang;
        else if (lower.includes('javascript') || lower.includes(' js ') || lower.includes(' js')) lang = 'javascript';
        else if (lower.includes('typescript')) lang = 'typescript';
        else if (lower.includes('python')) lang = 'python';
        else if (lower.includes('java') && !lower.includes('javascript')) lang = 'java';
        else if (lower.includes('c++') || lower.includes('cpp')) lang = 'cpp';
        else if (lower.includes('rust')) lang = 'rust';
        else if (lower.includes('golang') || lower.includes('go lang')) lang = 'go';
        else if (lower.includes('html') || lower.includes('css')) lang = 'html';
        else if (lower.includes('react') || lower.includes('jsx')) lang = 'react';
        else if (lower.includes('sql')) lang = 'sql';
        else if (lower.includes('node')) lang = 'javascript';

        // ===== Code snippet database — specific programs =====
        const snippets = [
            {
                tags: ['hello world', 'print hello', 'say hello'],
                name: 'Hello World',
                python: '```python\nprint("Hello, World!")\n```',
                javascript: '```javascript\nconsole.log("Hello, World!");\n```',
                typescript: '```typescript\nconst message: string = "Hello, World!";\nconsole.log(message);\n```',
                java: '```java\npublic class Main {\n    public static void main(String[] args) {\n        System.out.println("Hello, World!");\n    }\n}\n```',
                cpp: '```cpp\n#include <iostream>\nusing namespace std;\n\nint main() {\n    cout << "Hello, World!" << endl;\n    return 0;\n}\n```',
                rust: '```rust\nfn main() {\n    println!("Hello, World!");\n}\n```',
                go: '```go\npackage main\nimport "fmt"\n\nfunc main() {\n    fmt.Println("Hello, World!")\n}\n```',
                html: '```html\n<!DOCTYPE html>\n<html>\n<body>\n    <h1>Hello, World!</h1>\n</body>\n</html>\n```',
            },
            {
                tags: ['fibonacci', 'fibonaci', 'fib'],
                name: 'Fibonacci Sequence',
                python: '```python\ndef fibonacci(n):\n    a, b = 0, 1\n    result = []\n    for _ in range(n):\n        result.append(a)\n        a, b = b, a + b\n    return result\n\nprint(fibonacci(10))  # [0, 1, 1, 2, 3, 5, 8, 13, 21, 34]\n```',
                javascript: '```javascript\nfunction fibonacci(n) {\n    let a = 0, b = 1;\n    const result = [];\n    for (let i = 0; i < n; i++) {\n        result.push(a);\n        [a, b] = [b, a + b];\n    }\n    return result;\n}\n\nconsole.log(fibonacci(10)); // [0, 1, 1, 2, 3, 5, 8, 13, 21, 34]\n```',
                typescript: '```typescript\nfunction fibonacci(n: number): number[] {\n    let a = 0, b = 1;\n    const result: number[] = [];\n    for (let i = 0; i < n; i++) {\n        result.push(a);\n        [a, b] = [b, a + b];\n    }\n    return result;\n}\n\nconsole.log(fibonacci(10));\n```',
                java: '```java\npublic class Fibonacci {\n    public static void main(String[] args) {\n        int n = 10, a = 0, b = 1;\n        for (int i = 0; i < n; i++) {\n            System.out.print(a + " ");\n            int temp = a + b;\n            a = b;\n            b = temp;\n        }\n    }\n}\n```',
                cpp: '```cpp\n#include <iostream>\nusing namespace std;\n\nint main() {\n    int n = 10, a = 0, b = 1;\n    for (int i = 0; i < n; i++) {\n        cout << a << " ";\n        int temp = a + b;\n        a = b;\n        b = temp;\n    }\n    return 0;\n}\n```',
                rust: '```rust\nfn fibonacci(n: usize) -> Vec<u64> {\n    let (mut a, mut b) = (0u64, 1u64);\n    (0..n).map(|_| { let val = a; let temp = a + b; a = b; b = temp; val }).collect()\n}\n\nfn main() {\n    println!("{:?}", fibonacci(10));\n}\n```',
                go: '```go\npackage main\nimport "fmt"\n\nfunc fibonacci(n int) []int {\n    result := make([]int, n)\n    a, b := 0, 1\n    for i := 0; i < n; i++ {\n        result[i] = a\n        a, b = b, a+b\n    }\n    return result\n}\n\nfunc main() {\n    fmt.Println(fibonacci(10))\n}\n```',
            },
            {
                tags: ['factorial', 'fact'],
                name: 'Factorial',
                python: '```python\ndef factorial(n):\n    if n <= 1:\n        return 1\n    return n * factorial(n - 1)\n\nprint(factorial(5))  # 120\n```',
                javascript: '```javascript\nfunction factorial(n) {\n    if (n <= 1) return 1;\n    return n * factorial(n - 1);\n}\n\nconsole.log(factorial(5)); // 120\n```',
                typescript: '```typescript\nfunction factorial(n: number): number {\n    if (n <= 1) return 1;\n    return n * factorial(n - 1);\n}\n\nconsole.log(factorial(5)); // 120\n```',
                java: '```java\npublic class Factorial {\n    static int factorial(int n) {\n        if (n <= 1) return 1;\n        return n * factorial(n - 1);\n    }\n    public static void main(String[] args) {\n        System.out.println(factorial(5)); // 120\n    }\n}\n```',
                cpp: '```cpp\n#include <iostream>\nusing namespace std;\n\nint factorial(int n) {\n    if (n <= 1) return 1;\n    return n * factorial(n - 1);\n}\n\nint main() {\n    cout << factorial(5) << endl; // 120\n    return 0;\n}\n```',
                rust: '```rust\nfn factorial(n: u64) -> u64 {\n    if n <= 1 { 1 } else { n * factorial(n-1) }\n}\n\nfn main() {\n    println!("{}", factorial(5)); // 120\n}\n```',
                go: '```go\npackage main\nimport "fmt"\n\nfunc factorial(n int) int {\n    if n <= 1 { return 1 }\n    return n * factorial(n-1)\n}\n\nfunc main() {\n    fmt.Println(factorial(5)) // 120\n}\n```',
            },
            {
                tags: ['palindrome', 'palidrome'],
                name: 'Palindrome Check',
                python: '```python\ndef is_palindrome(s):\n    s = str(s).lower().replace(" ", "")\n    return s == s[::-1]\n\nprint(is_palindrome("racecar"))  # True\n```',
                javascript: '```javascript\nfunction isPalindrome(s) {\n    s = String(s).toLowerCase().replace(/\\s/g, "");\n    return s === s.split("").reverse().join("");\n}\n\nconsole.log(isPalindrome("racecar")); // true\n```',
            },
            {
                tags: ['print numbers', '1 to 10', '1 to 100', 'numbers from'],
                name: 'Print Numbers Sequence',
                python: '```python\n# Print numbers from 1 to 10\nfor i in range(1, 11):\n    print(i)\n\n# Or using a list comprehension\n# print([i for i in range(1, 11)])\n```',
                javascript: '```javascript\n// Print numbers from 1 to 10\nfor (let i = 1; i <= 10; i++) {\n    console.log(i);\n}\n```',
                java: '```java\npublic class Main {\n    public static void main(String[] args) {\n        for (int i = 1; i <= 10; i++) {\n            System.out.println(i);\n        }\n    }\n}\n```',
                cpp: '```cpp\n#include <iostream>\nusing namespace std;\n\nint main() {\n    for (int i = 1; i <= 10; i++) {\n        cout << i << " ";\n    }\n    return 0;\n}\n```',
            },
            {
                tags: ['reverse string', 'reverse text'],
                name: 'Reverse String',
                python: '```python\ndef reverse_string(s):\n    return s[::-1]\n\nprint(reverse_string("Hello"))  # olleH\n```',
                javascript: '```javascript\nfunction reverseString(s) {\n    return s.split("").reverse().join("");\n}\n\nconsole.log(reverseString("Hello")); // olleH\n```',
            },
            {
                tags: ['bubble sort', 'sorting algorithm'],
                name: 'Bubble Sort',
                python: '```python\ndef bubble_sort(arr):\n    n = len(arr)\n    for i in range(n):\n        for j in range(0, n - i - 1):\n            if arr[j] > arr[j + 1]:\n                arr[j], arr[j + 1] = arr[j + 1], arr[j]\n    return arr\n\nprint(bubble_sort([64, 34, 25, 12, 22, 11, 90]))\n```',
                javascript: '```javascript\nfunction bubbleSort(arr) {\n    const n = arr.length;\n    for (let i = 0; i < n; i++) {\n        for (let j = 0; j < n - i - 1; j++) {\n            if (arr[j] > arr[j + 1]) {\n                [arr[j], arr[j + 1]] = [arr[j + 1], arr[j]];\n            }\n        }\n    }\n    return arr;\n}\n\nconsole.log(bubbleSort([64, 34, 25, 12, 22, 11, 90]));\n```',
            },
            {
                tags: ['prime', 'is prime', 'prime numbers'],
                name: 'Prime Number Check',
                python: '```python\ndef is_prime(n):\n    if n < 2:\n        return False\n    for i in range(2, int(n**0.5) + 1):\n        if n % i == 0:\n            return False\n    return True\n\n# Print primes up to 50\nprint([n for n in range(2, 51) if is_prime(n)])\n```',
                javascript: '```javascript\nfunction isPrime(n) {\n    if (n < 2) return false;\n    for (let i = 2; i <= Math.sqrt(n); i++) {\n        if (n % i === 0) return false;\n    }\n    return true;\n}\n\n// Primes up to 50\nconsole.log(Array.from({length: 49}, (_, i) => i + 2).filter(isPrime));\n```',
            },
            {
                tags: ['calculator', 'calc'],
                name: 'Simple Calculator',
                python: '```python\ndef calculator():\n    a = float(input("First num: "))\n    op = input("Op (+,-,*,/): ")\n    b = float(input("Second num: "))\n    if op == "+": print(a + b)\n    elif op == "-": print(a - b)\n    elif op == "*": print(a * b)\n    elif op == "/": print(a / b if b != 0 else "Error")\n\ncalculator()\n```',
                javascript: '```javascript\nfunction calculator(a, op, b) {\n    switch(op) {\n        case "+": return a + b;\n        case "-": return a - b;\n        case "*": return a * b;\n        case "/": return b !== 0 ? a / b : "Error";\n    }\n}\nconsole.log(calculator(10, "+", 5));\n```',
            },
            {
                tags: ['even odd', 'is even'],
                name: 'Even or Odd Check',
                python: '```python\ndef even_odd(n):\n    return "Even" if n % 2 == 0 else "Odd"\n\nprint(even_odd(7))  # Odd\n```',
                javascript: '```javascript\nconst evenOdd = n => n % 2 === 0 ? "Even" : "Odd";\nconsole.log(evenOdd(7)); // Odd\n```',
            },
            {
                tags: ['sum array', 'sum list', 'add numbers'],
                name: 'Sum of Numbers',
                python: '```python\nnums = [1, 2, 3, 4, 5]\nprint(f"Sum: {sum(nums)}")\n```',
                javascript: '```javascript\nconst nums = [1, 2, 3, 4, 5];\nconsole.log("Sum:", nums.reduce((a, b) => a + b, 0));\n```',
            },
            {
                tags: ['swap', 'swap variables'],
                name: 'Swap Variables',
                python: '```python\na, b = 5, 10\na, b = b, a\nprint(f"a={a}, b={b}")\n```',
                javascript: '```javascript\nlet a = 5, b = 10;\n[a, b] = [b, a];\nconsole.log(`a=${a}, b=${b}`);\n```',
            },
            {
                tags: ['array sort', 'sort array', 'sort list'],
                name: 'Array Sort',
                python: '```python\nnumbers = [5, 2, 8, 1, 9, 3]\nnumbers.sort()           # In-place sort\nprint(numbers)           # [1, 2, 3, 5, 8, 9]\n```',
                javascript: '```javascript\nconst numbers = [5, 2, 8, 1, 9, 3];\nnumbers.sort((a, b) => a - b); // ascending\nconsole.log(numbers); // [1, 2, 3, 5, 8, 9]\n```',
            },
            {
                tags: ['for loop', 'while loop', 'loop example'],
                name: 'Loops Reference',
                python: '```python\n# For\nfor i in range(5): print(i)\n\n# While\nc = 0\nwhile c < 5:\n    print(c)\n    c += 1\n```',
                javascript: '```javascript\n// For\nfor (let i = 0; i < 5; i++) console.log(i);\n\n// While\nlet c = 0;\nwhile (c < 5) {\n    console.log(c);\n    c++;\n}\n```',
            },
            {
                tags: ['class', 'oop', 'object oriented'],
                name: 'Class & Objects',
                python: '```python\nclass Person:\n    def __init__(self, name):\n        self.name = name\n    def greet(self):\n        return f"Hello, I am {self.name}"\n\np = Person("Alice")\nprint(p.greet())\n```',
                javascript: '```javascript\nclass Person {\n    constructor(name) { this.name = name; }\n    greet() { return `Hello, I am ${this.name}`; }\n}\nconst p = new Person("Alice");\nconsole.log(p.greet());\n```',
            },
            {
                tags: ['fetch', 'api call', 'http request'],
                name: 'Fetch API / Requests',
                javascript: '```javascript\nasync function getData() {\n    const res = await fetch("https://api.example.com");\n    const data = await res.json();\n    console.log(data);\n}\n```',
                python: '```python\nimport requests\nres = requests.get("https://api.example.com")\nprint(res.json())\n```',
            },
            {
                tags: ['read file', 'write file', 'file io'],
                name: 'File Handling',
                python: '```python\nwith open("test.txt", "r") as f:\n    print(f.read())\n```',
                javascript: '```javascript\nconst fs = require("fs");\nconst data = fs.readFileSync("test.txt", "utf8");\nconsole.log(data);\n```',
            },
            {
                tags: ['binary search', 'search algorithm'],
                name: 'Binary Search',
                python: '```python\ndef binary_search(arr, target):\n    low, high = 0, len(arr) - 1\n    while low <= high:\n        mid = (low + high) // 2\n        if arr[mid] == target: return mid\n        if arr[mid] < target: low = mid + 1\n        else: high = mid - 1\n    return -1\n```',
                javascript: '```javascript\nfunction binarySearch(arr, target) {\n    let low = 0, high = arr.length - 1;\n    while (low <= high) {\n        const mid = Math.floor((low + high) / 2);\n        if (arr[mid] === target) return mid;\n        if (arr[mid] < target) low = mid + 1;\n        else high = mid - 1;\n    }\n    return -1;\n}\n```',
            },
            {
                tags: ['linked list', 'linkedlist'],
                name: 'Linked List',
                python: '```python\nclass Node:\n    def __init__(self, data): self.data, self.next = data, None\n```',
                javascript: '```javascript\nclass Node {\n    constructor(data) { this.data = data; this.next = null; }\n}\n```',
            },
            {
                tags: ['website', 'landing page', 'portfolio'],
                name: 'Modern Website Template',
                html: '```html\n<!DOCTYPE html>\n<html lang="en">\n<head>\n    <meta charset="UTF-8">\n    <meta name="viewport" content="width=device-width, initial-scale=1.0">\n    <title>Modern Landing Page</title>\n    <style>\n        body { font-family: sans-serif; margin: 0; line-height: 1.6; }\n        .hero { background: #333; color: #fff; padding: 100px 20px; text-align: center; }\n        .features { display: flex; padding: 50px; gap: 20px; }\n        .card { flex: 1; border: 1px solid #ddd; padding: 20px; border-radius: 8px; }\n        nav { background: #444; color: #fff; padding: 15px; display: flex; justify-content: space-around; }\n    </style>\n</head>\n<body>\n    <nav><b>MyBrand</b> <div>Home | Features | Contact</div></nav>\n    <header class="hero">\n        <h1>Grow Your Business</h1>\n        <p>A simpler way to manage your work.</p>\n        <button>Get Started</button>\n    </header>\n    <section class="features">\n        <div class="card"><h3>Fast</h3><p>Speed is our priority.</p></div>\n        <div class="card"><h3>Secure</h3><p>Your data is safe.</p></div>\n        <div class="card"><h3>Global</h3><p>Available everywhere.</p></div>\n    </section>\n</body>\n</html>\n```',
            },
            {
                tags: ['login', 'authentication', 'auth'],
                name: 'Login System Template',
                python: '```python\n# Basic Auth System\nusers = {"admin": "password123"}\n\ndef login(user, pw):\n    if user in users and users[user] == pw:\n        return f"Welcome, {user}!"\n    return "Invalid credentials."\n\n# User simulation\nprint(login("admin", "password123"))\n```',
                javascript: '```javascript\n// Simple Express.js Auth Middleware\nconst users = [{ id: 1, name: "Admin", pass: "123" }];\n\nfunction authenticate(req, res, next) {\n    const { user, pass } = req.headers;\n    const found = users.find(u => u.name === user && u.pass === pass);\n    if (found) next();\n    else res.status(401).send("Unauthorized");\n}\n```',
            },
            {
                tags: ['api', 'rest api', 'backend'],
                name: 'Backend API Template',
                python: '```python\nfrom fastapi import FastAPI\n\napp = FastAPI()\n\n@app.get("/")\ndef home():\n    return {"message": "Hello World"}\n\n@app.get("/items/{id}")\ndef read_item(id: int):\n    return {"item_id": id}\n```',
                javascript: '```javascript\nconst express = require("express");\nconst app = express();\n\napp.use(express.json());\n\napp.get("/api/data", (req, res) => {\n    res.json({ success: true, data: [] });\n});\n\napp.listen(3000, () => console.log("Server on 3000"));\n```',
            },
            {
                tags: ['crud', 'database'],
                name: 'CRUD Logic Template',
                javascript: '```javascript\n// Memory-based CRUD\nlet items = [];\n\nconst create = (item) => items.push(item);\nconst read = () => items;\nconst update = (id, val) => items[id] = val;\nconst remove = (id) => items.splice(id, 1);\n```',
                python: '```python\n# Python CRUD\nitems = []\ndef create(item): items.append(item)\ndef read(): return items\ndef update(idx, val): items[idx] = val\ndef delete(idx): items.pop(idx)\n```',
            },
            {
                tags: ['timer', 'countdown', 'delay'],
                name: 'Timer / Countdown',
                python: '```python\nimport time\ndef timer(s):\n    while s:\n        print(s)\n        time.sleep(1)\n        s -= 1\n    print("Done!")\n```',
                javascript: '```javascript\nfunction timer(s) {\n    const it = setInterval(() => {\n        console.log(s--);\n        if (s < 0) { clearInterval(it); console.log("Done!"); }\n    }, 1000);\n}\n```',
            },
        ];

        // ===== Try to match a specific code request =====
        const requestKeywords = ['write', 'print', 'create', 'make', 'build', 'show', 'give', 'generate', 'code for', 'program', 'implement', 'how to'];
        const isSpecificRequest = requestKeywords.some(kw => lower.includes(kw));

        // ===== Heuristic Dynamic Generator (The "Pseudo-LLM" engine) =====
        const dynamicCode = this.dynamicGenerate(lower, lang);
        if (dynamicCode) return dynamicCode;

        // ===== Try to match a specific code request from database =====
        if (isSpecificRequest) {
            for (const item of snippets) {
                if (item.tags.some(tag => lower.includes(tag))) {
                    const code = item[lang] || item['python'] || item['javascript'] || Object.values(item).find(v => typeof v === 'string' && v.startsWith('```'));
                    const langName = { python: 'Python 🐍', javascript: 'JavaScript 🟨', typescript: 'TypeScript 🔷', java: 'Java ☕', cpp: 'C++ ⚙️', rust: 'Rust 🦀', go: 'Go 🐹', html: 'HTML 🌐', react: 'React ⚛️', sql: 'SQL 🗄️' }[lang] || lang;
                    return `💻 **${item.name} in ${langName}:**\n\n${code}`;
                }
            }
        }

        // ===== Language-specific quick references =====
        if (lower.includes('javascript') || lower.includes(' js ') || lower.includes(' js')) {
            return `💻 **JavaScript Quick Reference:**\n\n**Variables:**\n\`\`\`javascript\nlet name = "World";\nconst PI = 3.14159;\n\`\`\`\n\n**Functions:**\n\`\`\`javascript\nfunction greet(n) { return "Hello " + n; }\nconst add = (a, b) => a + b;\n\`\`\`\n\n**Arrays:**\n\`\`\`javascript\nconst arr = [1, 2, 3];\narr.map(x => x * 2);\n\`\`\`\n\n💡 *Ask for specific logic like "reverse a string" or "fibonacci"*`;
        }

        if (lower.includes('python')) {
            return `🐍 **Python Quick Reference:**\n\n**Basics:**\n\`\`\`python\nname = "Alice"\nprint(f"Hello {name}")\n\`\`\`\n\n**Lists:**\n\`\`\`python\nnums = [1, 2, 3]\ndoubled = [x * 2 for x in nums]\n\`\`\`\n\n**Functions:**\n\`\`\`python\ndef add(a, b):\n    return a + b\n\`\`\`\n\n💡 *Try asking for "calculator", "prime check", or "sort a list"*`;
        }

        // ... intermediate language checks remain similar but cleaner ...
        const refs = {
            html: '🌐 **HTML/CSS:**\n\`\`\`html\n<div class="box">Hello</div>\n<style>.box { color: red; }</style>\n\`\`\`',
            typescript: '🔷 **TypeScript:**\n\`\`\`typescript\ninterface User { id: number; name: string; }\nfunction greet(u: User) { return u.name; }\n\`\`\`',
            react: '⚛️ **React:**\n\`\`\`jsx\nfunction Btn() {\n  const [c, setC] = useState(0);\n  return <button onClick={() => setC(c+1)}>{c}</button>;\n}\n\`\`\`',
            cpp: '⚙️ **C++:**\n\`\`\`cpp\n#include <iostream>\nint main() { std::cout << "Hello"; return 0; }\n\`\`\`',
            sql: '🗄️ **SQL:**\n\`\`\`sql\nSELECT * FROM users WHERE active = 1;\nUPDATE users SET score = 100;\n\`\`\`',
            rust: '🦀 **Rust:**\n\`\`\`rust\nfn main() { println!("Hello"); }\n\`\`\`',
            go: '🐹 **Go:**\n\`\`\`go\nfunc main() { fmt.Println("Hello") }\n\`\`\''
        };

        if (refs[lang]) return refs[lang];

        return `💻 **Code Help (Offline Mode):**\n\nI can generate logic, patterns, and full programs for **9+ languages**.\n\n**Just ask what you need, for example:**\n- *"print numbers from 1 to 50"*\n- *"how to reverse an array in python"*\n- *"javascript function for factorial"*\n- *"binary search algorithm"*\n\nFor complex architectural design, switch to **Online Mode** (🔄).`;
    },

    // ===== Fuzzy Language Detection (handles common typos) =====
    detectFuzzyLanguage(text) {
        const typoMap = {
            'python': ['pyhton', 'pyhon', 'pythn', 'pyton', 'pytho', 'phyton', 'pthon', 'pythom', 'pytohn'],
            'javascript': ['javscript', 'javascrpt', 'javasript', 'javacript', 'javascirpt', 'javscript', 'jvascript', 'javascrit', 'javasript'],
            'typescript': ['typscript', 'typescrpt', 'typesript', 'tyepscript', 'typescipt'],
            'java': ['jav', 'jawa'],
            'cpp': ['c ++', 'cplusplus', 'c plus plus'],
            'html': ['htm', 'htlm'],
            'css': ['ccs', 'csss'],
            'react': ['raect', 'reat'],
            'sql': ['sqll', 'sequel'],
            'rust': ['rrust', 'ruust'],
            'go': ['goland', 'gollang']
        };
        for (const [lang, typos] of Object.entries(typoMap)) {
            if (typos.some(t => text.includes(t))) return lang;
        }
        return null;
    },

    // ===== Smart code request detection =====
    isCodeRequest(text) {
        // Patterns: "give me X in Y", "write X in Y", "how to X in Y", "X in python", "create a X"
        const codePatterns = [
            /(?:give|write|create|make|build|show|code)\s+(?:me\s+)?(?:a\s+|an\s+)?(.+?)\s+(?:in|using|with)\s+(\w+)/i,
            /(?:how\s+to|how\s+do\s+(?:i|you|we))\s+(.+?)\s+(?:in|using|with)\s+(\w+)/i,
            /(.+?)\s+(?:in|using)\s+(?:python|javascript|java|c\+\+|typescript|html|css|rust|go|sql|react|node)/i,
            /(?:print|display|output|loop|iterate|add|subtract|multiply|divide|sort|reverse|search|find|check|validate|calculate)/i
        ];
        return codePatterns.some(p => p.test(text));
    },

    dynamicGenerate(text, lang) {
        const lower = text.toLowerCase();

        // 1. Numeric Range Patterns ("1 to 10", "1 to 100", etc)
        const rangeMatch = lower.match(/(\d+)\s+(?:to|until)\s+(\d+)/);
        if (rangeMatch && (lower.includes('print') || lower.includes('loop') || lower.includes('numbers'))) {
            const start = rangeMatch[1];
            const end = rangeMatch[2];
            if (lang === 'python') return `🐍 **Range Loop (Python):**\n\n\`\`\`python\n# Print numbers from ${start} to ${end}\nfor i in range(${start}, ${parseInt(end) + 1}):\n    print(i)\n\`\`\``;
            if (lang === 'javascript') return `🟨 **Range Loop (JS):**\n\n\`\`\`javascript\n// Print numbers from ${start} to ${end}\nfor (let i = ${start}; i <= ${end}; i++) {\n    console.log(i);\n}\n\`\`\``;
            if (lang === 'java' || lang === 'cpp') return `☕ **Loop (${lang.toUpperCase()}):**\n\n\`\`\`${lang}\nfor (int i = ${start}; i <= ${end}; i++) {\n    cout << i << " ";\n}\n\`\`\``;
        }

        // 2. Logic Synthesizer (Combine "function" + "logic")
        const isFunc = lower.includes('function') || lower.includes('def ') || lower.includes('method');
        const logics = [
            { key: 'reverse', name: 'Reverse', py: 's[::-1]', js: 's.split("").reverse().join("")' },
            { key: 'sum', name: 'Sum', py: 'sum(data)', js: 'data.reduce((a, b) => a + b, 0)' },
            { key: 'max', name: 'Maximum', py: 'max(data)', js: 'Math.max(...data)' },
            { key: 'min', name: 'Minimum', py: 'min(data)', js: 'Math.min(...data)' },
            { key: 'even', name: 'Even/Odd', py: 'n % 2 == 0', js: 'n % 2 === 0' },
        ];

        for (const logic of logics) {
            if (lower.includes(logic.key)) {
                if (isFunc) {
                    if (lang === 'python') return `🐍 **${logic.name} Function (Python):**\n\n\`\`\`python\ndef get_${logic.key}(data):\n    return ${logic.py}\n\nprint(get_${logic.key}([1, 2, 3]))\n\`\`\``;
                    if (lang === 'javascript') return `🟨 **${logic.name} Function (JS):**\n\n\`\`\`javascript\nconst ${logic.key} = (data) => ${logic.js};\n\nconsole.log(${logic.key}([1, 2, 3]));\n\`\`\``;
                }
            }
        }

        // 3. Arithmetic operations ("add two numbers", "subtract", "multiply", "divide")
        if (lower.includes('add') || lower.includes('addition') || lower.includes('sum of') || lower.includes('two numbers')) {
            if (lang === 'python') return `🐍 **Add Two Numbers (Python):**\n\n\`\`\`python\ndef add(a, b):\n    return a + b\n\n# Example\nnum1 = int(input("Enter first number: "))\nnum2 = int(input("Enter second number: "))\nprint(f"{num1} + {num2} = {add(num1, num2)}")\n\`\`\``;
            if (lang === 'javascript') return `🟨 **Add Two Numbers (JavaScript):**\n\n\`\`\`javascript\nfunction add(a, b) {\n    return a + b;\n}\n\n// Example\nconst num1 = 10, num2 = 20;\nconsole.log(\`\${num1} + \${num2} = \${add(num1, num2)}\`);\n\`\`\``;
            if (lang === 'java') return `☕ **Add Two Numbers (Java):**\n\n\`\`\`java\nimport java.util.Scanner;\n\npublic class Add {\n    public static int add(int a, int b) {\n        return a + b;\n    }\n    public static void main(String[] args) {\n        Scanner sc = new Scanner(System.in);\n        System.out.print("Enter first number: ");\n        int a = sc.nextInt();\n        System.out.print("Enter second number: ");\n        int b = sc.nextInt();\n        System.out.println(a + " + " + b + " = " + add(a, b));\n    }\n}\n\`\`\``;
            if (lang === 'cpp') return `⚙️ **Add Two Numbers (C++):**\n\n\`\`\`cpp\n#include <iostream>\nusing namespace std;\n\nint add(int a, int b) { return a + b; }\n\nint main() {\n    int a, b;\n    cout << "Enter two numbers: ";\n    cin >> a >> b;\n    cout << a << " + " << b << " = " << add(a, b) << endl;\n    return 0;\n}\n\`\`\``;
            return `💻 **Add Two Numbers (${lang}):**\n\n\`\`\`${lang}\n// Addition function\nfunction add(a, b) {\n    return a + b;\n}\n\`\`\``;
        }

        if (lower.includes('subtract') || lower.includes('subtraction') || lower.includes('minus')) {
            if (lang === 'python') return `🐍 **Subtract (Python):**\n\n\`\`\`python\ndef subtract(a, b):\n    return a - b\n\nprint(subtract(10, 3))  # 7\n\`\`\``;
            if (lang === 'javascript') return `🟨 **Subtract (JavaScript):**\n\n\`\`\`javascript\nconst subtract = (a, b) => a - b;\nconsole.log(subtract(10, 3)); // 7\n\`\`\``;
        }

        if (lower.includes('multiply') || lower.includes('multiplication') || lower.includes('product')) {
            if (lang === 'python') return `🐍 **Multiply (Python):**\n\n\`\`\`python\ndef multiply(a, b):\n    return a * b\n\nprint(multiply(5, 4))  # 20\n\`\`\``;
            if (lang === 'javascript') return `🟨 **Multiply (JavaScript):**\n\n\`\`\`javascript\nconst multiply = (a, b) => a * b;\nconsole.log(multiply(5, 4)); // 20\n\`\`\``;
        }

        if (lower.includes('divide') || lower.includes('division') || lower.includes('quotient')) {
            if (lang === 'python') return `🐍 **Divide (Python):**\n\n\`\`\`python\ndef divide(a, b):\n    if b == 0:\n        return "Cannot divide by zero!"\n    return a / b\n\nprint(divide(20, 4))  # 5.0\n\`\`\``;
            if (lang === 'javascript') return `🟨 **Divide (JavaScript):**\n\n\`\`\`javascript\nfunction divide(a, b) {\n    if (b === 0) return "Cannot divide by zero!";\n    return a / b;\n}\nconsole.log(divide(20, 4)); // 5\n\`\`\``;
        }

        // 4. String formatting/conversions
        if (lower.includes('upper') || lower.includes('capitalize')) {
            if (lang === 'python') return `🐍 **Uppercase (Python):**\n\n\`\`\`python\ntext = "hello"\nprint(text.upper())\n\`\`\``;
            if (lang === 'javascript') return `🟨 **Uppercase (JS):**\n\n\`\`\`javascript\nlet text = "hello";\nconsole.log(text.toUpperCase());\n\`\`\``;
        }

        return null; // Fall back to snippets or references
    },

    countAnalysis(text) {
        const words = text.split(/\s+/).filter(w => w.length > 0);
        const chars = text.length;
        const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
        return `📊 **Text Analysis:**\n- **Words:** ${words.length}\n- **Characters:** ${chars}\n- **Sentences:** ${sentences.length}\n- **Avg word length:** ${(text.replace(/\s/g, '').length / Math.max(words.length, 1)).toFixed(1)} chars`;
    },

    smartFallback(text) {
        // Try fuzzy matching against definitions
        const words = text.toLowerCase().split(/\s+/).filter(w => w.length > 3);
        const defs = this.defineWord.__defs || {};
        // Check if any word matches a definition key
        for (const w of words) {
            const testResult = this.defineWord('what is ' + w);
            if (testResult && !testResult.includes("don't have")) return testResult;
        }
        return `🤖 I'm in **Enhanced Offline Mode** — I couldn't match that exactly.\n\n**Try these:**\n- 🔢 Math: *"25 * 4"*, *"sin(45)"*, *"factorial 10"*\n- 🔄 Convert: *"100 km to miles"*, *"30 C to F"*\n- 📖 Define: *"What is an API?"*\n- 💻 Code: *"javascript"*, *"python"*, *"typescript"*\n- 🎲 Random: *"generate password"*, *"flip coin"*\n- 📊 Analyze: *"analyze: your text here"*\n- 📄 Files: Upload .txt, .csv, or .json\n\n**For ANY question** → Switch to **Online Mode** 🔄`;
    },

    // ===== File Handling =====
    processFile(userText, file) {
        if (file.isImage) {
            return `🖼️ **Image: ${file.name}**\n\nImage analysis needs **Online Mode** (Gemini API). Switch via 🔄 Switch Mode!`;
        }
        if (file.isPdf) {
            return `📕 **PDF: ${file.name}** (${this.formatSize(file.size)})\n\nPDF analysis needs **Online Mode**. Switch via 🔄 Switch Mode!`;
        }
        if (file.isText) return this.analyzeTextFile(userText, file);
        return `📎 **${file.name}** — This file type needs **Online Mode** for analysis.`;
    },

    analyzeTextFile(userText, file) {
        const content = file.data;
        const name = file.name;
        if (name.endsWith('.json')) return this.analyzeJSON(content, name);
        if (name.endsWith('.csv')) return this.analyzeCSV(content, name);
        return this.analyzeText(content, name);
    },

    analyzeJSON(content, name) {
        try {
            const data = JSON.parse(content);
            const type = Array.isArray(data) ? 'Array' : typeof data;
            let info = `📊 **JSON Analysis: ${name}**\n\n- **Type:** ${type}\n`;
            if (Array.isArray(data)) {
                info += `- **Items:** ${data.length}\n`;
                if (data.length > 0 && typeof data[0] === 'object') {
                    const keys = Object.keys(data[0]);
                    info += `- **Fields:** ${keys.join(', ')}\n`;
                    info += `\n**Sample:**\n\`\`\`json\n${JSON.stringify(data[0], null, 2).substring(0, 500)}\n\`\`\``;
                }
            } else if (typeof data === 'object') {
                const keys = Object.keys(data);
                info += `- **Keys (${keys.length}):** ${keys.slice(0, 15).join(', ')}${keys.length > 15 ? '...' : ''}\n`;
                info += `\n**Preview:**\n\`\`\`json\n${JSON.stringify(data, null, 2).substring(0, 500)}\n\`\`\``;
            }
            return info;
        } catch (e) {
            return `❌ **Invalid JSON** in ${name}: ${e.message}`;
        }
    },

    analyzeCSV(content, name) {
        const lines = content.split('\n').filter(l => l.trim());
        const headers = lines[0] ? lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, '')) : [];
        let info = `📊 **CSV Analysis: ${name}**\n\n- **Rows:** ${lines.length - 1} (+ header)\n- **Columns:** ${headers.length}\n- **Headers:** ${headers.join(', ')}\n`;
        if (lines.length > 1) {
            info += `\n**First 3 rows:**\n\`\`\`\n${lines.slice(0, 4).join('\n')}\n\`\`\``;
        }
        return info;
    },

    analyzeText(content, name) {
        const words = content.split(/\s+/).filter(w => w.length > 0);
        const lines = content.split('\n');
        const sentences = content.split(/[.!?]+/).filter(s => s.trim().length > 0);

        let info = `📄 **Text Analysis: ${name}**\n\n**📊 Stats:**\n- Words: **${words.length.toLocaleString()}**\n- Lines: **${lines.length.toLocaleString()}**\n- Sentences: **${sentences.length.toLocaleString()}**\n- Characters: **${content.length.toLocaleString()}**\n\n`;

        if (sentences.length > 2) {
            info += `**📝 Key Points:**\n\n`;
            const top = this.extractiveSummary(content, 5);
            top.forEach((s, i) => { info += `${i + 1}. ${s.trim()}\n`; });
        } else {
            info += `**📝 Content:**\n${content.substring(0, 500)}${content.length > 500 ? '...' : ''}`;
        }

        // Top keywords
        const freq = {};
        const stopWords = new Set(['that', 'this', 'with', 'from', 'have', 'been', 'they', 'will', 'would', 'could', 'should', 'about', 'their', 'there', 'which', 'were', 'what', 'when', 'your', 'than', 'them', 'then', 'also', 'into', 'some', 'these', 'just', 'like', 'very', 'more', 'most', 'only', 'other', 'over', 'does', 'each', 'much', 'many', 'such']);
        words.forEach(w => {
            const c = w.toLowerCase().replace(/[^a-z0-9]/g, '');
            if (c.length > 3 && !stopWords.has(c)) freq[c] = (freq[c] || 0) + 1;
        });
        const topWords = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 8);
        if (topWords.length > 0) {
            info += `\n\n**🔑 Keywords:** ${topWords.map(([w, c]) => `*${w}*(${c})`).join(', ')}`;
        }

        return info;
    },

    extractiveSummary(text, n) {
        const sentences = text.split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 10);
        if (sentences.length <= n) return sentences;

        const words = text.toLowerCase().split(/\s+/);
        const freq = {};
        words.forEach(w => {
            const c = w.replace(/[^a-z0-9]/g, '');
            if (c.length > 3) freq[c] = (freq[c] || 0) + 1;
        });

        const scored = sentences.map((s, idx) => {
            const sWords = s.toLowerCase().split(/\s+/);
            let score = 0;
            sWords.forEach(w => { score += freq[w.replace(/[^a-z0-9]/g, '')] || 0; });
            if (idx === 0) score *= 1.5;
            if (idx === sentences.length - 1) score *= 1.2;
            score /= Math.max(sWords.length, 1);
            return { sentence: s, score, idx };
        });

        return scored.sort((a, b) => b.score - a.score).slice(0, n).sort((a, b) => a.idx - b.idx).map(s => s.sentence);
    },

    summarizeText(text) {
        const sentences = text.split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 10);
        if (sentences.length === 0) return `I received your text but couldn't extract sentences to summarize.`;
        const summary = this.extractiveSummary(text, 3);
        let result = `📝 **Summary:**\n\n`;
        summary.forEach((s, i) => { result += `${i + 1}. ${s.trim()}\n`; });
        result += `\n*(${sentences.length} sentences analyzed)*`;
        return result;
    },

    formatSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / 1048576).toFixed(1) + ' MB';
    }
};

// ===== Offline AI Call =====
async function callOfflineAI(userText, file) {
    isProcessing = true;
    chatSend.disabled = true;
    statusText.textContent = 'Local AI thinking...';
    showTypingIndicator();

    await new Promise(r => setTimeout(r, 300 + Math.random() * 600));

    removeTypingIndicator();
    const response = OfflineAI.respond(userText, file);
    addBotMessage(response);

    conversationHistory.push({ role: 'user', parts: [{ text: userText }] });
    conversationHistory.push({ role: 'model', parts: [{ text: response }] });
    if (conversationHistory.length > MAX_HISTORY) conversationHistory = conversationHistory.slice(-MAX_HISTORY);

    updateModeUI();
    isProcessing = false;
    chatSend.disabled = false;
}

// ===== Backend API Call (Online Mode) =====
async function callBackendAPI(userText, file) {
    isProcessing = true;
    chatSend.disabled = true;
    statusText.textContent = 'AI thinking...';
    showTypingIndicator();

    let filePayload = null;
    if (file) {
        filePayload = {
            name: file.name, type: file.type, size: file.size,
            isImage: file.isImage || false, isPdf: file.isPdf || false,
            isText: file.isText || false, data: file.data
        };
    }

    try {
        const token = typeof getIdToken === 'function' ? await getIdToken() : null;
        if (!token) {
            removeTypingIndicator();
            addBotMessage("\ud83d\udd11 **Authentication error.** Please sign out and sign back in.");
            isProcessing = false;
            chatSend.disabled = false;
            return;
        }

        const response = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ message: userText, file: filePayload, history: conversationHistory.slice(-10) })
        });

        removeTypingIndicator();

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            addBotMessage(`\u274c **Error:** ${errorData.error || 'Server returned ' + response.status}`);
            isProcessing = false;
            chatSend.disabled = false;
            return;
        }

        const data = await response.json();
        const aiText = data.reply || "I couldn't generate a response. Please try again.";

        conversationHistory.push({ role: 'user', parts: [{ text: userText }] });
        conversationHistory.push({ role: 'model', parts: [{ text: aiText }] });
        if (conversationHistory.length > MAX_HISTORY) conversationHistory = conversationHistory.slice(-MAX_HISTORY);

        addBotMessage(aiText);
        updateModeUI();
    } catch (error) {
        removeTypingIndicator();
        if (error.message && (error.message.includes('Failed to fetch') || error.message.includes('NetworkError'))) {
            addBotMessage("\ud83c\udf10 **Can't reach the server.** Make sure the backend is running, or switch to **Offline Mode**.");
        } else {
            addBotMessage(`\u274c **Error:** ${error.message || 'Unknown error'}`);
        }
    }
    isProcessing = false;
    chatSend.disabled = false;
}

// ===== Message Display =====
function addBotMessage(content) {
    addRawMessage(formatMarkdown(content), 'bot');
}

function addRawMessage(htmlContent, type) {
    const msgDiv = document.createElement('div');
    msgDiv.className = `chat-msg ${type}`;

    const avatar = document.createElement('div');
    avatar.className = 'msg-avatar';
    avatar.textContent = type === 'bot' ? 'AI' : 'You';

    const contentDiv = document.createElement('div');
    contentDiv.className = 'msg-content';
    contentDiv.innerHTML = htmlContent;

    msgDiv.appendChild(avatar);
    msgDiv.appendChild(contentDiv);
    chatMessages.appendChild(msgDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function formatMarkdown(text) {
    // Protect code blocks from other replacements
    const codeBlocks = [];
    text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (m, lang, code) => {
        codeBlocks.push(`<pre class="code-block"><code>${escapeHtml(code.trim())}</code></pre>`);
        return `%%CB${codeBlocks.length - 1}%%`;
    });
    const inlineCodes = [];
    text = text.replace(/`([^`]+)`/g, (m, code) => {
        inlineCodes.push(`<code style="background:rgba(139,92,246,0.15);padding:2px 6px;border-radius:4px;font-size:0.85em;">${escapeHtml(code)}</code>`);
        return `%%IC${inlineCodes.length - 1}%%`;
    });
    text = text.replace(/^### (.+)$/gm, '<h4 style="margin:12px 0 6px;font-size:0.95rem;">$1</h4>');
    text = text.replace(/^## (.+)$/gm, '<h3 style="margin:14px 0 8px;font-size:1.05rem;">$1</h3>');
    text = text.replace(/^# (.+)$/gm, '<h2 style="margin:16px 0 10px;font-size:1.15rem;">$1</h2>');
    text = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/\*(.*?)\*/g, '<em>$1</em>');
    text = text.replace(/^[-*] (.+)$/gm, '<li>$1</li>');
    text = text.replace(/((<li>.*<\/li>(\n)?)+)/g, (m) => `<ul class="msg-list">${m}</ul>`);
    text = text.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
    text = text.replace(/\n/g, '<br>');
    codeBlocks.forEach((block, i) => { text = text.replace(`%%CB${i}%%`, block); });
    inlineCodes.forEach((code, i) => { text = text.replace(`%%IC${i}%%`, code); });
    if (!text.startsWith('<')) text = `<p>${text}</p>`;
    return text;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function showTypingIndicator() {
    const msgDiv = document.createElement('div');
    msgDiv.className = 'chat-msg bot';
    msgDiv.id = 'typing-msg';
    const avatar = document.createElement('div');
    avatar.className = 'msg-avatar';
    avatar.textContent = 'AI';
    const contentDiv = document.createElement('div');
    contentDiv.className = 'msg-content';
    contentDiv.innerHTML = `<div class="typing-indicator"><span></span><span></span><span></span></div>`;
    msgDiv.appendChild(avatar);
    msgDiv.appendChild(contentDiv);
    chatMessages.appendChild(msgDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function removeTypingIndicator() {
    const typing = document.getElementById('typing-msg');
    if (typing) typing.remove();
}
