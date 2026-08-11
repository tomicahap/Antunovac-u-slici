/**
 * db.js – Lokalna baza (LocalStorage) s automatskom Firestore sinkronizacijom.
 *
 * Arhitektura:
 * - LocalStorage = brz lokalni cache, uvijek dostupan offline
 * - Firestore = trajni backup u oblaku
 * - Sync queue = popis lokalnih promjena koje čekaju slanje na Firestore
 * - Logika: "zadnji zapis pobjeđuje" (timestamp usporedba)
 */

const DB = (function () {
  'use strict';

  // ─── LocalStorage ključevi ─────────────────────────────────────────────────
  const KEYS = {
    persons:   'agf_persons',
    tags:      'agf_tags',
    images:    'agf_images',
    comments:  'agf_comments',
    queue:     'agf_sync_queue',
    settings:  'agf_settings'
  };

  // ─── Firestore referenca ───────────────────────────────────────────────────
  let _db = null;
  let _firestoreEnabled = false;
  let _autoSync = true;
  let _syncInProgress = false;
  let _syncListeners = [];

  // ─── UUID generator ────────────────────────────────────────────────────────
  function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  function now() { return new Date().toISOString(); }

  // ─── IndexedDB helpers (za neograničen kapacitet baze) ──────────────────────
  let _idb = null;
  function openIDB() {
    return new Promise((resolve) => {
      if (_idb) return resolve(_idb);
      try {
        const req = indexedDB.open('AntunovacDB', 1);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains('store')) {
            db.createObjectStore('store');
          }
        };
        req.onsuccess = (e) => {
          _idb = e.target.result;
          resolve(_idb);
        };
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  async function idbSet(key, value) {
    const db = await openIDB();
    if (!db) return false;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction('store', 'readwrite');
        const store = tx.objectStore('store');
        store.put(value, key);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      } catch {
        resolve(false);
      }
    });
  }

  async function idbGet(key) {
    const db = await openIDB();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction('store', 'readonly');
        const store = tx.objectStore('store');
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  // ─── LocalStorage helpers ──────────────────────────────────────────────────
  function lsGet(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      console.error('[DB] LocalStorage read error:', e);
      return null;
    }
  }

  function lsSet(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      console.warn('[DB] LocalStorage quota premoštena s IndexedDB-om.');
    }
  }

  // ─── Kolekcije (in-memory + IndexedDB/LocalStorage) ───────────────────────
  let _data = {
    persons: [],
    tags: [],
    images: [],
    comments: [],
    settings: {}
  };

  async function loadFromStorage() {
    _data.persons  = (await idbGet(KEYS.persons)) || lsGet(KEYS.persons) || [];
    _data.tags     = (await idbGet(KEYS.tags)) || lsGet(KEYS.tags) || [];
    _data.images   = (await idbGet(KEYS.images)) || lsGet(KEYS.images) || [];
    _data.comments = (await idbGet(KEYS.comments)) || lsGet(KEYS.comments) || [];
    _data.settings = (await idbGet(KEYS.settings)) || lsGet(KEYS.settings) || {};
  }

  let _saveTimeout = null;
  function debounceSaveToServer() {
    if (_saveTimeout) clearTimeout(_saveTimeout);
    _saveTimeout = setTimeout(async () => {
      try {
        await fetch('/api/drive/db/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(_data)
        });
      } catch (err) {
        console.error('[DB] Greška pri sinkronizaciji baze na server:', err);
      }
    }, 1000);
  }

  async function syncItem(collection, id, data) {
    if (!_autoSync) return;
    try {
      await fetch('/api/drive/db/save-item', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection, id, data })
      });
    } catch (e) {
      console.error(`[DB] Greška pri sinkronizaciji stavke ${collection}/${id}:`, e);
    }
  }

  async function deleteItem(collection, id) {
    if (!_autoSync) return;
    try {
      await fetch('/api/drive/db/delete-item', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection, id })
      });
    } catch (e) {
      console.error(`[DB] Greška pri brisanju stavke ${collection}/${id}:`, e);
    }
  }

  async function saveToStorage(collection) {
    const val = _data[collection];
    await idbSet(KEYS[collection], val);
    lsSet(KEYS[collection], val);
  }

  // ─── Sync Queue ────────────────────────────────────────────────────────────
  function queueAdd(op) {
    const queue = lsGet(KEYS.queue) || [];
    queue.push({ ...op, queued_at: now() });
    lsSet(KEYS.queue, queue);
  }

  function queueClear() { lsSet(KEYS.queue, []); }
  function queueGet() { return lsGet(KEYS.queue) || []; }

  // ─── Emitiranje sync statusa ───────────────────────────────────────────────
  function emitSyncStatus(status, msg = '') {
    const dot = document.getElementById('status-sync-dot');
    const label = document.getElementById('status-sync-label');
    const indicator = document.getElementById('sync-indicator');
    const statusText = document.getElementById('sync-status-text');

    const states = {
      connected: { dot: 'connected', label: 'Firestore spojen', indicator: 'connected', text: 'Spojen' },
      syncing:   { dot: 'syncing',   label: 'Sinkronizacija...', indicator: 'syncing', text: 'Sinkronizacija u tijeku...' },
      offline:   { dot: '',          label: 'Offline mode', indicator: '', text: 'Offline – lokalni podaci' },
      error:     { dot: 'error',     label: 'Sync greška', indicator: 'error', text: `Greška: ${msg}` },
      disabled:  { dot: '',          label: 'Firestore nije konfiguriran', indicator: '', text: 'Nije konfiguriran' }
    };

    const s = states[status] || states.offline;
    if (dot) { dot.className = 'sync-dot'; if (s.dot) dot.classList.add(s.dot); }
    if (label) label.textContent = s.label;
    if (indicator) { indicator.className = 'sync-indicator'; if (s.indicator) indicator.classList.add(s.indicator); }
    if (statusText) statusText.textContent = s.text;

    _syncListeners.forEach(fn => fn(status, msg));
  }

  // ─── Firestore inicijalizacija ─────────────────────────────────────────────
  async function initFirestore(config) {
    if (!config || !config.enabled) {
      _firestoreEnabled = false;
      emitSyncStatus('disabled');
      return false;
    }

    try {
      _firestoreEnabled = true;
      emitSyncStatus('connected');

      window.addEventListener('online', onOnline);
      window.addEventListener('offline', onOffline);

      console.log('[DB] Firestore uspješno inicijaliziran na backendu za projekt:', config.projectId);
      return true;
    } catch (e) {
      console.error('[DB] Firestore init greška:', e.message);
      _firestoreEnabled = false;
      emitSyncStatus('error', e.message);
      return false;
    }
  }

  async function onOnline() {
    if (!_firestoreEnabled) return;
    try { await _db.enableNetwork(); } catch {}
    emitSyncStatus('connected');
    if (_autoSync) flushQueue();
  }

  async function onOffline() {
    emitSyncStatus('offline');
  }

  // ─── CRUD operacije (lokalne + sync) ───────────────────────────────────────

  // ── Persons ──

  function getAllPersons() { return [..._data.persons]; }

  function getPersonById(id) {
    return _data.persons.find(p => p.id === id) || null;
  }

  function searchPersons(filterCriteria) {
    if (!filterCriteria) return getAllPersons();

    let q = '';
    let fIme = '', fPrezime = '', fDjevojacko = '', fRoditelj = '', fSupruznik = '', fDijete = '';
    let godRodOd = null, godRodDo = null, godSmOd = null, godSmDo = null;

    if (typeof filterCriteria === 'string') {
      q = filterCriteria.trim().toLowerCase();
    } else if (typeof filterCriteria === 'object') {
      q = (filterCriteria.query || '').trim().toLowerCase();
      fIme = (filterCriteria.ime || '').trim().toLowerCase();
      fPrezime = (filterCriteria.prezime || '').trim().toLowerCase();
      fDjevojacko = (filterCriteria.djevojacko || '').trim().toLowerCase();
      fRoditelj = (filterCriteria.roditelj || '').trim().toLowerCase();
      fSupruznik = (filterCriteria.supruznik || '').trim().toLowerCase();
      fDijete = (filterCriteria.dijete || '').trim().toLowerCase();
      if (filterCriteria.godRodOd) godRodOd = parseInt(filterCriteria.godRodOd, 10);
      if (filterCriteria.godRodDo) godRodDo = parseInt(filterCriteria.godRodDo, 10);
      if (filterCriteria.godSmOd) godSmOd = parseInt(filterCriteria.godSmOd, 10);
      if (filterCriteria.godSmDo) godSmDo = parseInt(filterCriteria.godSmDo, 10);
    }

    return _data.persons.filter(p => {
      const ime = (p.ime || '').toLowerCase();
      const prezime = (p.prezime || '').toLowerCase();
      const djevojacko = (p.djevojacko_prezime || '').toLowerCase();
      const roditelji = (p.roditelji || '').toLowerCase();
      const supruznici = (p.supruznici || '').toLowerCase();
      const djeca = (p.djeca || '').toLowerCase();
      const napomena = (p.napomena || '').toLowerCase();

      // Opća pretraga (search po svim poljima)
      if (q) {
        const matchQ = ime.includes(q) || prezime.includes(q) || djevojacko.includes(q) ||
                       roditelji.includes(q) || supruznici.includes(q) || djeca.includes(q) || napomena.includes(q);
        if (!matchQ) return false;
      }

      // Napredni filteri po svim poljima
      if (fIme && !ime.includes(fIme)) return false;
      if (fPrezime && !prezime.includes(fPrezime)) return false;
      if (fDjevojacko && !djevojacko.includes(fDjevojacko)) return false;
      if (fRoditelj && !roditelji.includes(fRoditelj)) return false;
      if (fSupruznik && !supruznici.includes(fSupruznik)) return false;
      if (fDijete && !djeca.includes(fDijete)) return false;

      const r = p.godina_rodenja;
      if (godRodOd !== null && (!r || r < godRodOd)) return false;
      if (godRodDo !== null && (!r || r > godRodDo)) return false;

      const s = p.godina_smrti;
      if (godSmOd !== null && (!s || s < godSmOd)) return false;
      if (godSmDo !== null && (!s || s > godSmDo)) return false;

      return true;
    });
  }

  function savePerson(data) {
    const isNew = !data.id;
    const person = {
      id: data.id || uuid(),
      ime: (data.ime || '').trim(),
      prezime: (data.prezime || '').trim(),
      djevojacko_prezime: (data.djevojacko_prezime || '').trim(),
      godina_rodenja: data.godina_rodenja ? parseInt(data.godina_rodenja) : null,
      godina_smrti: data.godina_smrti ? parseInt(data.godina_smrti) : null,
      roditelji: (data.roditelji || '').trim(),
      supruznici: (data.supruznici || '').trim(),
      djeca: (data.djeca || '').trim(),
      napomena: (data.napomena || '').trim(),
      raw_data: data.raw_data || null,
      custom_tags: data.custom_tags || null,
      created_at: data.created_at || now(),
      updated_at: now()
    };

    if (isNew) {
      _data.persons.push(person);
    } else {
      const idx = _data.persons.findIndex(p => p.id === person.id);
      if (idx > -1) _data.persons[idx] = person;
      else _data.persons.push(person);
    }

    saveToStorage('persons');
    syncPerson(person);
    return person;
  }

  async function savePersonsBatch(personsArray) {
    if (!Array.isArray(personsArray) || personsArray.length === 0) return 0;

    const existingMap = new Map();
    _data.persons.forEach(p => existingMap.set(p.id, p));

    personsArray.forEach(data => {
      const id = data.id || (data.xref ? 'INDI_' + data.xref.replace(/[^a-zA-Z0-9_-]/g, '_') : uuid());
      const person = {
        id: id,
        ime: (data.ime || '').trim(),
        prezime: (data.prezime || '').trim(),
        djevojacko_prezime: (data.djevojacko_prezime || '').trim(),
        godina_rodenja: data.godina_rodenja ? parseInt(data.godina_rodenja) : null,
        godina_smrti: data.godina_smrti ? parseInt(data.godina_smrti) : null,
        roditelji: (data.roditelji || '').trim(),
        supruznici: (data.supruznici || '').trim(),
        djeca: (data.djeca || '').trim(),
        napomena: (data.napomena || '').trim(),
        raw_data: data.raw_data || null,
        custom_tags: data.custom_tags || null,
        created_at: data.created_at || now(),
        updated_at: now()
      };
      existingMap.set(person.id, person);
    });

    _data.persons = Array.from(existingMap.values());
    await saveToStorage('persons');
    return _data.persons.length;
  }

  function deletePerson(id) {
    _data.persons = _data.persons.filter(p => p.id !== id);
    _data.tags = _data.tags.filter(t => t.person_id !== id);
    saveToStorage('persons');
    saveToStorage('tags');
    deleteItem('persons', id);
  }

  // ── Tags ──

  function getAllTags() { return [..._data.tags]; }

  function getTagsByImageId(imageId) {
    return _data.tags.filter(t => t.image_id === imageId);
  }

  function getTagsByPersonId(personId) {
    return _data.tags.filter(t => t.person_id === personId);
  }

  function saveTag(data) {
    const isNew = !data.id;
    const tag = {
      id: data.id || uuid(),
      person_id: data.person_id,
      image_id: data.image_id,
      x: data.x, y: data.y, width: data.width, height: data.height,
      portrait_filename: data.portrait_filename || null,
      portrait_drive_id: data.portrait_drive_id || null,
      portrait_tisak_drive_id: data.portrait_tisak_drive_id || null,
      
      // Snapshotirani podaci o osobi
      person_ime: data.person_ime || null,
      person_prezime: data.person_prezime || null,
      person_godina_rodenja: data.person_godina_rodenja || null,
      person_godina_smrti: data.person_godina_smrti || null,
      person_gedcom_id: data.person_gedcom_id || null,

      created_at: data.created_at || now(),
      updated_at: now()
    };

    if (isNew) {
      _data.tags.push(tag);
    } else {
      const idx = _data.tags.findIndex(t => t.id === tag.id);
      if (idx > -1) _data.tags[idx] = tag;
      else _data.tags.push(tag);
    }

    saveToStorage('tags');
    syncTag(tag);
    return tag;
  }

  function deleteTag(id) {
    _data.tags = _data.tags.filter(t => t.id !== id);
    saveToStorage('tags');
    deleteItem('tags', id);
  }

  // ── Images ──

  function getAllImages() { return [..._data.images]; }

  function getImageByDriveId(driveId) {
    return _data.images.find(img => img.original_drive_id === driveId || img.output_drive_id === driveId) || null;
  }

  function saveImage(data) {
    const isNew = !data.id;
    const image = {
      id: data.id || uuid(),
      original_drive_id: data.original_drive_id,
      original_filename: data.original_filename,
      output_drive_id: data.output_drive_id || null,
      processed_at: data.processed_at || null,
      status: data.status || 'pending',
      folder_id: data.folder_id || null,
      sequence_no: data.sequence_no || null,
      donor: data.donor || null,
      created_at: data.created_at || now(),
      updated_at: now()
    };

    if (isNew) {
      _data.images.push(image);
    } else {
      const idx = _data.images.findIndex(i => i.id === image.id);
      if (idx > -1) _data.images[idx] = image;
      else _data.images.push(image);
    }

    saveToStorage('images');
    syncImage(image);
    return image;
  }

  // ── Comments ──

  function getComments(targetType, targetId) {
    return _data.comments
      .filter(c => c.target_type === targetType && c.target_id === targetId)
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  }

  function getAllComments() {
    return _data.comments || [];
  }

  function deleteComment(commentId) {
    _data.comments = (_data.comments || []).filter(c => c.id !== commentId);
    saveToStorage('comments');
    deleteItem('comments', commentId);
    return true;
  }

  function saveComment(data) {
    const comment = {
      id: uuid(),
      target_type: data.target_type, // 'image' | 'person'
      target_id: data.target_id,
      author_name: (data.author_name || 'Posjetitelj').trim(),
      comment_text: (data.comment_text || '').trim(),
      created_at: now()
    };

    if (!comment.comment_text) return null;

    _data.comments.push(comment);
    saveToStorage('comments');
    syncComment(comment);
    return comment;
  }

  // ─── Firestore sync operacije ──────────────────────────────────────────────

  async function syncPerson(person) {
    await syncItem('persons', person.id, person);
  }

  async function syncTag(tag) {
    await syncItem('tags', tag.id, tag);
  }

  async function syncImage(image) {
    await syncItem('images', image.id, image);
  }

  async function syncComment(comment) {
    await syncItem('comments', comment.id, comment);
  }

  async function syncSettings(settings) {
    await syncItem('settings', 'app_settings', settings);
  }

  async function flushQueue() {
    return true;
  }

  async function pullFromFirestore() {
    return true;
  }

  function mergeCollections(local, remote) {
    const map = new Map();
    local.forEach(item => map.set(item.id, item));
    remote.forEach(item => {
      const existing = map.get(item.id);
      if (!existing || (item.updated_at && item.updated_at > (existing.updated_at || ''))) {
        map.set(item.id, item);
      }
    });
    return Array.from(map.values());
  }

  // ─── Import/Export ─────────────────────────────────────────────────────────

  function exportAll() {
    return {
      version: '1.0',
      exported_at: now(),
      persons: [..._data.persons],
      tags:    [..._data.tags],
      images:  [..._data.images]
    };
  }

  async function importAll(data, mode = 'merge') {
    const persons = data.persons || [];
    const tags    = data.tags || [];
    const images  = data.images || [];

    if (mode === 'replace') {
      _data.persons = persons;
      _data.tags    = tags;
      _data.images  = images;
    } else {
      // Merge
      _data.persons = mergeCollections(_data.persons, persons);
      _data.tags    = mergeCollections(_data.tags, tags);
      _data.images  = mergeCollections(_data.images, images);
    }

    saveToStorage('persons');
    saveToStorage('tags');
    saveToStorage('images');

    // Sinkronizacija s Firestorom
    if (_firestoreEnabled && _autoSync && navigator.onLine) {
      await flushQueue();
    }

    return {
      persons: _data.persons.length,
      tags: _data.tags.length,
      images: _data.images.length
    };
  }

  // ─── Postavke ──────────────────────────────────────────────────────────────
  const DEFAULT_SETTINGS = {
    jpegQuality: 92,
    showLabels: true,
    autoSync: true,
    inputFolderId: null,
    inputFolderName: null,
    portraitsTisakFolderId: null,
    portraitsTisakFolderName: null,
    portraitsWebFolderId: null,
    portraitsWebFolderName: null,
    portraitsSubfolder: 'Portreti',
    defaultStartFolder: 'root'
  };

  function getSettings() {
    const stored = _data.settings && Object.keys(_data.settings).length > 0 ? _data.settings : (lsGet(KEYS.settings) || {});
    return { ...DEFAULT_SETTINGS, ...stored };
  }

  function saveSettings(settings) {
    const current = getSettings();
    const merged = { ...current, ...settings };
    _data.settings = merged;
    lsSet(KEYS.settings, merged);
    idbSet(KEYS.settings, merged);
    _autoSync = merged.autoSync !== false;
    syncSettings(merged);
    return merged;
  }

  // ─── Statistike ────────────────────────────────────────────────────────────
  function getStats() {
    return {
      persons: _data.persons.length,
      tags: _data.tags.length,
      images: _data.images.length,
      pendingSync: queueGet().length
    };
  }

  // ─── Inicijalizacija ───────────────────────────────────────────────────────
  function addSyncListener(fn) { _syncListeners.push(fn); }

  function init() {
    loadFromStorage();
    const settings = getSettings();
    _autoSync = settings.autoSync !== false;

    if (!navigator.onLine) {
      emitSyncStatus('offline');
    }

    // Učitaj najnovije zajedničke podatke sa servera
    fetch('/api/drive/db/load')
      .then(res => res.json())
      .then(async (remoteData) => {
        if (remoteData && remoteData.persons) {
          _data.persons = remoteData.persons || [];
          _data.tags = remoteData.tags || [];
          _data.images = remoteData.images || [];
          _data.comments = remoteData.comments || [];
          const localSettings = lsGet(KEYS.settings) || {};
          _data.settings = { ...localSettings, ...(remoteData.settings || {}) };

          await idbSet(KEYS.persons, _data.persons);
          await idbSet(KEYS.tags, _data.tags);
          await idbSet(KEYS.images, _data.images);
          await idbSet(KEYS.comments, _data.comments);
          await idbSet(KEYS.settings, _data.settings);

          lsSet(KEYS.persons, _data.persons);
          lsSet(KEYS.tags, _data.tags);
          lsSet(KEYS.images, _data.images);
          lsSet(KEYS.comments, _data.comments);
          lsSet(KEYS.settings, _data.settings);

          console.log('[DB] Baza uspješno sinkronizirana sa serverom.');
          document.dispatchEvent(new CustomEvent('dbSynced'));
        }
      })
      .catch(err => console.error('[DB] Učitavanje baze sa servera neuspješno:', err));

    return _data;
  }

  // ─── Public API ───────────────────────────────────────────────────────────
  return {
    init, initFirestore,
    // Persons
    getAllPersons, getPersonById, searchPersons, savePerson, savePersonsBatch, deletePerson,
    // Tags
    getAllTags, getTagsByImageId, getTagsByPersonId, saveTag, deleteTag,
    // Images
    getAllImages, getImageByDriveId, saveImage,
    // Comments
    getComments, getAllComments, saveComment, deleteComment,
    // Sync
    flushQueue, pullFromFirestore, addSyncListener,
    // Import/Export
    exportAll, importAll,
    // Settings
    getSettings, saveSettings,
    // Utils
    getStats, uuid
  };
})();
