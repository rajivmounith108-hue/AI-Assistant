const CACHE_NAME = 'ai-assistant-v15';
const ASSETS = [
    './',
    './index.html',
    './chat.html',
    './style.css',
    './script.js',
    './auth.js',
    './firebase-config.js'
];

// Install — cache core assets
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
    );
    self.skipWaiting();
});

// Activate — clean old caches
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
        )
    );
    self.clients.claim();
});

// Fetch — NETWORK-FIRST for everything (so updates are always fresh)
self.addEventListener('fetch', (event) => {
    const { request } = event;
    if (request.method !== 'GET') return;

    // Don't cache API requests, model downloads, backend calls, or Firebase Storage
    if (request.url.includes('generativelanguage.googleapis.com') ||
        request.url.includes('api.groq.com') ||
        request.url.includes('/api/') ||
        request.url.includes('huggingface.co') ||
        request.url.includes('raw.githubusercontent.com') ||
        request.url.includes('cdn.jsdelivr.net')) { return; }

    // Network-first for ALL requests — try network, fall back to cache
    event.respondWith(
        fetch(request)
            .then((response) => {
                // Update the cache with the fresh response
                const clone = response.clone();
                caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
                return response;
            })
            .catch(() => {
                // Network failed — serve from cache (offline support)
                return caches.match(request);
            })
    );
});
