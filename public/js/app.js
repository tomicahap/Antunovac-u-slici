/**
 * app.js – Glavni SPA controller.
 * Inicijalizira sve module, spaja OAuth flow, galeriju i Search.
 */

const App = (function () {
  'use strict';

  let _authStatus = null;
  let _galleryNextPageToken = null;
  let _galleryFiles = [];
  let _folderPickerTarget = null; // 'input' | 'output'
  let _folderPickerSelectedId = null;
  let _folderPickerBreadcrumb = [{ id: 'root', name: 'Moj Drive' }];

  let _userRole = 'visitor'; // 'admin' | 'visitor'

  // ─── Inicijalizacija ───────────────────────────────────────────────────────

  async function init() {
    function hideSplash() {
      const splash = document.getElementById('splash-screen');
      const appEl = document.getElementById('app');
      if (appEl) appEl.style.display = '';
      if (splash && splash.style.display !== 'none') {
        splash.classList.add('hiding');
        setTimeout(() => {
          splash.style.display = 'none';
        }, 300);
      }
    }

    // Tajmer za uvodni zaslon sa slikom logotipa (traje 2.0 sekundi kako bi se logotip vidio)
    setTimeout(hideSplash, 2000);

    try {
      // Inicijaliziraj module
      DB.init();
      UI.init();

      // Dohvati konfiguraciju s backenda
      let config = {};
      try {
        config = await DriveAPI.getConfig();
      } catch (e) {
        console.warn('[App] Config nedostupan:', e.message);
      }

      // Inicijaliziraj Firestore
      if (config.firebase && config.firebase.projectId) {
        try {
          await DB.initFirestore(config.firebase);
          await DB.pullFromFirestore();
        } catch (e) {
          console.warn('[App] Firestore init error:', e.message);
        }
      }

      // Inicijaliziraj sve module
      CanvasEngine.init('main-canvas', 'canvas-wrapper');
      Persons.init();
      Tags.init();
      Comments.init();
      ExportImport.init();
      Keyboard.init();

      // Canvas cursor position → status bar
      CanvasEngine.onCursorPos = (x, y) => {
        const el = document.getElementById('status-cursor-pos');
        if (el) el.textContent = `${x}%, ${y}%`;
      };

      // Settings iz DB-a
      applySettings(DB.getSettings());

      // Provjeri OAuth status
      await checkAuthStatus();

      // URL parametri (OAuth callback)
      handleUrlParams();

      // Priklopi event listenere
      bindEvents();

      // Pogled iz URL hash-a ili zadano
      const hash = window.location.hash.replace('#', '');
      UI.showView(['gallery','editor','persons','comments','search','export','settings'].includes(hash) ? hash : 'gallery');

      // Automatski učitaj galeriju ako je mapa odabrana
      const settings = DB.getSettings();
      if (settings.inputFolderId) {
        loadGallery(settings.inputFolderId);
      }
    } catch (err) {
      console.error('[App] Init greška:', err);
      alert('Kritična greška pri pokretanju aplikacije:\n' + err.message + '\n\nMolim javite ovu grešku programeru.');
    } finally {
      hideSplash();
    }
  }

  function getUserRole() {
    return sessionStorage.getItem('agf_user_role') || 'visitor';
  }

  function setUserRole(role) {
    _userRole = role;
    sessionStorage.setItem('agf_user_role', role);
    updateRoleUI();
  }

  // ─── OAuth & Uloge ─────────────────────────────────────────────────────────

  async function checkAuthStatus() {
    try {
      _authStatus = await DriveAPI.getAuthStatus();
    } catch {
      _authStatus = { authenticated: false, user: null };
    }
    if (_authStatus?.authenticated) {
      setUserRole('admin');
    } else {
      _userRole = getUserRole();
      updateRoleUI();
    }
    renderAuthSection();
    return _authStatus;
  }

  function updateRoleUI() {
    const btnLock = document.getElementById('nav-btn-lock');
    const btnLogout = document.getElementById('nav-btn-logout');

    const navEditor = document.getElementById('nav-editor')?.parentElement;
    const navPersons = document.getElementById('nav-persons')?.parentElement;
    const navComments = document.getElementById('nav-comments')?.parentElement;
    const navExport = document.getElementById('nav-export')?.parentElement;
    const navSettings = document.getElementById('nav-settings')?.parentElement;

    if (_userRole === 'visitor' && !_authStatus?.authenticated) {
      if (navEditor) navEditor.style.display = 'none';
      if (navPersons) navPersons.style.display = 'none';
      if (navComments) navComments.style.display = 'none';
      if (navExport) navExport.style.display = 'none';
      if (navSettings) navSettings.style.display = 'none';
      
      const hash = window.location.hash.replace('#', '');
      if (hash !== 'gallery') UI.showView('gallery');
    } else {
      if (navEditor) navEditor.style.display = '';
      if (navPersons) navPersons.style.display = '';
      if (navComments) navComments.style.display = '';
      if (navExport) navExport.style.display = '';
      if (navSettings) navSettings.style.display = '';
    }

    if (typeof Comments !== 'undefined') {
      Comments.setRole(_userRole);
    }

    if (btnLock) {
      if (_authStatus?.authenticated) {
        btnLock.innerHTML = '🔓 Google Drive Spojen';
        btnLock.className = 'btn btn-primary btn-xs';
      } else if (_userRole === 'admin') {
        btnLock.innerHTML = '🔓 Administrator (Test)';
        btnLock.className = 'btn btn-primary btn-xs';
      } else {
        btnLock.innerHTML = '🔒 Prijava';
        btnLock.className = 'btn btn-outline btn-xs';
      }
    }

    if (btnLogout) {
      if (_userRole === 'admin' || _authStatus?.authenticated) {
        btnLogout.classList.remove('hidden');
      } else {
        btnLogout.classList.add('hidden');
      }
    }

    if (navExport) navExport.style.display = _userRole === 'admin' ? '' : 'none';

    // Editor kontrole za označavanje
    const modeDraw = document.getElementById('mode-draw');
    const btnSaveDone = document.getElementById('btn-save-done');
    const tagsListContainer = document.getElementById('sidebar-tags-list-container');
    const btnAddTagFrame = document.getElementById('btn-add-tag-frame');
    const btnDeleteTag = document.getElementById('btn-sidebar-delete-tag');
    const tagSearchContainer = document.querySelector('.tag-search-container');
    const donorInput = document.getElementById('editor-image-donor');

    if (modeDraw) modeDraw.style.display = _userRole === 'admin' ? '' : 'none';
    if (btnSaveDone) btnSaveDone.style.display = _userRole === 'admin' ? '' : 'none';
    if (btnAddTagFrame) btnAddTagFrame.style.display = _userRole === 'admin' ? '' : 'none';
    if (btnDeleteTag) btnDeleteTag.style.display = _userRole === 'admin' ? '' : 'none';
    if (tagSearchContainer) tagSearchContainer.style.display = _userRole === 'admin' ? '' : 'none';
    if (donorInput) donorInput.disabled = (_userRole !== 'admin');


    if (tagsListContainer) tagsListContainer.style.display = ''; // Prikazujemo listu oznaka i za admina i posjetitelja

    CanvasEngine.setReadOnly(_userRole !== 'admin');

    // Baza osoba
    const btnAddPerson = document.getElementById('btn-add-person');
    if (btnAddPerson) btnAddPerson.style.display = _userRole === 'admin' ? '' : 'none';
  }

  function renderAuthSection() {
    const section = document.getElementById('drive-auth-section');
    const folderSection = document.getElementById('drive-folder-section');
    const userEl = document.getElementById('nav-user');
    if (!section) return;

    if (_authStatus?.authenticated) {
      const user = _authStatus.user || {};
      section.innerHTML = `
        <div class="drive-auth-connected">
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 10l4 4 8-8"/></svg>
          <div>
            <div style="font-size:.85rem;font-weight:600;">${UI.escapeHtml(user.name || 'Google korisnik')}</div>
            <div style="font-size:.75rem;color:var(--text-muted);">${UI.escapeHtml(user.email || '')}</div>
          </div>
          <button class="btn btn-ghost btn-xs" id="btn-logout" style="margin-left:auto;">Odjava</button>
        </div>
      `;
      if (folderSection) folderSection.style.display = '';
      document.getElementById('btn-logout')?.addEventListener('click', logout);

      // User avatar
      if (userEl && user.picture) {
        userEl.innerHTML = `<div class="user-avatar"><img src="${user.picture}" alt="${UI.escapeHtml(user.name || '')}"></div>`;
      }
    } else {
      section.innerHTML = `
        <div class="drive-auth-disconnected">
          <p class="card-desc">Spojite Google Drive za pristup fotografijama.</p>
          <button class="btn btn-primary btn-sm" id="btn-connect-drive">
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M18 13.8L12.6 4H7.4L2 13.8l2.6 3.4h10.8L18 13.8z"/>
              <path d="M2 13.8h16M7.4 4l4.8 9.8M12.6 4L7.8 13.8"/>
            </svg>
            Poveži Google Drive
          </button>
          
          <div style="margin: 15px 0; text-align: center; font-size: 0.85rem; color: var(--text-muted);">ILI</div>
          
          <p class="card-desc">Učitajte klijentski OAuth JSON (client_secret.json):</p>
          <input type="file" id="oauth-config-upload" accept=".json,application/json" style="display: none;">
          <button class="btn btn-secondary btn-sm" id="btn-upload-oauth">
            Odaberi OAuth JSON
          </button>
          <div id="credentials-card" style="display:none;"></div>
        </div>
      `;
      if (folderSection) folderSection.style.display = 'none';
      document.getElementById('btn-connect-drive')?.addEventListener('click', connectDrive);

      const oauthUpload = document.getElementById('oauth-config-upload');
      document.getElementById('btn-upload-oauth')?.addEventListener('click', () => oauthUpload.click());
      oauthUpload?.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
          UI.showLoading('Učitavanje konfiguracije...');
          const text = await file.text();
          await DriveAPI.uploadOAuthConfig(text);
          UI.toast('OAuth konfiguracija uspješno učitana. Preusmjeravanje...', 'success');
          // Nakon učitavanja pokreni Google Auth flow
          connectDrive();
        } catch (err) {
          UI.toast('Greška: ' + err.message, 'error');
        } finally {
          UI.hideLoading();
          e.target.value = ''; // reset
        }
      });
    }
  }

  async function connectDrive() {
    try {
      UI.showLoading('Preusmjeravanje na Google...');
      const url = await DriveAPI.getAuthUrl();
      window.location.href = url;
    } catch (e) {
      UI.hideLoading();
      UI.toast('Greška: ' + e.message, 'error');
    }
  }

  async function logout() {
    const confirmed = await UI.confirm('Odjaviti se iz Admin načina i Google Drive-a?', 'Odjava');
    if (!confirmed) return;
    try {
      await DriveAPI.logout();
    } catch {}
    _authStatus = { authenticated: false, user: null };
    setUserRole('visitor');
    renderAuthSection();
    UI.toast('Odjavljen. Prikaz je preklopljen na Posjetitelja.', 'info');
  }

  function handleUrlParams() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('auth_success')) {
      const warning = params.get('warning');
      if (warning === 'no_admin') {
        UI.toast('Prijavljeni ste, ali nemate administratorske ovlasti.', 'warning');
      } else {
        UI.toast('Uspješno spojeni s Google Drive-om kao Administrator!', 'success');
      }
      checkAuthStatus();
      window.history.replaceState({}, '', '/');
    }
    if (params.get('auth_error')) {
      UI.toast('Greška pri prijavi: ' + params.get('auth_error'), 'error');
      window.history.replaceState({}, '', '/');
    }
  }

  // ─── Galerija ─────────────────────────────────────────────────────────────

  async function loadGallery(folderId, append = false) {
    // Ako Drive nije spojen, automatski dohvaćamo podatke iz lokalne baze
    if (!_authStatus?.driveConnected) {
       const images = DB.getAllImages();
       _galleryFiles = images.map(img => ({
         id: img.original_drive_id,
         name: img.original_filename,
         mimeType: 'image/jpeg'
       }));
       renderCurrentGallery();
       return;
    }

    if (!folderId) return;

    const grid = document.getElementById('gallery-grid');
    const emptyEl = document.getElementById('gallery-empty');
    const loadMoreEl = document.getElementById('gallery-load-more');

    if (!append) {
      _galleryFiles = [];
      _galleryNextPageToken = null;
      grid.querySelectorAll('.gallery-item,.gallery-item-loading').forEach(el => el.remove());
      // Prikaži spinner
      for (let i = 0; i < 8; i++) {
        const ph = document.createElement('div');
        ph.className = 'gallery-item-loading';
        ph.innerHTML = '<div class="spinner"></div>';
        grid.appendChild(ph);
      }
    }

    try {
      if (!append) {
        const result = await DriveAPI.getFiles(folderId, _galleryNextPageToken, 40);
        _galleryNextPageToken = result.nextPageToken || null;
        _galleryFiles = result.files || [];
      } else {
        const result = await DriveAPI.getFiles(folderId, _galleryNextPageToken, 40);
        _galleryNextPageToken = result.nextPageToken || null;
        _galleryFiles.push(...(result.files || []));
      }
      renderCurrentGallery();
    } catch (e) {
      grid.querySelectorAll('.gallery-item-loading').forEach(el => el.remove());
      UI.toast('Greška pri učitavanju galerije: ' + e.message, 'error');
    }
  }

  function renderCurrentGallery() {
    const grid = document.getElementById('gallery-grid');
    const emptyEl = document.getElementById('gallery-empty');
    const loadMoreEl = document.getElementById('gallery-load-more');
    
    grid.querySelectorAll('.gallery-item,.gallery-item-loading').forEach(el => el.remove());

    let currentTab = 'portraits'; // Zadano
    const activeTabBtn = document.querySelector('.gallery-tab-btn.active');
    if (activeTabBtn) currentTab = activeTabBtn.dataset.tab;

    const query = (document.getElementById('gallery-search-input')?.value || '').toLowerCase().trim();

    if (currentTab === 'portraits') {
      const allTags = DB.getAllTags();
      // Prikazujemo samo oznake koje imaju povezanu osobu
      const portraitTags = allTags.filter(t => t.person_id);

      const filteredTags = portraitTags.filter(t => {
        const p = DB.getPersonById(t.person_id);
        if (!p) return false;
        const name = `${p.ime || ''} ${p.prezime || ''}`.toLowerCase();
        const note = (p.napomena || '').toLowerCase();
        
        if (!query) return true;
        return name.includes(query) || note.includes(query);
      });

      // Ažuriraj brojke
      const countEl = document.getElementById('gallery-count');
      if (countEl) countEl.textContent = `${filteredTags.length} portreta`;

      if (filteredTags.length === 0) {
        if (emptyEl) emptyEl.style.display = '';
        if (loadMoreEl) loadMoreEl.style.display = 'none';
        return;
      }

      if (emptyEl) emptyEl.style.display = 'none';
      if (loadMoreEl) loadMoreEl.style.display = 'none';

      filteredTags.forEach(tag => {
        const person = DB.getPersonById(tag.person_id);
        if (person) {
          grid.appendChild(createPortraitItem(tag, person));
        }
      });
      return;
    }

    // Fotografije
    let filesToRender = _galleryFiles;
    
    filesToRender = filesToRender.filter(file => {
      const imageRec = DB.getImageByDriveId(file.id);
      const tags = imageRec ? DB.getTagsByImageId(imageRec.id) : [];
      const tagCount = tags.length;
      
      // Filteri na temelju uloge
      if (_userRole === 'visitor') {
        // Posjetitelj vidi samo označene slike
        if (tagCount === 0) return false;
      } else {
        // Admin subtab filteri
        const subtab = document.querySelector('#gallery-subtabs .active')?.dataset.subtab || 'untagged';
        if (subtab === 'tagged' && tagCount === 0) return false;
        if (subtab === 'untagged' && tagCount > 0) return false;
      }

      // Pretraga
      if (!query) return true;

      const matchName = file.name.toLowerCase().includes(query);
      const matchDonor = imageRec && imageRec.donor && imageRec.donor.toLowerCase().includes(query);
      const matchPerson = tags.some(t => {
        const p = DB.getPersonById(t.person_id);
        if (!p) return false;
        return `${p.ime || ''} ${p.prezime || ''}`.toLowerCase().includes(query);
      });

      return matchName || matchDonor || matchPerson;
    });

    // Ažuriraj brojke
    const countEl = document.getElementById('gallery-count');
    if (countEl) countEl.textContent = `${filesToRender.length} slika`;

    if (filesToRender.length === 0) {
      if (emptyEl) emptyEl.style.display = '';
      if (loadMoreEl) loadMoreEl.style.display = 'none';
    } else {
      if (emptyEl) emptyEl.style.display = 'none';
      filesToRender.forEach(file => {
        grid.appendChild(createGalleryItem(file));
      });
    }

    if (loadMoreEl) {
      loadMoreEl.style.display = (_galleryNextPageToken && _authStatus?.driveConnected) ? '' : 'none';
    }
  }

  function createPortraitItem(tag, person) {
    const el = document.createElement('div');
    el.className = 'gallery-item portrait-gallery-item';
    el.style.display = 'flex';
    el.style.flexDirection = 'column';
    el.style.background = 'var(--bg-surface)';
    el.style.border = '1px solid var(--border)';
    el.style.borderRadius = 'var(--radius-md)';
    el.style.overflow = 'hidden';
    el.style.transition = 'transform 0.2s, box-shadow 0.2s';
    el.style.cursor = 'pointer';

    const name = `${person.ime || ''} ${person.prezime || ''}`.trim() || 'Nepoznata osoba';
    const birthStr = person.godina_rodenja ? person.godina_rodenja : '?';
    const deathStr = person.godina_smrti ? person.godina_smrti : '?';
    let lifespan = '';
    if (person.godina_rodenja || person.godina_smrti) {
      lifespan = `(${birthStr} - ${deathStr})`;
    }

    const imageRec = DB.getAllImages().find(img => img.id === tag.image_id || img.original_drive_id === tag.image_id);
    const driveFileId = imageRec ? imageRec.original_drive_id : tag.image_id;

    let imgHtml = '';
    let containerStyle = '';
    if (tag.portrait_drive_id) {
      const thumbUrl = DriveAPI.getThumbnailUrl(tag.portrait_drive_id, 400);
      containerStyle = 'width: 100%; position: relative; overflow: hidden; background: #000;';
      imgHtml = `<img src="${thumbUrl}" alt="${name}" style="width: 100%; height: auto; display: block;" loading="lazy">`;
    } else {
      const originalThumbUrl = DriveAPI.getThumbnailUrl(driveFileId, 800);
      const widthPct = (100 / tag.width) * 100;
      const leftPct = (tag.x / tag.width) * 100;
      const topPct = (tag.y / tag.height) * 100;
      containerStyle = 'width: 100%; aspect-ratio: 3.5/4.5; overflow: hidden; background: #000; display: flex; align-items: center; justify-content: center; position: relative;';
      imgHtml = `<img src="${originalThumbUrl}" style="position: absolute; width: ${widthPct}%; left: -${leftPct}%; top: -${topPct}%; max-width: none;" loading="lazy">`;
    }

    el.innerHTML = `
      <div style="${containerStyle}">
        ${imgHtml}
      </div>
      <div style="padding: var(--space-sm); display: flex; flex-direction: column; flex: 1;">
        <h3 style="font-size: 0.95rem; margin: 0 0 2px 0; color: var(--text-primary); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
          ${UI.escapeHtml(name)}
        </h3>
        <p style="font-size: 0.75rem; color: var(--text-muted); margin: 0 0 8px 0;">
          ${lifespan}
        </p>
        <button class="btn btn-primary btn-xs" style="margin-top: auto; font-size: 0.75rem; width: 100%;">Prikaži cijelu sliku</button>
      </div>
    `;

    el.addEventListener('click', () => {
      const imageRec = DB.getAllImages().find(img => img.id === tag.image_id || img.original_drive_id === tag.image_id);
      if (imageRec) {
        if (_userRole === 'visitor') {
          CanvasEngine.setReadOnly(true);
        } else {
          CanvasEngine.setReadOnly(false);
        }
        openInEditor({
          id: imageRec.original_drive_id,
          name: imageRec.original_filename
        });
      } else {
        UI.toast('Originalna slika nije pronađena.', 'error');
      }
    });

    return el;
  }

  function createGalleryItem(file) {
    const item = document.createElement('div');
    item.className = 'gallery-item';
    item.dataset.fileId = file.id;
    item.dataset.filename = file.name;

    const imageRec = DB.getImageByDriveId(file.id);
    if (imageRec?.status === 'processed') item.classList.add('processed');

    const thumbUrl = DriveAPI.getThumbnailUrl(file.id, 400);

    const img = document.createElement('img');
    img.className = 'gallery-item-img';
    img.alt = file.name;
    img.loading = 'lazy';
    img.src = thumbUrl;
    img.onerror = () => {
      img.style.display = 'none';
      item.style.background = 'var(--bg-elevated)';
    };

    const tags = imageRec ? DB.getTagsByImageId(imageRec.id) : [];
    const tagCount = tags.length;

    const overlay = document.createElement('div');
    overlay.className = 'gallery-item-overlay';
    
    let tagsHtml = '';
    if (tagCount > 0) {
      tagsHtml = '<div style="display:flex; flex-direction:column; gap:4px; margin-top:8px;">';
      tags.forEach(t => {
        const p = DB.getPersonById(t.person_id);
        const name = p ? UI.formatPersonName(p) : 'Nepoznato';
        const years = p ? ((p.godina_rodenja || '?') + ' - ' + (p.godina_smrti || '?')) : '';
        const portThumb = t.portrait_drive_id 
          ? DriveAPI.getThumbnailUrl(t.portrait_drive_id, 100)
          : thumbUrl;

        // Ako je portret eksportiran, možemo ga prikazati izravno, inače CSS crop
        if (t.portrait_drive_id) {
          tagsHtml += `
            <div style="display:flex; align-items:center; gap:8px; background:rgba(0,0,0,0.6); padding:4px; border-radius:4px;">
              <img src="${portThumb}" style="width:35px; height:45px; object-fit:cover; border-radius:2px; flex-shrink:0;">
              <div style="display:flex; flex-direction:column; font-size:0.75rem; line-height:1.2;">
                <span style="font-weight:600; color:#fff;">${UI.escapeHtml(name)}</span>
                <span style="color:#aaa; font-size:0.7rem;">${years}</span>
              </div>
            </div>
          `;
        } else {
          const widthPct = (100 / t.width) * 100;
          const leftPct = (t.x / t.width) * 100;
          const topPct = (t.y / t.height) * 100;
          tagsHtml += `
            <div style="display:flex; align-items:center; gap:8px; background:rgba(0,0,0,0.6); padding:4px; border-radius:4px;">
              <div style="position:relative; width:35px; height:45px; overflow:hidden; border-radius:2px; flex-shrink:0; background:#000;">
                <img src="${thumbUrl}" style="position:absolute; width:${widthPct}%; left:-${leftPct}%; top:-${topPct}%; max-width:none;">
              </div>
              <div style="display:flex; flex-direction:column; font-size:0.75rem; line-height:1.2;">
                <span style="font-weight:600; color:#fff;">${UI.escapeHtml(name)}</span>
                <span style="color:#aaa; font-size:0.7rem;">${years}</span>
              </div>
            </div>
          `;
        }
      });
      tagsHtml += '</div>';
    }

    const donorHtml = imageRec?.donor ? `<div class="gallery-item-donor" style="font-size:0.7rem; color:#8b949e; margin-top:4px; font-style:italic;">Darovao: ${UI.escapeHtml(imageRec.donor)}</div>` : '';
    overlay.innerHTML = `
      <div class="gallery-item-name" style="font-weight:600;">${UI.escapeHtml(file.name)}</div>
      ${donorHtml}
      ${tagsHtml}
    `;

    item.appendChild(img);
    item.appendChild(overlay);

    item.addEventListener('click', () => {
       if (_userRole === 'visitor') {
         CanvasEngine.setReadOnly(true);
       } else {
         CanvasEngine.setReadOnly(false);
       }
       openInEditor(file);
    });
    return item;
  }

  async function openInEditor(file) {
    UI.showView('editor');
    UI.showLoading('Učitavanje optimizirane fotografije (1600px)...');

    try {
      // Koristimo optimizirani thumbnail od 1600px za crtanje i označavanje
      const optimizedUrl = DriveAPI.getThumbnailUrl(file.id, 1600);
      await CanvasEngine.loadImageFromUrl(optimizedUrl, file.id, file);

      document.getElementById('editor-filename').textContent = file.name;

      // Inicijaliziraj image record u DB
      let imageRec = DB.getImageByDriveId(file.id);
      if (!imageRec) {
        imageRec = DB.saveImage({
          original_drive_id: file.id,
          original_filename: file.name,
          folder_id: DB.getSettings().inputFolderId,
          status: 'pending'
        });
      }

      // Učitaj ime darovatelja u polje
      const donorInput = document.getElementById('editor-image-donor');
      if (donorInput) {
        donorInput.value = imageRec ? (imageRec.donor || '') : '';
      }

      // Učitaj postojeće oznake
      const tags = DB.getTagsByImageId(imageRec.id);
      const persons = DB.getAllPersons();
      CanvasEngine.setTags(tags, persons);
      Tags.renderTagsList(imageRec.id);
      Tags.setCurrentImageId(imageRec.id);

      // Učitaj komentare
      renderEditorComments(file.id);
    } catch (e) {
      UI.toast('Greška: ' + e.message, 'error');
    } finally {
      UI.hideLoading();
    }
  }

  function renderEditorComments(fileId) {
    const list = document.getElementById('editor-comments-list');
    const countEl = document.getElementById('editor-comments-count');
    if (!list) return;

    const comments = DB.getComments('image', fileId);
    if (countEl) countEl.textContent = comments.length;

    if (comments.length === 0) {
      list.innerHTML = '<p class="text-muted" style="padding: 4px 0;">Nema komentara.</p>';
      return;
    }

    list.innerHTML = comments.map(c => `
      <div class="comment-item" style="background: var(--bg-elevated); padding: 6px; border-radius: 4px; margin-bottom: 6px;">
        <div style="font-weight: 600; color: var(--text-color); font-size: 0.8rem;">${UI.escapeHtml(c.author_name)} <span style="font-size: 0.7rem; color: var(--text-muted); font-weight: normal;">${new Date(c.created_at).toLocaleDateString('hr-HR')}</span></div>
        <div style="color: var(--text-secondary); margin-top: 2px; font-size: 0.8rem;">${UI.escapeHtml(c.comment_text)}</div>
      </div>
    `).join('');
  }

  // ─── Folder Picker ────────────────────────────────────────────────────────

  function openFolderPicker(target) {
    _folderPickerTarget = target;
    _folderPickerSelectedId = null;
    
    const settings = DB.getSettings();
    const startFolderId = settings.defaultStartFolder || 'root';
    
    _folderPickerBreadcrumb = [{ id: startFolderId, name: startFolderId === 'root' ? 'Moj Drive' : 'Polazišna mapa' }];
    
    document.getElementById('modal-folder-title').textContent =
      target === 'input' ? 'Odaberi ulaznu mapu' : 'Odaberi izlaznu mapu';
    document.getElementById('btn-folder-select').disabled = true;
    renderFolderBreadcrumb();
    loadFolderList(startFolderId);
    UI.openModal('modal-folder-picker');
  }

  function renderFolderBreadcrumb() {
    const bc = document.getElementById('folder-breadcrumb');
    if (!bc) return;
    bc.innerHTML = _folderPickerBreadcrumb.map((item, idx) => {
      const isCurrent = idx === _folderPickerBreadcrumb.length - 1;
      return `<span class="breadcrumb-item ${isCurrent ? 'current' : ''}" data-id="${item.id}">
        ${UI.escapeHtml(item.name)}
      </span>${!isCurrent ? '<span class="breadcrumb-sep">›</span>' : ''}`;
    }).join('');

    bc.querySelectorAll('.breadcrumb-item:not(.current)').forEach(el => {
      el.addEventListener('click', () => {
        const id = el.dataset.id;
        const idx = _folderPickerBreadcrumb.findIndex(b => b.id === id);
        if (idx > -1) _folderPickerBreadcrumb = _folderPickerBreadcrumb.slice(0, idx + 1);
        renderFolderBreadcrumb();
        loadFolderList(id);
      });
    });
  }

  async function loadFolderList(parentId) {
    const list = document.getElementById('folder-list');
    const loadingEl = document.getElementById('folder-list-loading');
    if (!list) return;
    if (loadingEl) loadingEl.style.display = '';
    list.querySelectorAll('.folder-list-item').forEach(el => el.remove());

    try {
      const result = await DriveAPI.getFolders(parentId);
      if (loadingEl) loadingEl.style.display = 'none';

      const folders = result.folders || [];
      if (folders.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'folder-list-empty';
        empty.textContent = 'Nema podmapa u ovoj mapi.';
        list.appendChild(empty);
        return;
      }

      folders.forEach(folder => {
        const item = document.createElement('div');
        item.className = 'folder-list-item';
        item.dataset.folderId = folder.id;
        item.innerHTML = `
          <svg viewBox="0 0 20 20"><path d="M2 5h6l2 2h8v10H2z" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>
          <span class="folder-list-item-name">${UI.escapeHtml(folder.name)}</span>
          <span class="folder-list-item-chevron">
            <svg viewBox="0 0 14 14"><path d="M5 3l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          </span>
        `;

        item.addEventListener('click', (e) => {
          if (e.target.closest('.folder-list-item-chevron')) {
            // Uđi u podmаpu
            _folderPickerBreadcrumb.push({ id: folder.id, name: folder.name });
            renderFolderBreadcrumb();
            loadFolderList(folder.id);
          } else {
            // Odaberi ovu mapu
            list.querySelectorAll('.folder-list-item').forEach(el => el.classList.remove('selected'));
            item.classList.add('selected');
            _folderPickerSelectedId = folder.id;
            document.getElementById('btn-folder-select').disabled = false;
            document.getElementById('btn-folder-select').dataset.folderName = folder.name;
          }
        });

        list.appendChild(item);
      });
    } catch (e) {
      if (loadingEl) loadingEl.style.display = 'none';
      UI.toast('Greška pri učitavanju mapa: ' + e.message, 'error');
    }
  }

  function confirmFolderSelection() {
    if (!_folderPickerSelectedId) return;
    const selectedItem = document.querySelector('.folder-list-item.selected');
    const folderName = selectedItem?.querySelector('.folder-list-item-name')?.textContent || 'Odabrana mapa';

    const settings = DB.getSettings();
    if (_folderPickerTarget === 'input') {
      DB.saveSettings({ inputFolderId: _folderPickerSelectedId, inputFolderName: folderName });
      document.getElementById('input-folder-name').textContent = folderName;
      const subtitle = document.getElementById('gallery-folder-name');
      if (subtitle) subtitle.textContent = folderName;
      loadGallery(_folderPickerSelectedId);
    } else {
      DB.saveSettings({ outputFolderId: _folderPickerSelectedId, outputFolderName: folderName });
      document.getElementById('output-folder-name').textContent = folderName;
    }

    UI.closeModal('modal-folder-picker');
    UI.toast(`Mapa "${folderName}" odabrana.`, 'success');
  }

  // ─── Search ───────────────────────────────────────────────────────────────

  function runSearch() {
    const filters = {
      ime: document.getElementById('search-ime')?.value.trim(),
      prezime: document.getElementById('search-prezime')?.value.trim(),
      djevojacko: document.getElementById('search-djevojacko')?.value.trim(),
      godRodOd: parseInt(document.getElementById('search-god-rod-od')?.value) || null,
      godRodDo: parseInt(document.getElementById('search-god-rod-do')?.value) || null,
      godSmOd: parseInt(document.getElementById('search-god-sm-od')?.value) || null,
      godSmDo: parseInt(document.getElementById('search-god-sm-do')?.value) || null,
      napomena: document.getElementById('search-napomena')?.value.trim()
    };

    let persons = DB.getAllPersons();

    if (filters.ime) persons = persons.filter(p => (p.ime || '').toLowerCase().includes(filters.ime.toLowerCase()));
    if (filters.prezime) persons = persons.filter(p => (p.prezime || '').toLowerCase().includes(filters.prezime.toLowerCase()));
    if (filters.djevojacko) persons = persons.filter(p => (p.djevojacko_prezime || '').toLowerCase().includes(filters.djevojacko.toLowerCase()));
    if (filters.napomena) persons = persons.filter(p => (p.napomena || '').toLowerCase().includes(filters.napomena.toLowerCase()));
    if (filters.godRodOd) persons = persons.filter(p => p.godina_rodenja && p.godina_rodenja >= filters.godRodOd);
    if (filters.godRodDo) persons = persons.filter(p => p.godina_rodenja && p.godina_rodenja <= filters.godRodDo);
    if (filters.godSmOd) persons = persons.filter(p => p.godina_smrti && p.godina_smrti >= filters.godSmOd);
    if (filters.godSmDo) persons = persons.filter(p => p.godina_smrti && p.godina_smrti <= filters.godSmDo);

    const header = document.getElementById('search-results-header');
    const countEl = document.getElementById('search-results-count');
    const list = document.getElementById('search-results-list');

    if (header) header.style.display = '';
    if (countEl) countEl.textContent = `${persons.length} rezultata`;
    if (list) {
      list.innerHTML = '';
      if (persons.length === 0) {
        list.innerHTML = '<p class="text-muted" style="padding:1rem;">Nema rezultata za zadane filtre.</p>';
        return;
      }
      const grid = document.createElement('div');
      grid.className = 'persons-grid';
      persons.forEach(p => {
        grid.appendChild(Persons.renderPersonsGrid ? createSearchResultCard(p) : document.createElement('div'));
      });
      list.appendChild(grid);
    }
  }

  function createSearchResultCard(person) {
    const tags = DB.getTagsByPersonId(person.id);
    const card = document.createElement('div');
    card.className = 'person-card';
    card.innerHTML = `
      <div class="person-card-header">
        <div class="person-avatar">${UI.getInitials(person)}</div>
        <div class="person-card-info">
          <div class="person-fullname">${UI.escapeHtml(UI.formatPersonName(person))}</div>
          ${person.djevojacko_prezime ? `<div class="person-maiden">r. ${UI.escapeHtml(person.djevojacko_prezime)}</div>` : ''}
          ${UI.formatYears(person.godina_rodenja, person.godina_smrti) ? `<div class="person-years">${UI.escapeHtml(UI.formatYears(person.godina_rodenja, person.godina_smrti))}</div>` : ''}
        </div>
      </div>
      ${person.napomena ? `<div class="person-note">${UI.escapeHtml(person.napomena)}</div>` : ''}
      <div class="person-photo-count">👤 ${tags.length} fotografija</div>
    `;
    card.addEventListener('click', () => Persons.openPersonModal(person.id));
    return card;
  }

  // ─── Settings ─────────────────────────────────────────────────────────────

  function applySettings(settings) {
    if (!settings) return;
    const jpegQualityEl = document.getElementById('jpeg-quality');
    if (jpegQualityEl) jpegQualityEl.value = settings.jpegQuality || 92;
    document.getElementById('jpeg-quality-val')?.textContent && (document.getElementById('jpeg-quality-val').textContent = (settings.jpegQuality || 92) + '%');

    const showLabelsEl = document.getElementById('toggle-show-labels');
    if (showLabelsEl) showLabelsEl.checked = settings.showLabels !== false;
    CanvasEngine.showLabels = settings.showLabels !== false;

    document.getElementById('toggle-auto-sync').checked = settings.autoSync !== false;
    document.getElementById('portraits-subfolder-name').value = settings.portraitsSubfolder || 'Portreti';

    const inputName = settings.inputFolderName || 'Nije odabrana';
    const outputName = settings.outputFolderName || 'Nije odabrana';
    document.getElementById('input-folder-name').textContent = inputName;
    document.getElementById('output-folder-name').textContent = outputName;

    const defaultStartFolder = settings.defaultStartFolder || 'root';
    if (document.getElementById('default-start-folder')) {
      document.getElementById('default-start-folder').value = defaultStartFolder;
    }

    const gallerySubtitle = document.getElementById('gallery-folder-name');
    if (gallerySubtitle && settings.inputFolderName) gallerySubtitle.textContent = settings.inputFolderName;
  }

  function saveSettings() {
    let startFolderRaw = document.getElementById('default-start-folder')?.value.trim() || 'root';
    // Ekstrahiraj ID ako je proslijeđen URL
    let startFolderId = startFolderRaw;
    const match = startFolderRaw.match(/folders\/([a-zA-Z0-9-_]+)/);
    if (match) startFolderId = match[1];

    const settings = DB.saveSettings({
      jpegQuality: parseInt(document.getElementById('jpeg-quality')?.value) || 92,
      showLabels: document.getElementById('toggle-show-labels')?.checked !== false,
      autoSync: document.getElementById('toggle-auto-sync')?.checked !== false,
      portraitsSubfolder: document.getElementById('portraits-subfolder-name')?.value || 'Portreti',
      defaultStartFolder: startFolderId
    });
    CanvasEngine.showLabels = settings.showLabels;
    UI.toast('Postavke spremljene.', 'success');
  }

  // ─── Event binding ─────────────────────────────────────────────────────────

  function bindEvents() {
    // Klik na gumb sa slikom lokota (Prijava)
    document.getElementById('nav-btn-lock')?.addEventListener('click', () => {
      if (_userRole === 'admin') {
        UI.showView('settings');
      } else {
        UI.openModal('modal-admin-auth');
      }
    });

    // Klik na Odjavu u navbaru
    document.getElementById('nav-btn-logout')?.addEventListener('click', () => {
      logout();
    });

    // Kontrole unutar modal-admin-auth
    document.getElementById('modal-admin-close')?.addEventListener('click', () => UI.closeModal('modal-admin-auth'));
    document.getElementById('modal-admin-cancel')?.addEventListener('click', () => UI.closeModal('modal-admin-auth'));

    document.getElementById('modal-btn-connect-google')?.addEventListener('click', () => {
      UI.closeModal('modal-admin-auth');
      connectDrive();
    });

    const modalOauthUpload = document.getElementById('modal-oauth-upload');
    document.getElementById('modal-btn-upload-oauth')?.addEventListener('click', () => modalOauthUpload?.click());
    modalOauthUpload?.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        UI.showLoading('Učitavanje konfiguracije...');
        const text = await file.text();
        const res = await DriveAPI.uploadOAuthConfig(text);
        if (res && res.type === 'service_account') {
          UI.toast('Uspješno spojen Google Service Account! Prijavljeni ste.', 'success');
          UI.closeModal('modal-admin-auth');
          await checkAuthStatus();
        } else {
          UI.toast('OAuth klijent učitan. Preusmjeravanje...', 'success');
          UI.closeModal('modal-admin-auth');
          connectDrive();
        }
      } catch (err) {
        UI.toast('Greška pri učitavanju: ' + err.message, 'error');
      } finally {
        UI.hideLoading();
        e.target.value = '';
      }
    });

    document.getElementById('modal-btn-quick-admin')?.addEventListener('click', async () => {
      try {
        await DriveAPI.adminLogin();
      } catch {}
      setUserRole('admin');
      UI.closeModal('modal-admin-auth');
      UI.toast('⚡ Prijavljeni ste kao Administrator!', 'success');
    });

    // Slanje komentara u editoru
    document.getElementById('btn-submit-comment')?.addEventListener('click', () => {
      const fileId = CanvasEngine.currentFileId;
      if (!fileId) return;
      const authorInput = document.getElementById('comment-author');
      const textInput = document.getElementById('comment-text');
      const author = authorInput?.value.trim() || 'Posjetitelj';
      const text = textInput?.value.trim();
      if (!text) {
        UI.toast('Unesite tekst komentara.', 'warning');
        return;
      }
      DB.saveComment({
        target_type: 'image',
        target_id: fileId,
        author_name: author,
        comment_text: text
      });
      if (textInput) textInput.value = '';
      renderEditorComments(fileId);
      UI.toast('Komentar spremljen!', 'success');
    });

    // Natrag na galeriju
    document.getElementById('btn-back-to-gallery')?.addEventListener('click', () => UI.showView('gallery'));

    // Odabir mape u galeriji
    document.getElementById('btn-select-folder')?.addEventListener('click', () => {
      if (!_authStatus?.authenticated) { UI.showView('settings'); return; }
      openFolderPicker('input');
    });

    document.getElementById('btn-go-settings')?.addEventListener('click', () => UI.showView('settings'));

    // Osvježi galeriju
    document.getElementById('btn-refresh-gallery')?.addEventListener('click', () => {
      const settings = DB.getSettings();
      if (settings.inputFolderId) loadGallery(settings.inputFolderId);
    });

    // Paginacija galerije
    document.getElementById('btn-load-more')?.addEventListener('click', () => {
      const settings = DB.getSettings();
      if (settings.inputFolderId && _galleryNextPageToken) loadGallery(settings.inputFolderId, true);
    });

    // Search input u galeriji
    document.getElementById('gallery-search-input')?.addEventListener('input', UI.debounce((e) => {
       renderCurrentGallery();
    }, 300));

    // Gallery tabs
    document.querySelectorAll('.gallery-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.gallery-tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        // Prikaži/sakrij subtabove ovisno o ulozi i izboru
        const currentTab = btn.dataset.tab;
        const subtabs = document.getElementById('gallery-subtabs');
        if (subtabs) {
          subtabs.style.display = (currentTab === 'images' && _userRole === 'admin') ? 'flex' : 'none';
        }

        renderCurrentGallery();
      });
    });

    // Gallery subtabs (Admin sub-filteri za fotografije)
    document.querySelectorAll('#gallery-subtabs button').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#gallery-subtabs button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        renderCurrentGallery();
      });
    });

    // Editor akcijer
    document.getElementById('btn-add-tag-frame')?.addEventListener('click', () => {
      CanvasEngine.createNewTagBoxInCenter();
    });

    document.getElementById('btn-pick-input-folder')?.addEventListener('click', () => {
      if (!_authStatus?.authenticated) { UI.toast('Prvo povežite Google Drive.', 'warning'); return; }
      openFolderPicker('input');
    });
    document.getElementById('btn-pick-output-folder')?.addEventListener('click', () => {
      if (!_authStatus?.authenticated) { UI.toast('Prvo povežite Google Drive.', 'warning'); return; }
      openFolderPicker('output');
    });

    document.getElementById('btn-folder-select')?.addEventListener('click', confirmFolderSelection);
    document.getElementById('btn-folder-cancel')?.addEventListener('click', () => UI.closeModal('modal-folder-picker'));
    document.getElementById('modal-folder-close')?.addEventListener('click', () => UI.closeModal('modal-folder-picker'));

    // Resolve Drive URL
    document.getElementById('btn-resolve-folder-url')?.addEventListener('click', async () => {
      const url = document.getElementById('folder-url-input')?.value.trim();
      if (!url) return;
      try {
        const result = await DriveAPI.resolveUrl(url);
        if (result.id) {
          _folderPickerSelectedId = result.id;
          document.getElementById('btn-folder-select').disabled = false;
          UI.toast(`Pronađeno: ${result.name || result.id}`, 'success');
        }
      } catch (e) {
        UI.toast('Nije moguće parsirati URL: ' + e.message, 'error');
      }
    });

    // Settings
    document.getElementById('btn-save-settings')?.addEventListener('click', saveSettings);

    // JPEG quality slider
    document.getElementById('jpeg-quality')?.addEventListener('input', (e) => {
      document.getElementById('jpeg-quality-val').textContent = e.target.value + '%';
    });

    // Show labels toggle
    document.getElementById('toggle-show-labels')?.addEventListener('change', (e) => {
      CanvasEngine.showLabels = e.target.checked;
    });

    // Validate credentials
    document.getElementById('btn-validate-credentials')?.addEventListener('click', async () => {
      const val = document.getElementById('credentials-input')?.value.trim();
      if (!val) return;
      try {
        const result = await DriveAPI.validateCredentials(val);
        UI.toast(result.message || 'Credentials su valjani.', 'success');
      } catch (e) {
        UI.toast('Greška: ' + e.message, 'error');
      }
    });

    // Pretraga
    document.getElementById('btn-search-go')?.addEventListener('click', runSearch);
    document.getElementById('btn-search-reset')?.addEventListener('click', () => {
      ['search-ime','search-prezime','search-djevojacko','search-god-rod-od','search-god-rod-do','search-god-sm-od','search-god-sm-do','search-napomena']
        .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
      document.getElementById('search-results-header').style.display = 'none';
      document.getElementById('search-results-list').innerHTML = '';
    });
    document.querySelectorAll('#view-search .form-input').forEach(input => {
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });
    });

    // Promjena pogleda
    document.addEventListener('viewChanged', (e) => {
      if (e.detail.view === 'persons') Persons.renderPersonsGrid();
      if (e.detail.view === 'comments') Comments.renderCommentsList();
    });
  }

  // ─── Start ────────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', init);

  return { init, openInEditor, loadGallery };
})();
