/**
 * AES-256-GCM enkripcija za sigurno čuvanje refresh tokena u cookie sesiji.
 * Koristi se isključivo na backendu — nikad se ne izlaže frontendu.
 */

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;  // 96 bita za GCM
const TAG_LENGTH = 16; // 128 bita auth tag

/**
 * Vraća 32-bajtni Buffer ključ iz env varijable ENCRYPTION_KEY.
 * Ako ključ nije postavljen, koristi se deterministički fallback
 * (NIJE siguran za produkciju — upozorenje u konzoli).
 */
function getKey() {
  const hexKey = process.env.ENCRYPTION_KEY;
  if (hexKey && hexKey.length === 64) {
    return Buffer.from(hexKey, 'hex');
  }
  console.warn('[UPOZORENJE] ENCRYPTION_KEY nije postavljen ili nije ispravan (64 hex znaka). Koristim nesigurni fallback!');
  // Fallback: SHA-256 od SESSION_SECRET
  const secret = process.env.SESSION_SECRET || 'fallback-key-NOT-FOR-PRODUCTION';
  return crypto.createHash('sha256').update(secret).digest();
}

/**
 * Enkriptira string vrijednost.
 * @param {string} text - Tekst za enkripciju
 * @returns {string} - Base64 string: iv + authTag + ciphertext
 */
function encrypt(text) {
  if (!text) return null;
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  
  // Format: IV (12B) | AuthTag (16B) | Ciphertext
  const combined = Buffer.concat([iv, authTag, encrypted]);
  return combined.toString('base64');
}

/**
 * Dekriptira enkriptirani string.
 * @param {string} encryptedBase64 - Base64 enkriptirana vrijednost
 * @returns {string|null} - Originalni tekst ili null pri grešci
 */
function decrypt(encryptedBase64) {
  if (!encryptedBase64) return null;
  try {
    const key = getKey();
    const combined = Buffer.from(encryptedBase64, 'base64');
    
    const iv = combined.slice(0, IV_LENGTH);
    const authTag = combined.slice(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const ciphertext = combined.slice(IV_LENGTH + TAG_LENGTH);
    
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (err) {
    console.error('[Enkripcija] Greška pri dekripciji:', err.message);
    return null;
  }
}

module.exports = { encrypt, decrypt };
