/**
 * Google Drive API klijent – factory funkcija.
 * Prima access token i vraća autentificirani Drive klijent.
 * Refresh tokeni su enkriptirani u sesiji i nikad ne odlaze na frontend.
 */

const { google } = require('googleapis');
const { decrypt } = require('./encryption');

/**
 * Kreira OAuth2 klijent. Prvo pokušava čitati iz sesije (ako je korisnik učitao OAuth JSON),
 * a zatim iz environment varijabli (kao fallback).
 * 
 * @param {Object} session - Express sesija
 */
function createOAuth2Client(session) {
  let clientId = process.env.GOOGLE_CLIENT_ID;
  let clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  let redirectUri = process.env.GOOGLE_REDIRECT_URI;

  if (session && session.oauthConfig) {
    clientId = session.oauthConfig.clientId || clientId;
    clientSecret = session.oauthConfig.clientSecret || clientSecret;
    if (!redirectUri) {
      redirectUri = session.oauthConfig.redirectUri;
    }
  }

  if (!redirectUri) {
    redirectUri = 'http://localhost:3000/api/auth/callback';
  }

  if (!clientId || !clientSecret) {
    throw new Error('Za prijavu na Google Drive prvo učitajte vaš client_secret.json (OAuth datoteku preuzetu s Google Cloud konzole).');
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

const fs = require('fs');
const path = require('path');
const sessionFile = path.join(__dirname, '..', 'data', 'admin_session.json');

// Učitaj administratorsku sesiju s diska na startu servera
if (fs.existsSync(sessionFile)) {
  try {
    global.adminSession = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    console.log('[DriveClient] Uspješno učitana admin sesija s diska.');
  } catch (err) {
    console.error('[DriveClient] Greška pri čitanju admin sesije s diska:', err.message);
  }
}

/**
 * Vraća autentificirani OAuth2 ili JWT (Service Account) klijent iz sesije.
 * Automatski osvježava access token ako je istekao.
 * 
 * @param {Object} session - Express sesija
 * @returns {Object} - Autentificirani klijent (OAuth2 ili JWT)
 * @throws {Error} - Ako korisnik nije autentificiran
 */
async function getAuthenticatedClient(session) {
  // 1. Podrška za Service Account (JWT)
  if (session && session.serviceAccountConfig) {
    const creds = session.serviceAccountConfig;
    const jwtClient = new google.auth.JWT(
      creds.client_email,
      null,
      creds.private_key,
      ['https://www.googleapis.com/auth/drive']
    );
    return jwtClient;
  }

  // 2. Podrška za okruženjske varijable Service Accounta (kao fallback)
  if (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    const privateKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY.replace(/\\n/g, '\n');
    const jwtClient = new google.auth.JWT(
      process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      null,
      privateKey,
      ['https://www.googleapis.com/auth/drive']
    );
    return jwtClient;
  }

  // 3. Standardni OAuth 2.0 flow s fallbackom na admin session ili okruženjsku varijablu
  let activeSession = session;
  if ((!activeSession || !activeSession.encryptedRefreshToken) && global.adminSession) {
    activeSession = global.adminSession;
  }

  let refreshToken = null;
  if (activeSession && activeSession.encryptedRefreshToken) {
    refreshToken = decrypt(activeSession.encryptedRefreshToken);
  } else if (process.env.GOOGLE_REFRESH_TOKEN) {
    refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
    if (!activeSession) {
      activeSession = {
        accessToken: null,
        tokenExpiry: null
      };
    }
  }

  if (!refreshToken) {
    throw Object.assign(new Error('Korisnik nije prijavljen. Molimo povežite Google Drive.'), { status: 401 });
  }

  const oauth2Client = createOAuth2Client(activeSession);
  oauth2Client.setCredentials({
    refresh_token: refreshToken,
    access_token: activeSession.accessToken || null,
    expiry_date: activeSession.tokenExpiry || null
  });

  // Ako je token istekao, osvježi ga
  if (!activeSession.accessToken || (activeSession.tokenExpiry && Date.now() >= activeSession.tokenExpiry - 60000)) {
    try {
      const { credentials } = await oauth2Client.refreshAccessToken();
      // Ažuriraj sesiju s novim access tokenom
      activeSession.accessToken = credentials.access_token;
      activeSession.tokenExpiry = credentials.expiry_date;
      oauth2Client.setCredentials(credentials);

      // Ako imamo globalnu admin sesiju, spremi je na disk
      if (global.adminSession) {
        global.adminSession.accessToken = credentials.access_token;
        global.adminSession.tokenExpiry = credentials.expiry_date;
        try {
          const dataDir = path.dirname(sessionFile);
          if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
          fs.writeFileSync(sessionFile, JSON.stringify(global.adminSession, null, 2));
        } catch (e) {
          console.error('[DriveClient] Greška pri spremanju osvježenog tokena na disk:', e.message);
        }
      }
    } catch (err) {
      console.error('[Drive] Greška pri osvježavanju tokena:', err.message);
      throw Object.assign(new Error('Sesija je istekla. Molimo prijavite se ponovno.'), { status: 401 });
    }
  }

  return oauth2Client;
}

/**
 * Vraća Google Drive API instancu.
 * 
 * @param {Object} session - Express sesija
 * @returns {drive_v3.Drive} - Drive API klijent
 */
async function getDriveClient(session) {
  const auth = await getAuthenticatedClient(session);
  return google.drive({ version: 'v3', auth });
}

module.exports = { createOAuth2Client, getAuthenticatedClient, getDriveClient };
