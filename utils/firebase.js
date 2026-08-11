const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

const dbFile = path.join(__dirname, '..', 'data', 'db.json');

let db = null;
let enabled = false;
let projectId = '';

// Inicijalizacija Firebase Admin SDK-a
try {
  let serviceAccount = null;
  
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } catch (e) {
      try {
        serviceAccount = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, 'base64').toString('utf8'));
      } catch (err) {
        console.warn('[Firebase] FIREBASE_SERVICE_ACCOUNT nije valjan JSON ili Base64 JSON:', err.message);
      }
    }
  } else if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_CLIENT_EMAIL) {
    serviceAccount = {
      projectId: process.env.FIREBASE_PROJECT_ID,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL
    };
  }

  if (serviceAccount) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    db = admin.firestore();
    enabled = true;
    projectId = serviceAccount.project_id || serviceAccount.projectId || '';
    console.log('[Firebase] Uspješno inicijaliziran Firestore za projekt:', projectId);
  } else {
    console.log('[Firebase] Firebase varijable nisu postavljene. Koristi se lokalni fallback (data/db.json).');
  }
} catch (err) {
  console.error('[Firebase] Greška pri inicijalizaciji:', err.message);
  console.log('[Firebase] Nastavak u offline fallback načinu rada.');
}

function isEnabled() {
  return enabled;
}

function getProjectId() {
  return projectId;
}

// Lokalni fallback čitač i pisač
function readLocalDb() {
  if (fs.existsSync(dbFile)) {
    try {
      return JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    } catch (e) {
      return { settings: {}, persons: [], tags: [], images: [], comments: [] };
    }
  }
  return { settings: {}, persons: [], tags: [], images: [], comments: [] };
}

function writeLocalDb(data) {
  const dir = path.dirname(dbFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(dbFile, JSON.stringify(data, null, 2), 'utf8');
}

// Granularno spremanje u Firestore ili lokalni fallback
async function saveDoc(collectionName, docId, data) {
  if (enabled && db) {
    try {
      const docRef = db.collection(collectionName).doc(docId);
      // Očisti undefined polja da izbjegnemo Firestore serialization greške
      const cleanData = JSON.parse(JSON.stringify(data));
      await docRef.set(cleanData, { merge: true });
      console.log(`[Firebase] Spremljen dokument: ${collectionName}/${docId}`);
      return true;
    } catch (err) {
      console.error(`[Firebase] Greška pri spremanju ${collectionName}/${docId}:`, err.message);
      throw err;
    }
  } else {
    // Lokalni fallback
    const local = readLocalDb();
    if (collectionName === 'settings') {
      local.settings = data;
    } else {
      if (!local[collectionName]) local[collectionName] = [];
      const list = local[collectionName];
      const idx = list.findIndex(item => item.id === docId);
      if (idx > -1) {
        list[idx] = { ...list[idx], ...data };
      } else {
        list.push({ id: docId, ...data });
      }
    }
    writeLocalDb(local);
    console.log(`[LocalFallback] Spremljen dokument: ${collectionName}/${docId}`);
    return true;
  }
}

// Granularno brisanje
async function deleteDoc(collectionName, docId) {
  if (enabled && db) {
    try {
      await db.collection(collectionName).doc(docId).delete();
      console.log(`[Firebase] Obrisan dokument: ${collectionName}/${docId}`);
      return true;
    } catch (err) {
      console.error(`[Firebase] Greška pri brisanju ${collectionName}/${docId}:`, err.message);
      throw err;
    }
  } else {
    // Lokalni fallback
    const local = readLocalDb();
    if (collectionName !== 'settings' && local[collectionName]) {
      local[collectionName] = local[collectionName].filter(item => item.id !== docId);
    }
    writeLocalDb(local);
    console.log(`[LocalFallback] Obrisan dokument: ${collectionName}/${docId}`);
    return true;
  }
}

// Učitavanje cjelokupne baze
async function loadAll() {
  if (enabled && db) {
    try {
      console.log('[Firebase] Učitavanje cijele baze iz Firestorea...');
      const collections = ['persons', 'tags', 'images', 'comments'];
      const result = {
        settings: {},
        persons: [],
        tags: [],
        images: [],
        comments: []
      };

      // Učitaj settings
      const settingsSnap = await db.collection('settings').doc('app_settings').get();
      if (settingsSnap.exists) {
        result.settings = settingsSnap.data();
      }

      // Učitaj ostalo
      for (const col of collections) {
        const snap = await db.collection(col).get();
        snap.forEach(doc => {
          result[col].push({ id: doc.id, ...doc.data() });
        });
      }

      console.log(`[Firebase] Uspješno učitano: ${result.persons.length} osoba, ${result.tags.length} tagova, ${result.images.length} slika, ${result.comments.length} komentara.`);
      return result;
    } catch (err) {
      console.error('[Firebase] Greška pri loadAll, vraćam lokalni fallback:', err.message);
      return readLocalDb();
    }
  } else {
    return readLocalDb();
  }
}

module.exports = {
  db,
  isEnabled,
  getProjectId,
  saveDoc,
  deleteDoc,
  loadAll,
  readLocalDb,
  writeLocalDb
};
