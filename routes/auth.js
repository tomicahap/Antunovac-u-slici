/**
 * Google OAuth 2.0 rute – authorization code flow.
 * client_secret se NIKAD ne izlaže frontendu.
 * Refresh token se enkriptira i pohranjuje u cookie sesiji.
 */

const express = require('express');
const router = express.Router();
const { createOAuth2Client } = require('../utils/driveClient');
const { encrypt, decrypt } = require('../utils/encryption');

// Google Drive & profile scope-ovi
const SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/userinfo.email'
];

// ─── GET /api/auth/url ────────────────────────────────────────────────────────
// Generira Google OAuth URL i šalje ga frontendu
router.get('/url', (req, res) => {
  try {
    const oauth2Client = createOAuth2Client(req.session);
    const url = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
      prompt: 'consent',
      include_granted_scopes: true
    });
    res.json({ url });
  } catch (err) {
    console.error('[Auth] Greška pri generiranju URL-a:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// ─── GET /api/auth/callback ──────────────────────────────────────────────────
// Google preusmjerava ovdje nakon odobrenja; razmjena koda za tokene
router.get('/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    console.error('[Auth] OAuth greška:', error);
    return res.redirect('/?auth_error=' + encodeURIComponent(error));
  }

  if (!code) {
    return res.redirect('/?auth_error=missing_code');
  }

  try {
    const oauth2Client = createOAuth2Client(req.session);
    const { tokens } = await oauth2Client.getToken(code);

    if (!tokens.refresh_token) {
      console.warn('[Auth] Refresh token nije dobiven. Možda korisnik već ima aktivnu sesiju.');
    }

    if (tokens.refresh_token) {
      req.session.encryptedRefreshToken = encrypt(tokens.refresh_token);
    }
    req.session.accessToken = tokens.access_token;
    req.session.tokenExpiry = tokens.expiry_date;

    oauth2Client.setCredentials(tokens);
    const { google } = require('googleapis');
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const userInfo = await oauth2.userinfo.get();
    
    req.session.userEmail = userInfo.data.email;
    req.session.userName = userInfo.data.name;
    req.session.userPicture = userInfo.data.picture;

    // ─── DEFINICIJA ADMINISTRATORSKE E-MAIL ADRESE ────────────────────────────
    // Administratorska e-mail adresa se čita iz .env datoteke (ADMIN_EMAIL)
    // ili koristi zadani fallback e-mail ispod.
    const adminEmailsEnv = process.env.ADMIN_EMAIL || 'tomica.hap@gmail.com,tomicahap@gmail.com';
    const adminEmails = adminEmailsEnv.toLowerCase().split(',').map(e => e.trim());
    const userEmail = (userInfo.data.email || '').toLowerCase();

    if (adminEmails.includes(userEmail)) {
      req.session.isAdminSession = true;
      console.log(`[Auth] Uspješna autorizacija administratora: ${userEmail}`);
      
      // Spremi globalni admin session za posjetitelje
      global.adminSession = {
        encryptedRefreshToken: req.session.encryptedRefreshToken,
        accessToken: req.session.accessToken,
        tokenExpiry: req.session.tokenExpiry,
        userEmail: req.session.userEmail,
        userName: req.session.userName,
        userPicture: req.session.userPicture
      };

      try {
        const fs = require('fs');
        const path = require('path');
        const dataDir = path.join(__dirname, '..', 'data');
        if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(
          path.join(dataDir, 'admin_session.json'),
          JSON.stringify(global.adminSession, null, 2)
        );
        console.log('[Auth] Admin sesija spremljena na disk za posjetitelje.');
      } catch (e) {
        console.error('[Auth] Greška pri spremanju admin sesije na disk:', e.message);
      }
    } else {
      req.session.isAdminSession = false;
      console.warn(`[Auth] Korisnik ${userEmail} je prijavljen, ali nema admin privilegije (očekivano: ${adminEmails.join(', ')}).`);
      // Vrati poruku o ograničenom pristupu
      return res.redirect('/?auth_success=1&warning=no_admin');
    }

    res.redirect('/?auth_success=1');
  } catch (err) {
    console.error('[Auth] Greška pri razmjeni koda:', err.message);
    res.redirect('/?auth_error=' + encodeURIComponent(err.message));
  }
});

// ─── GET /api/auth/status ────────────────────────────────────────────────────
// Provjera je li korisnik autentificiran
router.get('/status', (req, res) => {
  const isAdmin = !!(req.session && req.session.isAdminSession);
  const isDriveConnected = !!(req.session && req.session.encryptedRefreshToken) || !!global.adminSession;
  
  let refreshToken = null;
  if (isAdmin) {
    if (req.session.encryptedRefreshToken) {
      try { refreshToken = decrypt(req.session.encryptedRefreshToken); } catch {}
    } else if (global.adminSession && global.adminSession.encryptedRefreshToken) {
      try { refreshToken = decrypt(global.adminSession.encryptedRefreshToken); } catch {}
    } else if (process.env.GOOGLE_REFRESH_TOKEN) {
      refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
    }
  }

  res.json({
    authenticated: isAdmin,
    driveConnected: isDriveConnected,
    user: isAdmin ? {
      email: req.session.userEmail || 'admin@antunovac.hr',
      name: req.session.userName || 'Administrator',
      picture: req.session.userPicture || null
    } : null,
    refreshToken: refreshToken
  });
});

