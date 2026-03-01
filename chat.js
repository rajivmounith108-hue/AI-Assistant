const admin = require('firebase-admin');

// Lazy init Firebase Admin
let adminInitialized = false;
function initAdmin() {
    if (adminInitialized) return;
    admin.initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID });
    adminInitialized = true;
}

// API Keys from env
const getGeminiKeys = () => (process.env.GEMINI_API_KEYS || '').split(',').map(k => k.trim()).filter(k => k.length > 5);
const getGroqKey = () => process.env.GROQ_API_KEY || '';

const GEMINI_MODELS = ['gemma-3-27b-it', 'gemma-3-12b-it', 'gemma-3-4b-it', 'gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-flash'];
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models/';
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';

let currentKeyIndex = 0;
let currentModelIndex = 0;

module.exports = async (req, res) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    initAdmin();

    // Verify auth token
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing authorization' });
    }
    try {
        await admin.auth().verifyIdToken(authHeader.split('Bearer ')[1]);
    } catch {
        return res.status(401).json({ error: 'Invalid token' });
    }

    const { message, file, history } = req.body;
    if (!message && !file) return res.status(400).json({ error: 'Message or file required' });

    const GEMINI_API_KEYS = getGeminiKeys();
    const GROQ_API_KEY = getGroqKey();

    if (GEMINI_API_KEYS.length === 0 && !GROQ_API_KEY) {
        return res.status(500).json({ error: 'No API keys configured' });
    }

    // Try Gemini
    if (GEMINI_API_KEYS.length > 0) {
        const result = await tryGemini(message, file, history || [], GEMINI_API_KEYS);
        if (result.success) return res.json({ reply: result.text, provider: 'gemini' });
    }

    // Fallback to Groq
    if (GROQ_API_KEY) {
        const result = await tryGroq(message, file, history || [], GROQ_API_KEY);
        if (result.success) return res.json({ reply: result.text, provider: 'groq' });
        return res.status(502).json({ error: 'All AI providers failed: ' + result.error });
    }

    return res.status(502).json({ error: 'All AI providers unavailable' });
};

async function tryGemini(message, file, history, keys) {
    const totalAttempts = keys.length * GEMINI_MODELS.length;
    for (let attempt = 0; attempt < totalAttempts; attempt++) {
        const key = keys[currentKeyIndex % keys.length];
        const model = GEMINI_MODELS[currentModelIndex % GEMINI_MODELS.length];
        const url = `${GEMINI_BASE_URL}${model}:generateContent?key=${key}`;

        const parts = [];
        if (file) {
            if (file.isImage || file.isPdf) {
                parts.push({ inline_data: { mime_type: file.type, data: file.data } });
            } else if (file.isText) {
                parts.push({ text: `[File: ${file.name}]\n\n${file.data.substring(0, 100000)}\n\n---\n\n` });
            }
        }
        parts.push({ text: message });

        const contents = [];
        if (history.length > 0) history.slice(-10).forEach(turn => contents.push(turn));
        contents.push({ role: 'user', parts });

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contents, generationConfig: { temperature: 0.7, topK: 40, topP: 0.95, maxOutputTokens: 8192 } })
            });
            if (response.ok) {
                const data = await response.json();
                const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
                if (text) return { success: true, text };
            }
            const status = response.status;
            if (status === 401 || status === 403) { currentKeyIndex = (currentKeyIndex + 1) % keys.length; continue; }
            if (status === 429) {
                currentKeyIndex = (currentKeyIndex + 1) % keys.length;
                if ((attempt + 1) % keys.length === 0) currentModelIndex = (currentModelIndex + 1) % GEMINI_MODELS.length;
                continue;
            }
            const err = await response.json().catch(() => ({}));
            return { success: false, error: err?.error?.message || `HTTP ${status}` };
        } catch (err) {
            return { success: false, error: err.message || 'Network error' };
        }
    }
    return { success: false, error: 'All Gemini keys rate-limited' };
}

async function tryGroq(message, file, history, apiKey) {
    const messages = [{ role: 'system', content: 'You are a helpful AI assistant. Use markdown for formatting.' }];
    history.slice(-10).forEach(turn => {
        messages.push({ role: turn.role === 'model' ? 'assistant' : 'user', content: turn.parts.map(p => p.text).join('') });
    });
    let content = message;
    if (file && file.isText) content = `[File: ${file.name}]\n\n${file.data.substring(0, 50000)}\n\n---\n\n${message}`;
    messages.push({ role: 'user', content });

    try {
        const response = await fetch(GROQ_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({ model: GROQ_MODEL, messages, temperature: 0.7, max_tokens: 4096 })
        });
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            return { success: false, error: err?.error?.message || `HTTP ${response.status}` };
        }
        const data = await response.json();
        const text = data?.choices?.[0]?.message?.content;
        return text ? { success: true, text } : { success: false, error: 'No response' };
    } catch (err) {
        return { success: false, error: err.message || 'Network error' };
    }
}
