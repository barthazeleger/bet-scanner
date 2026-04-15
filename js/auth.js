// ── AUTH ─────────────────────────────────────────────────────────────────────
let currentUser = null;
(function checkAuth() {
  const tok = localStorage.getItem('ep_token');
  if (!tok) { window.location.href = '/login.html'; return; }
  // Verify token once on load
  fetch('/api/auth/me', { headers: { 'Authorization': 'Bearer ' + tok } })
    .then(r => { if (!r.ok) { localStorage.removeItem('ep_token'); window.location.href = '/login.html'; return null; } return r.json(); })
    .then(u => { if (u) { currentUser = u; initUserUI(); } })
    .catch(() => {}); // network error → stay on page
})();

function getToken() { return localStorage.getItem('ep_token') || ''; }

// Authenticated fetch — automatically redirects to /login on 401
async function api(url, opts = {}) {
  opts.headers = { ...(opts.headers || {}), 'Authorization': 'Bearer ' + getToken() };
  if (opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData)) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  const r = await fetch(url, opts);
  if (r.status === 401) { localStorage.removeItem('ep_token'); window.location.href = '/login.html'; return null; }
  return r;
}

function logout() {
  localStorage.removeItem('ep_token');
  localStorage.removeItem('ep_user');
  window.location.href = '/login.html';
}

function initUserUI() {
  if (!currentUser) return;
  const emailEl = document.getElementById('user-email');
  if (emailEl) emailEl.textContent = currentUser.email;
  // Admin panel tonen
  if (currentUser.role === 'admin') {
    document.querySelectorAll('.admin-only').forEach(el => el.style.display = '');
  }
  // Laad gebruikersinstellingen
  loadUserSettings().then(() => applyLanguage());
  // Push notifications registreren
  registerPushNotifications();
}

async function registerPushNotifications() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');

    // v10.7.21: force SW update check op elke page-load zodat nieuwe deploys
    // zonder her-installatie doorkomen. Als er een nieuwe SW in waiting staat,
    // activeer hem en reload.
    reg.update().catch(() => {});
    reg.addEventListener('updatefound', () => {
      const newSw = reg.installing;
      if (!newSw) return;
      newSw.addEventListener('statechange', () => {
        if (newSw.state === 'installed' && navigator.serviceWorker.controller) {
          // Nieuwe SW klaar, force activate en reload
          newSw.postMessage({ type: 'SKIP_WAITING' });
        }
      });
    });
    // Reload zodra de nieuwe SW control overneemt
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloaded) return;
      reloaded = true;
      window.location.reload();
    });

    const existing = await reg.pushManager.getSubscription();
    if (existing) return; // al geregistreerd
    // Haal VAPID key op
    const { publicKey } = await api('/api/push/vapid-key').then(r => r?.json()) || {};
    if (!publicKey) return;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
    await api('/api/push/subscribe', { method: 'POST', body: sub.toJSON() });
    console.log('Push notifications geregistreerd');
  } catch (e) { console.warn('Push registratie mislukt:', e); }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}