// ─── POST /api/auth/admin-login ──────────────────────────────────────────────
// Izravna prijava u Admin način rada
router.post('/admin-login', (req, res) => {
  if (!req.session) req.session = {};
  req.session.isAdminSession = true;
  req.session.userName = 'Administrator';
  res.json({ success: true, message: 'Prijavljeni ste kao Administrator.' });
});

// ─── POST /api/auth/oauth-config ─────────────────────────────────────────────
// Učitavanje klijentskog OAuth 2.0 JSON-a
router.post('/oauth-config', (req, res) => {
  try {
    const { oauthConfig } = req.body;
    if (!oauthConfig) {
      return res.status(400).json({ error: 'Nedostaje JSON datoteka.' });
    }

    let parsed = oauthConfig;
    if (typeof oauthConfig === 'string') {
      try {
        parsed = JSON.parse(oauthConfig);
      } catch {
        return res.status(400).json({ error: 'Nevažeći JSON format.' });
      }
    }

    // 1. Ako je Service Account JSON:
    if (parsed.client_email && parsed.private_key) {
      req.session.serviceAccountConfig = {
        client_email: parsed.client_email,
        private_key: parsed.private_key,
        project_id: parsed.project_id
      };
      req.session.isAdminSession = true;
      req.session.userName = 'Administrator (Service Account)';
      req.session.userEmail = parsed.client_email;

      return res.json({
        success: true,
        type: 'service_account',
        message: 'Google Service Account JSON uspješno učitan! Spojeni ste direktno.'
      });
    }

    // 2. Ako je klijentski OAuth JSON:
    const creds = parsed.web || parsed.installed || parsed;
    const clientId = creds.client_id;
    const clientSecret = creds.client_secret;
    const redirectUris = creds.redirect_uris || [];

    if (!clientId || !clientSecret) {
      return res.status(400).json({ error: 'Nevažeći JSON: nedostaje client_id/client_secret za OAuth ili client_email/private_key za Service Account.' });
    }

    req.session.oauthConfig = {
      clientId,
      clientSecret,
      redirectUri: redirectUris[0] || 'http://localhost:3000/api/auth/callback'
    };

    res.json({
      success: true,
      type: 'oauth_client',
      message: 'OAuth klijentska konfiguracija učitana.'
    });
  } catch (err) {
    console.error('[Auth] Greška pri obradi konfiguracije:', err.message);
    res.status(500).json({ error: 'Greška pri obradi konfiguracije.' });
  }
});

// ─── POST /api/auth/logout ───────────────────────────────────────────────────
// Brisanje sesije (logout)
router.post('/logout', (req, res) => {
  req.session = null; // cookie-session brisanje
  res.json({ success: true, message: 'Odjava uspješna.' });
});

// ─── POST /api/auth/credentials ──────────────────────────────────────────────
// Prima credentials.json / client_secret.json iz UI Postavki
// Parsira i validira – NIKAD ne sprema tajne u browser
router.post('/credentials', (req, res) => {
  try {
    const { credentials } = req.body;
    if (!credentials) {
      return res.status(400).json({ error: 'Nedostaju credentials.' });
    }

    // Parsiranje JSON-a ako je string
    let parsed = credentials;
    if (typeof credentials === 'string') {
      try {
        parsed = JSON.parse(credentials);
      } catch {
        return res.status(400).json({ error: 'Nevažeći JSON format.' });
      }
    }

    // Podržani formati: {web: {...}}, {installed: {...}}, ili direktni objekt
    const creds = parsed.web || parsed.installed || parsed;

    const clientId = creds.client_id;
    const clientSecret = creds.client_secret;
    const redirectUris = creds.redirect_uris || [];

    if (!clientId || !clientSecret) {
      return res.status(400).json({ error: 'Nevažeći credentials: nedostaje client_id ili client_secret.' });
    }

    // Pohrani credentials u env varijable (za ovu sesiju servera)
    // U produkciji, ovo bi trebalo ažurirati env ili koristiti drugi mehanizam
    // Za sada, informiramo korisnika da postavi env varijable
    res.json({
      success: true,
      message: 'Credentials validirani. Kopirajte client_id i client_secret u .env datoteku i restartajte server.',
      clientId: clientId,
      redirectUris: redirectUris
    });
  } catch (err) {
    console.error('[Auth] Greška pri obradi credentials:', err.message);
    res.status(500).json({ error: 'Greška pri obradi credentials.' });
  }
});

module.exports = router;
