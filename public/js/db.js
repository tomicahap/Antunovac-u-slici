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
    comments: []
  };

  async function loadFromStorage() {
    _data.persons  = (await idbGet(KEYS.persons)) || lsGet(KEYS.persons) || [];
    _data.tags     = (await idbGet(KEYS.tags)) || lsGet(KEYS.tags) || [];
    _data.images   = (await idbGet(KEYS.images)) || lsGet(KEYS.images) || [];
    _data.comments = (await idbGet(KEYS.comments)) || lsGet(KEYS.comments) || [];
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
    if (!config || !config.projectId) {
      _firestoreEnabled = false;
      emitSyncStatus('disabled');
      return false;
    }

    try {
      // Firebase je već učitan via CDN script tag
      if (!firebase.apps.length) {
        firebase.initializeApp(config);
      }
      _db = firebase.firestore();
      _firestoreEnabled = true;

      // Provjera veze
      await _db.enableNetwork();
      emitSyncStatus('connected');

      // Slušaj online/offline događaje
      window.addEventListener('online', onOnline);
      window.addEventListener('offline', onOffline);

      console.log('[DB] Firestore spojen:', config.projectId);
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
    queueAdd({ collection: 'persons', op: 'set', id: person.id, data: person });
    if (_firestoreEnabled && _autoSync && navigator.onLine) syncPerson(person);
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
    // Obriši i sve tagove ove osobe
    _data.tags = _data.tags.filter(t => t.person_id !== id);
    saveToStorage('persons');
    saveToStorage('tags');
    queueAdd({ collection: 'persons', op: 'delete', id });
    queueAdd({ collection: 'tags', op: 'deleteWhere', field: 'person_id', value: id });
    if (_firestoreEnabled && _autoSync && navigator.onLine) {
      _db.collection('persons').doc(id).delete().catch(console.error);
    }
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
    queueAdd({ collection: 'tags', op: 'set', id: tag.id, data: tag });
    if (_firestoreEnabled && _autoSync && navigator.onLine) syncTag(tag);
    return tag;
  }

  function deleteTag(id) {
    _data.tags = _data.tags.filter(t => t.id !== id);
    saveToStorage('tags');
    queueAdd({ collection: 'tags', op: 'delete', id });
    if (_firestoreEnabled && _autoSync && navigator.onLine) {
      _db.collection('tags').doc(id).delete().catch(console.error);
    }
  }

  // ── Images ──

  function getAllImages() { return [..._data.images]; }

  function getImageByDriveId(driveId) {
    return _data.images.find(img => img.original_drive_id === driveId) || null;
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
    queueAdd({ collection: 'images', op: 'set', id: image.id, data: image });
    if (_firestoreEnabled && _autoSync && navigator.onLine) syncImage(image);
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
    queueAdd({ collection: 'comments', op: 'delete', id: commentId });
    if (_firestoreEnabled && _autoSync && navigator.onLine) {
      _db.collection('comments').doc(commentId).delete().catch(console.error);
    }
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
    queueAdd({ collection: 'comments', op: 'set', id: comment.id, data: comment });
    if (_firestoreEnabled && _autoSync && navigator.onLine) {
      _db.collection('comments').doc(comment.id).set(comment).catch(console.error);
    }
    return comment;
  }

  // ─── Firestore sync operacije ──────────────────────────────────────────────

  async function syncPerson(person) {
    if (!_firestoreEnabled || !_db) return;
    try { await _db.collection('persons').doc(person.id).set(person); }
    catch (e) { console.error('[DB] Sync person error:', e.message); }
  }

  async function syncTag(tag) {
    if (!_firestoreEnabled || !_db) return;
    try { await _db.collection('tags').doc(tag.id).set(tag); }
    catch (e) { console.error('[DB] Sync tag error:', e.message); }
  }

  async function syncImage(image) {
    if (!_firestoreEnabled || !_db) return;
    try { await _db.collection('images').doc(image.id).set(image); }
    catch (e) { console.error('[DB] Sync image error:', e.message); }
  }

  /**
   * Šalje sve pending operacije iz sync queue na Firestore.
   */
  async function flushQueue() {
    if (!_firestoreEnabled || !_db || _syncInProgress) return;
    const queue = queueGet();
    if (queue.length === 0) return;

    _syncInProgress = true;
    emitSyncStatus('syncing');

    try {
      const batch = _db.batch();
      let batchCount = 0;

      for (const op of queue) {
        const ref = _db.collection(op.collection).doc(op.id);
        if (op.op === 'set' && op.data) {
          batch.set(ref, op.data, { merge: true });
          batchCount++;
        } else if (op.op === 'delete') {
          batch.delete(ref);
          batchCount++;
        }

        // Firestore batch limit je 500
        if (batchCount >= 450) break;
      }

      if (batchCount > 0) await batch.commit();
      queueClear();
      emitSyncStatus('connected');
      console.log(`[DB] Sinkronizirano ${batchCount} operacija`);
    } catch (e) {
      console.error('[DB] Flush queue greška:', e.message);
      emitSyncStatus('error', e.message);
    } finally {
      _syncInProgress = false;
    }
  }

  /**
   * Povlači sve podatke iz Firestorea i zamjenjuje lokalne.
   */
  async function pullFromFirestore() {
    if (!_firestoreEnabled || !_db) return false;
    emitSyncStatus('syncing');

    try {
      const [personsSnap, tagsSnap, imagesSnap] = await Promise.all([
        _db.collection('persons').get(),
        _db.collection('tags').get(),
        _db.collection('images').get()
      ]);

      const personsRemote = personsSnap.docs.map(d => d.data());
      const tagsRemote    = tagsSnap.docs.map(d => d.data());
      const imagesRemote  = imagesSnap.docs.map(d => d.data());

      // Merge: remote pobjeđuje ako je noviji
      _data.persons = mergeCollections(_data.persons, personsRemote);
      _data.tags    = mergeCollections(_data.tags, tagsRemote);
      _data.images  = mergeCollections(_data.images, imagesRemote);

      saveToStorage('persons');
      saveToStorage('tags');
      saveToStorage('images');

      emitSyncStatus('connected');
      console.log(`[DB] Povučeno iz Firestorea: ${personsRemote.length} osoba, ${tagsRemote.length} tagova, ${imagesRemote.length} slika`);
      return true;
    } catch (e) {
      console.error('[DB] Pull greška:', e.message);
      emitSyncStatus('error', e.message);
      return false;
    }
  }

  /**
   * Spaja lokalnu i remote kolekciju po ID-u.
   * Remote pobjeđuje ako je updated_at noviji.
   */
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
  function getSettings() {
    return lsGet(KEYS.settings) || {
      jpegQuality: 92,
      showLabels: true,
      autoSync: true,
      inputFolderId: null,
      inputFolderName: null,
      outputFolderId: null,
      outputFolderName: null,
      portraitsSubfolder: 'Portreti'
    };
  }

  function saveSettings(settings) {
    const current = getSettings();
    const merged = { ...current, ...settings };
    lsSet(KEYS.settings, merged);
    _autoSync = merged.autoSync !== false;
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
