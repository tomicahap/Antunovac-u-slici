/**
 * drive.js (frontend) – API pozivi prema backend Drive proxy-u.
 * Sve autentifikacijske operacije idu kroz backend — access tokeni
 * se nikad ne izlažu frontendu.
 */

const DriveAPI = (function () {
  'use strict';

  const BASE = '/api';

  // ─── HTTP helper ────────────────────────────────────────────────────────────
  async function request(method, path, body = null, isFormData = false) {
    const opts = {
      method,
      credentials: 'include', // Šalje cookie sesiju
      headers: {}
    };

    if (body) {
      if (isFormData) {
        opts.body = body; // FormData – ne postavljaj Content-Type (browser ga sam postavi s boundary)
      } else {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
      }
    }

    const res = await fetch(`${BASE}${path}`, opts);
    const ct = res.headers.get('content-type') || '';

    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        if (ct.includes('application/json')) {
          const err = await res.json();
          msg = err.error || err.message || msg;
        }
      } catch {}
      throw new Error(msg);
    }

    if (ct.includes('application/json')) return res.json();
    if (ct.startsWith('image/')) return res.blob();
    return res;
  }

  // ─── Auth ───────────────────────────────────────────────────────────────────

  /** Vraća status autentifikacije */
  async function getAuthStatus() {
    return request('GET', '/auth/status');
  }

  /** Generira i vraća Google OAuth URL */
  async function getAuthUrl() {
    const data = await request('GET', '/auth/url');
    return data.url;
  }

  /** Izravna prijava u Admin način */
  async function adminLogin() {
    return request('POST', '/auth/admin-login');
  }

  /** Odjava */
  async function logout() {
    return request('POST', '/auth/logout');
  }

  /** Validacija credentials.json */
  async function validateCredentials(credentialsJson) {
    return request('POST', '/auth/credentials', { credentials: credentialsJson });
  }

  /** Poveži klijentski OAuth JSON */
  async function uploadOAuthConfig(jsonString) {
    return request('POST', '/auth/oauth-config', { oauthConfig: jsonString });
  }

  // ─── Drive – Mape ───────────────────────────────────────────────────────────

  /**
   * Dohvati podmape.
   * @param {string} parentId - ID roditeljske mape (default: 'root')
   * @param {string} [pageToken] - Token za sljedeću stranicu
   */
  async function getFolders(parentId = 'root', pageToken = null) {
    let path = `/drive/folders?parentId=${encodeURIComponent(parentId)}`;
    if (pageToken) path += `&pageToken=${encodeURIComponent(pageToken)}`;
    return request('GET', path);
  }

  /**
   * Parsira Drive URL i vraća ID i tip (file/folder).
   * @param {string} url - Drive URL ili goli ID
   */
  async function resolveUrl(url) {
    return request('GET', `/drive/resolve?url=${encodeURIComponent(url)}`);
  }

  /**
   * Kreiranje podmape.
   * @param {string} parentId - ID roditeljske mape
   * @param {string} name - Naziv podmape
   */
  async function createFolder(parentId, name) {
    return request('POST', '/drive/folder', { parentId, name });
  }

  // ─── Drive – Datoteke ───────────────────────────────────────────────────────

  /**
   * Dohvati popis slika u mapi.
   * @param {string} folderId - ID mape
   * @param {string} [pageToken] - Token za sljedeću stranicu
   * @param {number} [pageSize] - Broj datoteka po stranici
   */
  async function getFiles(folderId, pageToken = null, pageSize = 50) {
    let path = `/drive/files?folderId=${encodeURIComponent(folderId)}&pageSize=${pageSize}`;
    if (pageToken) path += `&pageToken=${encodeURIComponent(pageToken)}`;
    return request('GET', path);
  }

  /**
   * Dohvati metapodatke datoteke.
   * @param {string} fileId - Drive file ID
   */
  async function getFileMetadata(fileId) {
    return request('GET', `/drive/file/${fileId}/metadata`);
  }

  /** Direct Google CDN Engine URL za trenutno učitavanje (w1600) */
  function getCdnUrl(fileId, size = 1600) {
    if (!fileId) return '';
    return `https://lh3.googleusercontent.com/d/${fileId}=w${size}`;
  }

  /**
   * Vraća URL za prikaz slike u canvasu.
   * Koristi brzi Direct CDN s fallbackom na backend proxy.
   * @param {string} fileId - Drive file ID
   * @param {boolean} [convert] - Konvertiraj TIFF u JPEG (default: true)
   */
  function getImageUrl(fileId, convert = false) {
    if (!fileId) return '';
    return `${BASE}/drive/file/${fileId}/download?convert=${convert}&t=${Date.now()}`;
  }

  /**
   * Vraća URL za thumbnail slike.
   * @param {string} fileId - Drive file ID
   * @param {number} [size] - Maksimalna širina thumbnailа
   */
  function getThumbnailUrl(fileId, size = 200) {
    if (!fileId) return '';
    return `${BASE}/drive/file/${fileId}/thumbnail?size=${size}&t=${Date.now()}`;
  }

  /**
   * Preuzima sliku kao Blob (za canvas operacije).
   * @param {string} fileId - Drive file ID
   */
  async function downloadImage(fileId) {
    return request('GET', `/drive/file/${fileId}/download`);
  }

  /**
   * Upload datoteke (kao base64) na Drive.
   * @param {string} folderId - ID odredišne mape
   * @param {string} filename - Naziv datoteke
   * @param {string} base64data - Base64 sadržaj (s data: prefiksom ili bez)
   * @param {string} mimeType - MIME tip
   * @param {Function} [onProgress] - Callback za napredak (0-100)
   */
  async function uploadFile(folderId, filename, base64data, mimeType = 'image/jpeg', onProgress, fileId = null) {
    // Za praćenje napretka koristimo XMLHttpRequest
    if (onProgress) {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${BASE}/drive/upload`);
        xhr.withCredentials = true;
        xhr.setRequestHeader('Content-Type', 'application/json');

        xhr.upload.addEventListener('progress', (e) => {
          if (e.lengthComputable) onProgress(Math.round(e.loaded / e.total * 100));
        });

        xhr.addEventListener('load', () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try { resolve(JSON.parse(xhr.responseText)); }
            catch { resolve({ success: true }); }
          } else {
            try {
              const err = JSON.parse(xhr.responseText);
              reject(new Error(err.error || `HTTP ${xhr.status}`));
            } catch { reject(new Error(`HTTP ${xhr.status}`)); }
          }
        });

        xhr.addEventListener('error', () => reject(new Error('Mrežna greška pri uploadu')));
        xhr.send(JSON.stringify({ folderId, filename, base64data, mimeType, fileId }));
      });
    }

    return request('POST', '/drive/upload', { folderId, filename, base64data, mimeType, fileId });
  }

  /**
   * Upload Blob objekta na Drive.
   * @param {string} folderId - ID odredišne mape
   * @param {string} filename - Naziv datoteke
   * @param {Blob} blob - Blob za upload
   * @param {Function} [onProgress] - Napredak callback
   * @param {string} [fileId] - ID postojeće datoteke za pregažavanje
   */
  async function uploadBlob(folderId, filename, blob, onProgress, fileId = null) {
    // Konvertiraj Blob u base64
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });

    return uploadFile(folderId, filename, base64, blob.type || 'image/jpeg', onProgress, fileId);
  }

  async function deleteFile(fileId) {
    if (!fileId) return;
    return request('DELETE', `/drive/file/${fileId}`);
  }

  // ─── Firebase konfiguracija ─────────────────────────────────────────────────

  /**
   * Dohvati konfiguraciju (Firebase config + Google client ID) s backenda.
   */
  async function getConfig() {
    return request('GET', '/config');
  }

  async function copyFile(fileId, outputFolderId) {
    return request('POST', `/drive/file/${fileId}/copy`, { outputFolderId });
  }

  async function cropAndUploadFile(fileId, params) {
    return request('POST', `/drive/file/${fileId}/crop-and-upload`, params);
  }

  // ─── Public API ─────────────────────────────────────────────────────────────
  return {
    // Auth
    getAuthStatus, getAuthUrl, adminLogin, logout, validateCredentials, uploadOAuthConfig,
    // Mape
    getFolders, resolveUrl, createFolder,
    // Datoteke
    getFiles, getFileMetadata, getImageUrl, getThumbnailUrl, getCdnUrl, downloadImage, deleteFile,
    uploadFile, uploadBlob, copyFile, cropAndUploadFile,
    // Config
    getConfig
  };
})();
