// ===== Firebase Configuration =====
// INSTRUCTIONS: Replace the values below with your Firebase project config.
// Get it from: Firebase Console → Project Settings → General → Your apps → Web app → Config

const firebaseConfig = {
    apiKey: "AIzaSyBwySkysBGRm3idL8Qi2ofh9Xj_KuFai48",
    authDomain: "ai-assistant-9de18.firebaseapp.com",
    projectId: "ai-assistant-9de18",
    storageBucket: "ai-assistant-9de18.firebasestorage.app",
    messagingSenderId: "414164947533",
    appId: "1:414164947533:web:e09cbdd7b60e97e1ec0204",
    measurementId: "G-0FBEHV1LV9"
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();

// Firestore is only available on pages that load the Firestore SDK (chat.html)
const db = typeof firebase.firestore === 'function' ? firebase.firestore() : null;

// Enable offline persistence for Firestore (chat history works offline too)
if (db) {
    db.enablePersistence({ synchronizeTabs: true }).catch((err) => {
        if (err.code === 'failed-precondition') {
            console.warn('Firestore persistence: Multiple tabs open');
        } else if (err.code === 'unimplemented') {
            console.warn('Firestore persistence: Browser not supported');
        }
    });
}
