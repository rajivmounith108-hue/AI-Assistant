// ===== Firebase Authentication =====
// Handles Google sign-in, sign-out, and auth state management

const googleProvider = new firebase.auth.GoogleAuthProvider();
googleProvider.addScope('profile');
googleProvider.addScope('email');

// Sign in with Google
async function signInWithGoogle() {
    try {
        const result = await auth.signInWithPopup(googleProvider);
        // Force mode selection screen on fresh sign in
        localStorage.removeItem('app_mode');
        return result.user;
    } catch (error) {
        console.error('Google sign-in error:', error);
        // Handle specific errors
        if (error.code === 'auth/popup-closed-by-user') {
            throw new Error('Sign-in cancelled. Please try again.');
        } else if (error.code === 'auth/network-request-failed') {
            throw new Error('Network error. Check your internet connection.');
        } else {
            throw new Error(error.message || 'Sign-in failed. Please try again.');
        }
    }
}

// Sign out
async function signOutUser() {
    try {
        // Clear cached mode so next login asks for mode again
        localStorage.removeItem('app_mode');
        await auth.signOut();
        window.location.href = 'index.html';
    } catch (error) {
        console.error('Sign-out error:', error);
    }
}
window.signOutUser = signOutUser;

// Get current user's ID token (for backend API calls)
async function getIdToken() {
    const user = auth.currentUser;
    if (!user) return null;
    try {
        return await user.getIdToken();
    } catch (error) {
        console.error('Token error:', error);
        return null;
    }
}

// Auth state observer — use on pages that require login
function requireAuth(callback) {
    auth.onAuthStateChanged((user) => {
        if (user) {
            callback(user);
        } else {
            window.location.href = 'index.html';
        }
    });
}

// Auth state observer — use on login page
function redirectIfLoggedIn() {
    auth.onAuthStateChanged((user) => {
        if (user) {
            window.location.href = 'chat.html';
        }
    });
}
