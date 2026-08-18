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

  // Varijable za optimizaciju renderiranja i izbjegavanje nepotrebnog reloadanja
  let _lastPortraitsQuery = null;
  let _lastImagesQuery = null;
  let _lastImagesSubtab = null;
  let _lastImagesFilesLength = 0;
  let _portraitsGridPopulated = false;
  let _imagesGridPopulated = false;

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
        if (config.appVersion) {
          const footer = document.getElementById('app-version-footer');
          if (footer) footer.textContent = `Verzija v${config.appVersion}`;
          const settingsText = document.getElementById('settings-version-text');
          if (settingsText) settingsText.textContent = `(Verzija: ${config.appVersion})`;
        }
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

    const isVisitor = _userRole === 'visitor' && !_authStatus?.authenticated;

    if (isVisitor) {
      if (navEditor) navEditor.style.display = 'none';
      if (navPersons) navPersons.style.display = 'none';
      if (navComments) navComments.style.display = 'none';
      if (navExport) navExport.style.display = 'none';
      if (navSettings) navSettings.style.display = 'none';

      // Sakrij gumb za postavke u galeriji i prilagodi tekst za posjetitelje
      const btnGoSettings = document.getElementById('btn-go-settings');
      if (btnGoSettings) btnGoSettings.style.display = 'none';
      const emptyText = document.querySelector('#gallery-empty p');
      if (emptyText) emptyText.textContent = 'U galeriji trenutno nema označenih arhivskih fotografija.';
      const emptyHint = document.querySelector('#gallery-empty .text-muted');
      if (emptyHint) emptyHint.style.display = 'none';
      
      const hash = window.location.hash.replace('#', '');
      if (['settings', 'export', 'editor'].includes(hash)) UI.showView('gallery');
    } else {
      if (navEditor) navEditor.style.display = '';
      if (navPersons) navPersons.style.display = '';
      if (navComments) navComments.style.display = '';
      if (navExport) navExport.style.display = '';
      if (navSettings) navSettings.style.display = '';

      // Prikaži kontrole za admina
      const btnGoSettings = document.getElementById('btn-go-settings');
      if (btnGoSettings) btnGoSettings.style.display = '';
      const emptyText = document.querySelector('#gallery-empty p');
      if (emptyText) emptyText.textContent = 'Nema fotografija u odabranoj mapi.';
      const emptyHint = document.querySelector('#gallery-empty .text-muted');
      if (emptyHint) emptyHint.style.display = '';
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

    // Prikaži/sakrij refresh token karticu ovisno o autorizaciji
    const refreshTokenCard = document.getElementById('refresh-token-card');
    const refreshTokenVal = document.getElementById('refresh-token-val');
    if (refreshTokenCard) {
      if (_authStatus?.authenticated && _authStatus?.refreshToken) {
        refreshTokenCard.style.display = '';
        if (refreshTokenVal) refreshTokenVal.value = _authStatus.refreshToken;
      } else {
        refreshTokenCard.style.display = 'none';
      }
    }

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
    } catch (e) {
      console.warn('[Logout] Greška pri mrežnoj odjavi:', e);
    }
    // Bezuvjetno čišćenje lokalnog stanja
    _authStatus = { authenticated: false, user: null };
    setUserRole('visitor');
    localStorage.removeItem('agf_user_role');
    
    UI.toast('Odjava uspješna. Ponovno učitavam stranicu...', 'info');
    setTimeout(() => {
      window.location.href = '/';
    }, 1000);
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

  // Paginacija i pretraživanje
  let _dbNextStartAfter = null;
  let _dbHasMore = false;
  let _portraitsList = [];
  let _imagesList = [];

  async function loadGallery(folderId, append = false) {
    const currentTab = document.querySelector('.gallery-tab-btn.active')?.dataset.tab || 'portraits';
    const searchQuery = (document.getElementById('gallery-search-input')?.value || '').toLowerCase().trim();
    const gridPortraits = document.getElementById('gallery-portraits-grid');
    const gridImages = document.getElementById('gallery-images-grid');
    const emptyEl = document.getElementById('gallery-empty');
    const loadMoreEl = document.getElementById('gallery-load-more');

    // 1. Pripremi prikaz i očisti ako nije append
    if (!append) {
      _dbNextStartAfter = null;
      _dbHasMore = false;
      _galleryNextPageToken = null;
      _galleryFiles = [];
      _portraitsList = [];
      _imagesList = [];
      _imagesGridPopulated = false;
      _portraitsGridPopulated = false;
      _lastPortraitsQuery = null;
      _lastImagesQuery = null;
      _lastImagesSubtab = null;

      if (currentTab === 'portraits' && gridPortraits) {
        gridPortraits.innerHTML = '';
        for (let i = 0; i < 8; i++) {
          const ph = document.createElement('div');
          ph.className = 'gallery-item-loading';
          ph.innerHTML = '<div class="spinner"></div>';
          gridPortraits.appendChild(ph);
        }
      } else if (gridImages) {
        gridImages.innerHTML = '';
        for (let i = 0; i < 8; i++) {
          const ph = document.createElement('div');
          ph.className = 'gallery-item-loading';
          ph.innerHTML = '<div class="spinner"></div>';
          gridImages.appendChild(ph);
        }
      }
    }

    try {
      // 2. Odredi kako dohvaćamo podatke
      if (currentTab === 'portraits') {
        // PORTRETI: Uvijek iz Firestore baze, s paginacijom i pretraživanjem na backendu
        const response = await fetch(`/api/drive/db/query?tab=portraits&limit=30&startAfter=${_dbNextStartAfter || ''}&search=${encodeURIComponent(searchQuery)}`).then(r => r.json());
        
        // Spremi dobivene osobe u lokalni DB cache za pretrage
        if (response.persons) {
          Object.values(response.persons).forEach(p => {
            DB.savePerson(p, false); // false = ne sinkroniziraj natrag na server
          });
        }

        if (append) {
          _portraitsList.push(...(response.items || []));
        } else {
          _portraitsList = response.items || [];
        }

        _dbNextStartAfter = response.nextStartAfter || null;
        _dbHasMore = response.hasMore || false;
        
        _portraitsGridPopulated = false;
        renderCurrentGallery();

      } else {
        // SLIKE (Fotografije)
        const subtab = document.querySelector('#gallery-subtabs .active')?.dataset.subtab || 'untagged';

        if (_userRole === 'visitor') {
          // Posjetitelj vidi samo slike iz baze koje imaju bar 1 tag
          const response = await fetch(`/api/drive/db/query?tab=images&subtab=tagged&limit=30&startAfter=${_dbNextStartAfter || ''}&search=${encodeURIComponent(searchQuery)}`).then(r => r.json());

          if (append) {
            _imagesList.push(...(response.items || []));
          } else {
            _imagesList = response.items || [];
          }

          _dbNextStartAfter = response.nextStartAfter || null;
          _dbHasMore = response.hasMore || false;

          _imagesGridPopulated = false;
          renderCurrentGallery();

        } else {
          // Administrator
          if (subtab === 'tagged') {
            // Tagirane slike iz baze
            const response = await fetch(`/api/drive/db/query?tab=images&subtab=tagged&limit=30&startAfter=${_dbNextStartAfter || ''}&search=${encodeURIComponent(searchQuery)}`).then(r => r.json());

            if (append) {
              _imagesList.push(...(response.items || []));
            } else {
              _imagesList = response.items || [];
            }

            _dbNextStartAfter = response.nextStartAfter || null;
            _dbHasMore = response.hasMore || false;

            _imagesGridPopulated = false;
            renderCurrentGallery();

          } else {
            // "all" ili "untagged" slike iz Google Drive mape
            if (!folderId) return;
            const result = await DriveAPI.getFiles(folderId, _galleryNextPageToken, 40);
            _galleryNextPageToken = result.nextPageToken || null;
            
            if (append) {
              _galleryFiles.push(...(result.files || []));
            } else {
              _galleryFiles = result.files || [];
            }
            
            _imagesGridPopulated = false;
            renderCurrentGallery();
          }
        }
      }
    } catch (e) {
      if (gridPortraits) gridPortraits.querySelectorAll('.gallery-item-loading').forEach(el => el.remove());
      if (gridImages) gridImages.querySelectorAll('.gallery-item-loading').forEach(el => el.remove());
      UI.toast('Greška pri učitavanju galerije: ' + e.message, 'error');
    }
  }

  function renderCurrentGallery() {
    const gridPortraits = document.getElementById('gallery-portraits-grid');
    const gridImages = document.getElementById('gallery-images-grid');
    const emptyEl = document.getElementById('gallery-empty');
    const loadMoreEl = document.getElementById('gallery-load-more');

    let currentTab = 'portraits';
    const activeTabBtn = document.querySelector('.gallery-tab-btn.active');
    if (activeTabBtn) currentTab = activeTabBtn.dataset.tab;

    const query = (document.getElementById('gallery-search-input')?.value || '').toLowerCase().trim();

    // 1. Prikaži/sakrij odgovarajući grid u DOM-u (CSS Toggle)
    if (currentTab === 'portraits') {
      if (gridPortraits) gridPortraits.style.display = 'grid';
      if (gridImages) gridImages.style.display = 'none';
    } else {
      if (gridPortraits) gridPortraits.style.display = 'none';
      if (gridImages) gridImages.style.display = 'grid';
    }

    if (currentTab === 'portraits') {
      if (_portraitsGridPopulated && _lastPortraitsQuery === query) {
        const count = gridPortraits.querySelectorAll('.portrait-gallery-item').length;
        const countEl = document.getElementById('gallery-count');
        if (countEl) countEl.textContent = `${count} portreta`;
        if (emptyEl) emptyEl.style.display = count === 0 ? '' : 'none';
        if (loadMoreEl) loadMoreEl.style.display = _dbHasMore ? '' : 'none';
        return;
      }

      if (gridPortraits) gridPortraits.innerHTML = '';

      const countEl = document.getElementById('gallery-count');
      if (countEl) countEl.textContent = `${_portraitsList.length} portreta`;

      if (_portraitsList.length === 0) {
        if (emptyEl) emptyEl.style.display = '';
        if (loadMoreEl) loadMoreEl.style.display = 'none';
      } else {
        if (emptyEl) emptyEl.style.display = 'none';
        if (loadMoreEl) loadMoreEl.style.display = _dbHasMore ? '' : 'none';

        _portraitsList.forEach(tag => {
          if (!tag) return;
          const person = tag.person_id ? DB.getPersonById(tag.person_id) : null;
          if (gridPortraits) {
            gridPortraits.appendChild(createPortraitItem(tag, person));
          }
        });
      }

      _lastPortraitsQuery = query;
      _portraitsGridPopulated = true;
      return;
    }

    // Tab "Slike" (Fotografije)
    const subtab = document.querySelector('#gallery-subtabs .active')?.dataset.subtab || 'untagged';

    const isDbImagesTab = (_userRole === 'visitor' || subtab === 'tagged');
    const imagesCount = isDbImagesTab ? _imagesList.length : _galleryFiles.length;

    if (_imagesGridPopulated && _lastImagesQuery === query && _lastImagesSubtab === subtab && _lastImagesFilesLength === imagesCount) {
      const count = gridImages.querySelectorAll('.gallery-item').length;
      const countEl = document.getElementById('gallery-count');
      if (countEl) countEl.textContent = `${count} slika`;
      if (emptyEl) emptyEl.style.display = count === 0 ? '' : 'none';
      if (loadMoreEl) {
        loadMoreEl.style.display = isDbImagesTab ? (_dbHasMore ? '' : 'none') : (_galleryNextPageToken ? '' : 'none');
      }
      return;
    }

    if (gridImages) gridImages.innerHTML = '';

    let filesToRender = [];

    if (isDbImagesTab) {
      filesToRender = _imagesList;
    } else {
      // Admin: all ili untagged iz Google Drivea
      const dbImages = DB.getAllImages();
      const dbOriginalIds = dbImages.filter(img => img.output_drive_id).map(img => img.original_drive_id);

      if (subtab === 'untagged') {
        filesToRender = _galleryFiles.filter(file => !dbOriginalIds.includes(file.id));
      } else {
        // all
        const untagged = _galleryFiles.filter(file => !dbOriginalIds.includes(file.id));
        const tagged = dbImages
          .filter(img => img.output_drive_id)
          .map(img => {
            const ext = img.original_filename.split('.').pop() || 'jpg';
            return {
              id: img.output_drive_id,
              name: `Antunovac-u-slici-${String(img.sequence_no).padStart(4, '0')}.${ext}`,
              mimeType: 'image/jpeg'
            };
          });
        filesToRender = [...untagged, ...tagged];
      }

      // Filtriranje na klijentskoj strani za Google Drive datoteke
      filesToRender = filesToRender.filter(file => {
        const imageRec = DB.getImageByDriveId(file.id);
        const tags = imageRec ? DB.getTagsByImageId(imageRec.id) : [];

        if (!query) return true;

        const matchName = file.name.toLowerCase().includes(query);
        const matchDonor = imageRec && imageRec.donor && imageRec.donor.toLowerCase().includes(query);
        const matchPerson = tags.some(t => {
          const ime = (t.person_ime || '').toLowerCase();
          const prezime = (t.person_prezime || '').toLowerCase();
          return `${ime} ${prezime}`.includes(query);
        });

        return matchName || matchDonor || matchPerson;
      });
    }

    const countEl = document.getElementById('gallery-count');
    if (countEl) countEl.textContent = `${filesToRender.length} slika`;

    if (filesToRender.length === 0) {
      if (emptyEl) emptyEl.style.display = '';
      if (loadMoreEl) loadMoreEl.style.display = 'none';
    } else {
      if (emptyEl) emptyEl.style.display = 'none';
      filesToRender.forEach(file => {
        if (gridImages) gridImages.appendChild(createGalleryItem(file));
      });
    }

    if (loadMoreEl) {
      loadMoreEl.style.display = isDbImagesTab ? (_dbHasMore ? '' : 'none') : (_galleryNextPageToken ? '' : 'none');
    }

    _lastImagesQuery = query;
    _lastImagesSubtab = subtab;
    _lastImagesFilesLength = filesToRender.length;
    _imagesGridPopulated = true;
  }

  let _currentPortraitTag = null;

  function renderPortraitDetailComments(fileId) {
    const list = document.getElementById('portrait-detail-comments-list');
    const countEl = document.getElementById('portrait-detail-comments-count');
    if (!list) return;

    const comments = DB.getComments('image', fileId);
    if (countEl) countEl.textContent = comments.length;

    if (comments.length === 0) {
      list.innerHTML = '<p class="text-muted" style="padding: 4px 0; font-size: 0.8rem;">Nema komentara.</p>';
      return;
    }

    list.innerHTML = comments.map(c => `
      <div class="comment-item" style="background: var(--bg-elevated); padding: 8px; border-radius: 4px; border: 1px solid var(--border); margin-bottom: 6px;">
        <div style="font-weight: 600; color: var(--text-color); font-size: 0.75rem; display: flex; justify-content: space-between;">
          <span>${UI.escapeHtml(c.author_name)}</span>
          <span style="font-size: 0.7rem; color: var(--text-muted); font-weight: normal;">${new Date(c.created_at).toLocaleDateString('hr-HR')}</span>
        </div>
        <div style="color: var(--text-secondary); margin-top: 4px; font-size: 0.75rem; line-height: 1.3;">${UI.escapeHtml(c.comment_text)}</div>
      </div>
    `).join('');
  }

  function openPortraitDetail(tag) {
    _currentPortraitTag = tag;
    const person = tag.person_id ? DB.getPersonById(tag.person_id) : null;
    const name = `${person?.ime || tag?.person_ime || tag?.manualName || tag?.ime || ''} ${person?.prezime || tag?.person_prezime || ''}`.trim() || 'Nepoznata osoba';
    const birthStr = person?.godina_rodenja || tag?.person_godina_rodenja || '?';
    const deathStr = person?.godina_smrti || tag?.person_godina_smrti || '?';
    let lifespan = '';
    if (person?.godina_rodenja || person?.godina_smrti || tag?.person_godina_rodenja || tag?.person_godina_smrti) {
      lifespan = `(${birthStr} - ${deathStr})`;
    }

    const imageRec = DB.getAllImages().find(img => img.id === tag.image_id || img.original_drive_id === tag.image_id);
    const driveFileId = imageRec ? imageRec.original_drive_id : tag.image_id;

    // Popuni podatke
    document.getElementById('portrait-detail-name').textContent = name;
    document.getElementById('portrait-detail-lifespan').textContent = lifespan;
    document.getElementById('portrait-detail-filename').textContent = imageRec ? imageRec.original_filename : 'Nepoznato';

    // Učitaj sliku
    const imgContainer = document.getElementById('portrait-detail-img-container');
    if (imgContainer) {
      if (tag.portrait_drive_id) {
        const imgUrl = DriveAPI.getThumbnailUrl(tag.portrait_drive_id, 800);
        imgContainer.innerHTML = `<img src="${imgUrl}" alt="${name}" style="max-width: 100%; max-height: 100%; object-fit: contain; display: block;">`;
      } else {
        const originalThumbUrl = DriveAPI.getThumbnailUrl(driveFileId, 800);
        const widthPct = (100 / tag.width) * 100;
        const leftPct = (tag.x / tag.width) * 100;
        const topPct = (tag.y / tag.height) * 100;
        imgContainer.innerHTML = `<img src="${originalThumbUrl}" style="position: absolute; width: ${widthPct}%; left: -${leftPct}%; top: -${topPct}%; max-width: none;">`;
      }
    }

    // Učitaj komentare
    renderPortraitDetailComments(driveFileId);

    // Otvori modal
    UI.openModal('modal-portrait-detail');
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

    const name = `${person?.ime || tag?.person_ime || tag?.manualName || tag?.ime || ''} ${person?.prezime || tag?.person_prezime || ''}`.trim() || 'Nepoznata osoba';
    const birthStr = person?.godina_rodenja || tag?.person_godina_rodenja || '?';
    const deathStr = person?.godina_smrti || tag?.person_godina_smrti || '?';
    let lifespan = '';
    if (person?.godina_rodenja || person?.godina_smrti || tag?.person_godina_rodenja || tag?.person_godina_smrti) {
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
      openPortraitDetail(tag);
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
        if (!t) return;
        const p = t.person_id ? DB.getPersonById(t.person_id) : null;
        const name = p ? UI.formatPersonName(p) : `${t.person_ime || t.manualName || t.ime || ''} ${t.person_prezime || ''}`.trim() || 'Nepoznata osoba';
        const years = p ? ((p.godina_rodenja || '?') + ' - ' + (p.godina_smrti || '?')) : (t.person_godina_rodenja ? ((t.person_godina_rodenja || '?') + ' - ' + (t.person_godina_smrti || '?')) : '');
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
    let imageRec = DB.getAllImages().find(img => img.original_drive_id === file.id || img.output_drive_id === file.id);

    if (_userRole === 'admin') {
      if (!imageRec || !imageRec.output_drive_id) {
        const settings = DB.getSettings();
        const outputFolderId = settings.outputFolderId || settings.inputFolderId;
        if (!outputFolderId) {
          UI.toast('Prvo odaberite početnu mapu s originalnim slikama u postavkama.', 'error');
          return;
        }

        UI.showLoading('Kopiranje i priprema originalne slike na Google Drive...');

        try {
          const response = await DriveAPI.copyFile(file.id, outputFolderId);
          const copiedFile = response.file;
          const nextSeq = response.sequence_no;

          imageRec = DB.saveImage({
            id: imageRec ? imageRec.id : null,
            original_drive_id: file.id,
            original_filename: file.name,
            output_drive_id: copiedFile.id,
            status: 'processed',
            sequence_no: nextSeq,
            folder_id: settings.inputFolderId
          });

          file = { id: copiedFile.id, name: copiedFile.name };
        } catch (err) {
          console.error('[App] Kopiranje slike neuspješno:', err);
          UI.toast('Greška pri kopiranju slike: ' + err.message, 'error');
          UI.hideLoading();
          return;
        }
      } else {
        const ext = imageRec.original_filename.split('.').pop() || 'jpg';
        file = {
          id: imageRec.output_drive_id,
          name: `Antunovac-u-slici-${String(imageRec.sequence_no).padStart(4, '0')}.${ext}`
        };
      }
    }

    UI.showView('editor');
    UI.showLoading('Učitavanje optimizirane fotografije (1600px)...');

    try {
      const optimizedUrl = DriveAPI.getThumbnailUrl(file.id, 1600);
      await CanvasEngine.loadImageFromUrl(optimizedUrl, file.id, file);

      document.getElementById('editor-filename').textContent = file.name;

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

      // Osvježi galeriju u pozadini da se ne prikazuje u popisu za uvoz
      const settings = DB.getSettings();
      if (settings.inputFolderId) {
        loadGallery(settings.inputFolderId);
      }
    } catch (e) {
      console.error('[App] Učitavanje u editor neuspješno:', e);
      UI.toast('Greška pri učitavanju u editor: ' + e.message, 'error');
      UI.showView('gallery');
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
      target === 'input' ? 'Odaberi ulaznu mapu' :
      target === 'portraits_tisak' ? 'Odaberi mapu za portrete (TISAK)' : 'Odaberi mapu za portrete (WEB)';
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
    } else if (_folderPickerTarget === 'portraits_tisak') {
      DB.saveSettings({ portraitsTisakFolderId: _folderPickerSelectedId, portraitsTisakFolderName: folderName });
      document.getElementById('tisak-folder-name').textContent = folderName;
    } else if (_folderPickerTarget === 'portraits_web') {
      DB.saveSettings({ portraitsWebFolderId: _folderPickerSelectedId, portraitsWebFolderName: folderName });
      document.getElementById('web-folder-name').textContent = folderName;
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
    
    const jpegValEl = document.getElementById('jpeg-quality-val');
    if (jpegValEl) jpegValEl.textContent = (settings.jpegQuality || 92) + '%';

    const showLabelsEl = document.getElementById('toggle-show-labels');
    if (showLabelsEl) showLabelsEl.checked = settings.showLabels !== false;
    CanvasEngine.showLabels = settings.showLabels !== false;

    const autoSyncEl = document.getElementById('toggle-auto-sync');
    if (autoSyncEl) autoSyncEl.checked = settings.autoSync !== false;

    const inputName = settings.inputFolderName || 'Nije odabrana';
    const tisakName = settings.portraitsTisakFolderName || 'Nije odabrana';
    const webName = settings.portraitsWebFolderName || 'Nije odabrana';
    
    const inputNameEl = document.getElementById('input-folder-name');
    if (inputNameEl) inputNameEl.textContent = inputName;
    
    const tEl = document.getElementById('tisak-folder-name');
    if (tEl) tEl.textContent = tisakName;
    
    const wEl = document.getElementById('web-folder-name');
    if (wEl) wEl.textContent = webName;

    const defaultStartFolder = settings.defaultStartFolder || 'root';
    const defaultStartFolderEl = document.getElementById('default-start-folder');
    if (defaultStartFolderEl) {
      defaultStartFolderEl.value = defaultStartFolder;
    }

    const gallerySubtitle = document.getElementById('gallery-folder-name');
    if (gallerySubtitle && settings.inputFolderName) gallerySubtitle.textContent = settings.inputFolderName;
  }

  function populateDbMgmtSelects() {
    const personSelect = document.getElementById('select-db-delete-person');
    const tagSelect = document.getElementById('select-db-delete-tag');
    const imageSelect = document.getElementById('select-db-delete-image');

    if (personSelect) {
      personSelect.innerHTML = '<option value="">-- Odaberi osobu za brisanje --</option>';
      const persons = DB.getAllPersons();
      persons.sort((a, b) => `${a.ime || ''} ${a.prezime || ''}`.localeCompare(`${b.ime || ''} ${b.prezime || ''}`));
      persons.forEach(p => {
        const option = document.createElement('option');
        option.value = p.id;
        const birthStr = p.godina_rodenja ? p.godina_rodenja : '?';
        const deathStr = p.godina_smrti ? p.godina_smrti : '?';
        option.textContent = `${p.ime || ''} ${p.prezime || ''} (${birthStr} - ${deathStr})`;
        personSelect.appendChild(option);
      });
    }

    if (tagSelect) {
      tagSelect.innerHTML = '<option value="">-- Odaberi oznaku za brisanje --</option>';
      const tags = DB.getAllTags();
      tags.forEach(t => {
        const option = document.createElement('option');
        option.value = t.id;
        const name = `${t.person_ime || ''} ${t.person_prezime || ''}`.trim() || 'Nepoznata osoba';
        option.textContent = `${name} [Tag ID: ${t.id.substring(0, 8)}]`;
        tagSelect.appendChild(option);
      });
    }

    if (imageSelect) {
      imageSelect.innerHTML = '<option value="">-- Odaberi slikovni zapis za brisanje --</option>';
      const images = DB.getAllImages();
      images.sort((a, b) => (b.sequence_no || 0) - (a.sequence_no || 0));
      images.forEach(img => {
        const option = document.createElement('option');
        option.value = img.id;
        option.textContent = `Antunovac-u-slici-${String(img.sequence_no || 0).padStart(4, '0')} (${img.original_filename})`;
        imageSelect.appendChild(option);
      });
    }
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
      defaultStartFolder: startFolderId
    });
    CanvasEngine.showLabels = settings.showLabels;
    UI.toast('Postavke spremljene.', 'success');
  }

  // ─── Event binding ─────────────────────────────────────────────────────────

  function bindEvents() {
    document.addEventListener('viewChanged', (e) => {
      const view = e.detail.view;
      const isVisitor = _userRole === 'visitor' && !_authStatus?.authenticated;
      if (isVisitor && ['settings', 'export', 'editor'].includes(view)) {
         UI.showView('gallery');
      } else if (view === 'settings') {
         populateDbMgmtSelects();
      }
    });

    // Kada se učita najnovija zajednička baza sa servera
    document.addEventListener('dbSynced', () => {
      applySettings(DB.getSettings());
      const settings = DB.getSettings();
      if (_userRole === 'visitor' || settings.inputFolderId) {
        loadGallery(settings.inputFolderId);
      }
    });

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

    // Slanje komentara u detaljima portreta
    document.getElementById('btn-portrait-detail-submit-comment')?.addEventListener('click', () => {
      if (!_currentPortraitTag) return;
      
      const imageRec = DB.getAllImages().find(img => img.id === _currentPortraitTag.image_id || img.original_drive_id === _currentPortraitTag.image_id);
      const fileId = imageRec ? imageRec.original_drive_id : _currentPortraitTag.image_id;
      if (!fileId) return;

      const authorInput = document.getElementById('portrait-detail-comment-author');
      const textInput = document.getElementById('portrait-detail-comment-text');
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
      renderPortraitDetailComments(fileId);
      UI.toast('Komentar spremljen!', 'success');
    });

    // Prikaži cijelu sliku iz detalja portreta
    document.getElementById('btn-portrait-detail-view-original')?.addEventListener('click', () => {
      if (!_currentPortraitTag) return;
      const tag = _currentPortraitTag;
      UI.closeModal('modal-portrait-detail');

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

    // Zatvaranje/Nazad modal za portret
    const closePortraitDetail = () => UI.closeModal('modal-portrait-detail');
    document.getElementById('modal-portrait-detail-close')?.addEventListener('click', closePortraitDetail);
    document.getElementById('btn-portrait-detail-back')?.addEventListener('click', closePortraitDetail);

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
      const currentTab = document.querySelector('.gallery-tab-btn.active')?.dataset.tab || 'portraits';
      const subtab = document.querySelector('#gallery-subtabs .active')?.dataset.subtab || 'untagged';

      if (currentTab === 'portraits' || _userRole === 'visitor' || subtab === 'tagged') {
        loadGallery(settings.inputFolderId, true);
      } else {
        if (settings.inputFolderId && _galleryNextPageToken) {
          loadGallery(settings.inputFolderId, true);
        }
      }
    });

    // Infinite Scroll (Automatsko učitavanje kad skrolamo do dna)
    let scrollTimeout;
    window.addEventListener('scroll', () => {
      clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(() => {
        const loadMoreBtn = document.getElementById('btn-load-more');
        const loadMoreContainer = document.getElementById('gallery-load-more');
        if (loadMoreBtn && loadMoreContainer && loadMoreContainer.style.display !== 'none') {
          const rect = loadMoreContainer.getBoundingClientRect();
          if (rect.top <= window.innerHeight + 300) {
            console.log('[App] Infinite Scroll: Učitavanje sljedeće stranice...');
            loadMoreBtn.click();
          }
        }
      }, 100);
    });

    // Search input u galeriji
    document.getElementById('gallery-search-input')?.addEventListener('input', UI.debounce((e) => {
       const settings = DB.getSettings();
       loadGallery(settings.inputFolderId);
    }, 400));

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

        const settings = DB.getSettings();
        loadGallery(settings.inputFolderId);
      });
    });

    // Gallery subtabs (Admin sub-filteri za fotografije)
    document.querySelectorAll('#gallery-subtabs button').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#gallery-subtabs button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const settings = DB.getSettings();
        loadGallery(settings.inputFolderId);
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
    document.getElementById('btn-pick-tisak-folder')?.addEventListener('click', () => {
      if (!_authStatus?.authenticated) { UI.toast('Prvo povežite Google Drive.', 'warning'); return; }
      openFolderPicker('portraits_tisak');
    });
    document.getElementById('btn-pick-web-folder')?.addEventListener('click', () => {
      if (!_authStatus?.authenticated) { UI.toast('Prvo povežite Google Drive.', 'warning'); return; }
      openFolderPicker('portraits_web');
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

    // Upravljanje bazom podataka - Pojedinačno brisanje
    document.getElementById('btn-db-delete-person')?.addEventListener('click', () => {
      const id = document.getElementById('select-db-delete-person')?.value;
      if (!id) { UI.toast('Odaberite osobu za brisanje.', 'warning'); return; }
      if (confirm('Jeste li sigurni da želite obrisati ovu osobu iz baze? Ova akcija ne briše datoteke na Driveu.')) {
        DB.deletePerson(id);
        UI.toast('Osoba obrisana iz baze.', 'success');
        populateDbMgmtSelects();
      }
    });

    document.getElementById('btn-db-delete-tag')?.addEventListener('click', () => {
      const id = document.getElementById('select-db-delete-tag')?.value;
      if (!id) { UI.toast('Odaberite oznaku za brisanje.', 'warning'); return; }
      if (confirm('Jeste li sigurni da želite obrisati ovu oznaku iz baze? Ova akcija ne briše datoteke na Driveu.')) {
        DB.deleteTag(id);
        UI.toast('Oznaka obrisana iz baze.', 'success');
        populateDbMgmtSelects();
      }
    });

    document.getElementById('btn-db-delete-image')?.addEventListener('click', () => {
      const id = document.getElementById('select-db-delete-image')?.value;
      if (!id) { UI.toast('Odaberite sliku za brisanje.', 'warning'); return; }
      if (confirm('Jeste li sigurni da želite obrisati ovaj slikovni zapis iz baze? Ova akcija ne briše sliku na Driveu.')) {
        DB.deleteImage(id);
        UI.toast('Slikovni zapis obrisan iz baze.', 'success');
        populateDbMgmtSelects();
        const settings = DB.getSettings();
        loadGallery(settings.inputFolderId);
      }
    });

    // Upravljanje bazom podataka - Grupno brisanje
    document.getElementById('btn-clear-db-all')?.addEventListener('click', async () => {
      if (confirm('PAŽNJA: Jeste li sigurni da želite obrisati CIJELU BAZU PODATAKA? Ovo će obrisati sve osobe, oznake, slike i komentare iz baze. Datoteke na disku neće biti izbrisane.')) {
        if (confirm('Molimo potvrdite još jednom. Želite li stvarno obrisati cijelu bazu?')) {
          await DB.clearCollection('all');
          UI.toast('Cijela baza podataka je obrisana.', 'success');
          populateDbMgmtSelects();
          const settings = DB.getSettings();
          loadGallery(settings.inputFolderId);
        }
      }
    });

    document.getElementById('btn-clear-db-persons')?.addEventListener('click', async () => {
      if (confirm('Jeste li sigurni da želite obrisati sve osobe iz baze?')) {
        await DB.clearCollection('persons');
        UI.toast('Sve osobe obrisane iz baze.', 'success');
        populateDbMgmtSelects();
      }
    });

    document.getElementById('btn-clear-db-tags')?.addEventListener('click', async () => {
      if (confirm('Jeste li sigurni da želite obrisati sve oznake i portrete iz baze?')) {
        await DB.clearCollection('tags');
        UI.toast('Sve oznake obrisane iz baze.', 'success');
        populateDbMgmtSelects();
      }
    });

    document.getElementById('btn-clear-db-images')?.addEventListener('click', async () => {
      if (confirm('Jeste li sigurni da želite obrisati sve zapise slika iz baze?')) {
        await DB.clearCollection('images');
        UI.toast('Svi slikovni zapisi obrisani iz baze.', 'success');
        populateDbMgmtSelects();
        const settings = DB.getSettings();
        loadGallery(settings.inputFolderId);
      }
    });

    document.getElementById('btn-clear-db-comments')?.addEventListener('click', async () => {
      if (confirm('Jeste li sigurni da želite obrisati sve komentare iz baze?')) {
        await DB.clearCollection('comments');
        UI.toast('Svi komentari obrisani iz baze.', 'success');
        populateDbMgmtSelects();
      }
    });
  }

  // ─── Start ────────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', init);

  return { init, openInEditor, loadGallery };
})();
