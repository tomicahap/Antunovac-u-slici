require('dotenv').config();

// Zaobilaženje lokalnih SSL problema u development okruženju
if (process.env.NODE_ENV !== 'production') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  console.warn('⚠️ UPOZORENJE: NODE_TLS_REJECT_UNAUTHORIZED je postavljen na 0 zbog lokalnog razvoja.');
}

const express = require('express');
const cookieSession = require('cookie-session');
const path = require('path');

const authRoutes = require('./routes/auth');
const driveRoutes = require('./routes/drive');
const firebaseDb = require('./utils/firebase');

const APP_VERSION = '1.02';

// ─── Firebase verzija sync ───────────────────────────────────────────────────
(async () => {
  try {
    if (firebaseDb.isEnabled()) {
      const currentSettings = await firebaseDb.loadDoc('settings', 'app_settings') || {};
      if (currentSettings.appVersion !== APP_VERSION) {
        currentSettings.appVersion = APP_VERSION;
        await firebaseDb.saveDoc('settings', 'app_settings', currentSettings);
        console.log(`[Firebase] Verzija aplikacije ${APP_VERSION} upisana u bazu.`);
      }
    }
  } catch (err) {
    console.warn('[Firebase] Greška pri upisu verzije u bazu:', err.message);
  }
})();

const app = express();
const PORT = process.env.PORT || 3000;

// Povjerenje prema reverse proxyju (Render/Koyeb) za ispravno slanje secure cookieja preko HTTPS-a
app.set('trust proxy', 1);

// ─── Middleware ──────────────────────────────────────────────────────────────

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Stateless cookie-based session (nema potrebe za Redisom)
// Refresh token se enkriptira i sprema u HttpOnly cookie
app.use(cookieSession({
  name: 'agf_session',
  keys: [
    process.env.SESSION_SECRET || 'fallback-secret-CHANGE-IN-PRODUCTION',
    process.env.SESSION_SECRET_OLD || 'fallback-secret-old'
  ],
  maxAge: 30 * 24 * 60 * 60 * 1000, // 30 dana
  secure: process.env.NODE_ENV === 'production',
  httpOnly: true,
  sameSite: 'lax',
  overwrite: true
}));

// ─── API Rute ────────────────────────────────────────────────────────────────

app.use('/api/auth', authRoutes);
app.use('/api/drive', driveRoutes);

// Konfiguracija za frontend (Firebase config iz env varijabli)
app.get('/api/config', (req, res) => {
  res.json({
    firebase: {
      enabled: firebaseDb.isEnabled(),
      projectId: firebaseDb.isEnabled() ? (firebaseDb.db ? firebaseDb.db.projectId : 'firestore') : ''
    },
    googleClientId: process.env.GOOGLE_CLIENT_ID || '',
    appVersion: APP_VERSION
  });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Frontend Static Files ───────────────────────────────────────────────────

app.use('/thumbs', express.static(path.join(__dirname, 'thumbs')));
app.use(express.static(path.join(__dirname, 'public')));

// SPA fallback – sve nepoznate rute vraćaju index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Globalni error handler ──────────────────────────────────────────────────

app.use((err, req, res, next) => {
  console.error('[Server Error]', err.message);
  res.status(err.status || 500).json({
    error: err.message || 'Interna greška servera'
  });
});

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🚀 Server pokrenut na http://localhost:${PORT}`);
  console.log(`   Okolina: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   Firebase projekt: ${firebaseDb.isEnabled() ? firebaseDb.getProjectId() : '(nije konfiguriran)'}\n`);
});

module.exports = app;
