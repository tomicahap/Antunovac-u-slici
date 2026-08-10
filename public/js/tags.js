/**
 * tags.js – Upravljanje oznakama na fotografijama.
 */

const Tags = (function () {
  'use strict';

  let _currentImageId = null;

  // ─── Sidebar popis oznaka ──────────────────────────────────────────────────

  function renderTagsList(imageId) {
    _currentImageId = imageId;
    const list = document.getElementById('tags-list');
    const empty = document.getElementById('tags-empty');
    const badge = document.getElementById('tag-count-badge');
    if (!list) return;

    const tags = imageId ? DB.getTagsByImageId(imageId) : [];
    if (badge) badge.textContent = tags.length;

    list.innerHTML = '';

    if (tags.length === 0) {
      if (empty) empty.style.display = '';
      return;
    }
    if (empty) empty.style.display = 'none';

    tags.forEach((tag, idx) => {
      const person = DB.getPersonById(tag.person_id);
      const color = CanvasEngine.getTagColor(idx);
      const item = document.createElement('li');
      item.className = 'tag-item';
      item.dataset.tagId = tag.id;
      item.setAttribute('role', 'listitem');
      item.setAttribute('tabindex', '0');

      const name = person ? UI.formatPersonName(person) : '?';
      const years = person ? UI.formatYears(person.godina_rodenja, person.godina_smrti) : '';

      item.innerHTML = `
        <span class="tag-color" style="background:${color}"></span>
        <div class="tag-info">
          <div class="tag-name">${UI.escapeHtml(name)}</div>
          ${years ? `<div class="tag-years">${UI.escapeHtml(years)}</div>` : ''}
        </div>
        <div class="tag-actions">
          <button class="tag-action-btn" data-action="download" title="Preuzmi portret">
            <svg viewBox="0 0 16 16"><path d="M8 2v8M5 7l3 3 3-3M2 12v2h12v-2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <button class="tag-action-btn" data-action="edit" title="Uredi">
            <svg viewBox="0 0 16 16"><path d="M2 14l3-1 7-7-2-2-7 7-1 3zm8-10l2-2 2 2-2 2-2-2z" stroke-linecap="round"/></svg>
          </button>
          <button class="tag-action-btn delete" data-action="delete" title="Obriši oznaku">
            <svg viewBox="0 0 16 16"><path d="M3 5h10l-1 8H4L3 5zM2 5h12M6 5V3h4v2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
      `;

      item.addEventListener('mouseenter', () => CanvasEngine.setHoveredTagId(tag.id));
      item.addEventListener('mouseleave', () => CanvasEngine.setHoveredTagId(null));

      item.addEventListener('click', (e) => {
        const action = e.target.closest('[data-action]')?.dataset.action;
        if (action === 'edit') { 
          CanvasEngine.selectTag(tag.id); 
          document.getElementById('sidebar-autocomplete')?.focus(); 
          return; 
        }
        if (action === 'delete') { deleteTag(tag.id); return; }
        if (action === 'download') { downloadPortrait(tag); return; }
        
        CanvasEngine.zoomToTag(tag.id);
        document.querySelectorAll('.tag-item').forEach(el => el.classList.remove('selected'));
        item.classList.add('selected');
      });

      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') item.click();
      });

      list.appendChild(item);
    });
  }

  // ─── Tag forma (modal) ─────────────────────────────────────────────────────

  let _editingTagId = null;
  let _initialRect = null;

  function openTagModal(tagId = null, initialRect = null) {
    _editingTagId = tagId;
    _initialRect = initialRect;
    const tag = tagId ? DB.getAllTags().find(t => t.id === tagId) : null;
    
    // Determine role (visitor doesn't see modal, admin sees simplified)
    const userRole = sessionStorage.getItem('agf_user_role') || 'visitor';
    if (userRole === 'visitor') return;

    // Prilagodi modal - sakrij višak polja za admina
    const hiddenFields = document.getElementById('tag-admin-hidden-fields');
    if (hiddenFields) hiddenFields.style.display = 'none';

    document.getElementById('modal-tag-title').textContent = tag ? 'Uredi oznaku' : 'Nova oznaka (povezivanje)';
    
    document.getElementById('tag-autocomplete').value = '';
    const dropdown = document.getElementById('tag-autocomplete-dropdown');
    if (dropdown) dropdown.style.display = 'none';

    if (tag && tag.person_id) {
      const person = DB.getPersonById(tag.person_id);
      if (person) {
        document.getElementById('tag-autocomplete').value = UI.formatPersonName(person);
      }
    }

    const delBtn = document.getElementById('btn-tag-delete');
    if (delBtn) delBtn.style.display = tag ? '' : 'none';

    UI.openModal('modal-tag');
  }

  async function saveTagFromModal() {
    const existingPersonId = document.getElementById('tag-person-id').value;

    if (!existingPersonId) {
      UI.toast('Molimo odaberite osobu iz popisa.', 'warning');
      return;
    }

    const person = DB.getPersonById(existingPersonId);
    if (!person) {
      UI.toast('Osoba nije pronađena.', 'error');
      return;
    }

    if (_editingTagId) {
      const existingTag = DB.getAllTags().find(t => t.id === _editingTagId);
      if (existingTag) {
        const updated = DB.saveTag({ ...existingTag, person_id: person.id });
        CanvasEngine.addOrUpdateTag(updated, person);
        renderTagsList(_currentImageId);
        UI.toast(`${UI.formatPersonName(person)} – uspješno povezano.`, 'success');
      }
    }

    _initialRect = null;
    UI.closeModal('modal-tag');
  }

  async function deleteTag(tagId) {
    const confirmed = await UI.confirm('Obrisati ovu oznaku?', 'Brisanje oznake', 'Obriši');
    if (!confirmed) return;
    
    const tag = DB.getAllTags().find(t => t.id === tagId);
    if (tag && tag.portrait_drive_id) {
      try {
        await DriveAPI.deleteFile(tag.portrait_drive_id);
      } catch (err) {
        console.warn('[Tags] Greška pri brisanju portretne datoteke s Drivea:', err.message);
      }
    }

    DB.deleteTag(tagId);
    CanvasEngine.removeTag(tagId);
    renderTagsList(_currentImageId);
    UI.toast('Oznaka obrisana.', 'success');
  }

  async function deleteSelectedTag() {
    const tagId = CanvasEngine.getSelectedTagId();
    if (tagId) await deleteTag(tagId);
  }

  // ─── Download portreta ─────────────────────────────────────────────────────

  async function downloadPortrait(tag) {
    try {
      UI.showLoading('Isjecanje portreta...');
      const blob = await CanvasEngine.cropPortrait(tag);
      const person = DB.getPersonById(tag.person_id);
      const name = person ? `${person.ime}_${person.prezime}` : 'portret';
      const meta = CanvasEngine.currentMeta;
      const ext = meta && meta.name && meta.name.includes('.') ? meta.name.slice(meta.name.lastIndexOf('.')) : '.jpg';
      UI.downloadBlob(blob, `${name}_portret${ext}`);
      UI.toast('Portret preuzet.', 'success');
    } catch (e) {
      UI.toast(e.message, 'error');
    } finally {
      UI.hideLoading();
    }
  }

  async function downloadAllPortraits() {
    const tags = _currentImageId ? DB.getTagsByImageId(_currentImageId) : [];
    if (tags.length === 0) { UI.toast('Nema oznaka za izvoz.', 'warning'); return; }
    for (const tag of tags) await downloadPortrait(tag);
  }

  function buildPortraitFilename(person, originalFilename, imageSequenceNo, tagIndex = 0) {
    const lastDot = originalFilename ? originalFilename.lastIndexOf('.') : -1;
    const ext = lastDot > -1 ? originalFilename.slice(lastDot) : '.jpg';
    
    const ime = (person.ime || '').trim().replace(/\s+/g, '_');
    const prezime = (person.prezime || '').trim().replace(/\s+/g, '_');
    
    const suffix = tagIndex > 0 ? `_${tagIndex}` : '';
    return `${ime}_${prezime}_slika_${imageSequenceNo}${suffix}${ext}`;
  }

  // ─── Spremi na Drive ───────────────────────────────────────────────────────

  async function saveCurrentImageToDrive() {
    const settings = DB.getSettings();
    if (!settings.outputFolderId) {
      UI.toast('Odaberite izlaznu mapu u Postavkama.', 'warning');
      UI.showView('settings');
      return false;
    }

    const fileId = CanvasEngine.currentFileId;
    const meta = CanvasEngine.currentMeta;
    if (!fileId || !meta) { UI.toast('Nema učitane slike.', 'warning'); return false; }

    UI.showLoading('Spremanje na Google Drive...');

    try {
      const quality = (settings.jpegQuality || 92) / 100;
      let globalImageSequence = settings.globalImageSequence || 1;

      const lastDot = meta.name ? meta.name.lastIndexOf('.') : -1;
      const baseName = lastDot > -1 ? meta.name.slice(0, lastDot) : (meta.name || 'Slika');
      const ext = lastDot > -1 ? meta.name.slice(lastDot) : '.jpg';
      
      let imageRec = DB.getImageByDriveId(fileId);
      const donorInput = document.getElementById('editor-image-donor');
      const donorVal = donorInput ? donorInput.value.trim() : '';
      
      // 1. Provjeri i spremi originalnu sliku
      if (!imageRec || !imageRec.output_drive_id) {
         // Slika još nije spremljena
         const cleanBlob = await CanvasEngine.exportCleanImage();
         const outputFilename = `slika_${globalImageSequence}${ext}`;
         const uploadResult = await DriveAPI.uploadBlob(settings.outputFolderId, outputFilename, cleanBlob);
         
         imageRec = DB.saveImage({
           id: imageRec?.id,
           original_drive_id: fileId,
           original_filename: meta.name,
           output_drive_id: uploadResult.fileId,
           processed_at: new Date().toISOString(),
           status: 'processed',
           folder_id: settings.inputFolderId,
           sequence_no: globalImageSequence,
           donor: donorVal || null
         });
         
         globalImageSequence++;
         DB.saveSettings({ globalImageSequence: globalImageSequence });
      } else {
         // Ako je već spremljena, samo ažuriramo darovatelja ako je unesen
         imageRec = DB.saveImage({
           ...imageRec,
           donor: donorVal || imageRec.donor
         });
      }

      // 2. Kreiraj podmapu za portrete ako ne postoji
      const portraitsFolder = await DriveAPI.createFolder(
        settings.outputFolderId,
        settings.portraitsSubfolder || 'Portreti'
      );

      const tags = DB.getTagsByImageId(imageRec.id);
      let savedCount = 0;
      let skippedCount = 0;

      // Izbrojimo indekse za osobe kako bismo riješili duplikate unutar iste slike
      const personCounts = {};

      for (const tag of tags) {
        try {
          const person = DB.getPersonById(tag.person_id);
          if (!person) continue;

          personCounts[person.id] = (personCounts[person.id] || 0) + 1;
          const tagIndex = personCounts[person.id] - 1;

          // Provjeri je li oznaka nepromijenjena u odnosu na zadnje spremanje
          const isUnchanged = tag.portrait_drive_id &&
            tag.x === tag.last_processed_x &&
            tag.y === tag.last_processed_y &&
            tag.width === tag.last_processed_width &&
            tag.height === tag.last_processed_height &&
            tag.person_id === tag.last_processed_person_id;

          if (isUnchanged) {
             skippedCount++;
             continue; // Preskačemo jer se ništa nije promijenilo
          }

          const portraitBlob = await CanvasEngine.cropPortrait(tag);
          const portraitFilename = buildPortraitFilename(person, meta.name, imageRec.sequence_no || globalImageSequence - 1, tagIndex);

          // Ako već postoji portrait_drive_id, pregađamo ga (overwrite)
          const portraitResult = await DriveAPI.uploadBlob(
            portraitsFolder.folderId,
            portraitFilename,
            portraitBlob,
            null,
            tag.portrait_drive_id || null
          );

          // Ažuriraj tag s Drive ID-em portreta i spremimo trenutno stanje
          DB.saveTag({
            ...tag,
            portrait_filename: portraitResult.filename,
            portrait_drive_id: portraitResult.fileId,
            last_processed_x: tag.x,
            last_processed_y: tag.y,
            last_processed_width: tag.width,
            last_processed_height: tag.height,
            last_processed_person_id: tag.person_id
          });

          savedCount++;
        } catch (e) {
          console.error('[Tags] Portret greška:', e.message);
        }
      }

      const msg = skippedCount > 0 
        ? `GOTOVO! Preskočeno ${skippedCount} već postojećih, spremljeno ${savedCount} novih portreta.`
        : `GOTOVO! Slika i ${savedCount} portreta uspješno spremljeni.`;
        
      UI.toast(msg, 'success');
      renderTagsList(_currentImageId);
      return true;
    } catch (e) {
      UI.toast(`Greška: ${e.message}`, 'error');
      return false;
    } finally {
      UI.hideLoading();
    }
  }

  // ─── Tab navigacija kroz oznake ────────────────────────────────────────────

  function selectNextTag(forward = true) {
    const tags = _currentImageId ? DB.getTagsByImageId(_currentImageId) : [];
    if (tags.length === 0) return;
    const selectedId = CanvasEngine.getSelectedTagId();
    const idx = tags.findIndex(t => t.id === selectedId);
    const nextIdx = forward
      ? (idx + 1) % tags.length
      : (idx - 1 + tags.length) % tags.length;
    CanvasEngine.selectTag(tags[nextIdx].id);

    // Scroll u sidebar
    const item = document.querySelector(`.tag-item[data-tag-id="${tags[nextIdx].id}"]`);
    item?.scrollIntoView({ block: 'nearest' });
    document.querySelectorAll('.tag-item').forEach(el => el.classList.remove('selected'));
    item?.classList.add('selected');
  }

  // ─── Init ─────────────────────────────────────────────────────────────────

  function setCurrentImageId(id) { _currentImageId = id; }

  function init() {
    // Canvas callback za crtanje okvira
    CanvasEngine.onTagDrawn = (rect) => {
      const imageRec = DB.getImageByDriveId(_currentImageId);
      const imageDbId = imageRec?.id;

      const tag = DB.saveTag({
        person_id: null,
        image_id: imageDbId || _currentImageId,
        x: rect.x, y: rect.y,
        width: rect.width, height: rect.height
      });

      CanvasEngine.addOrUpdateTag(tag, null);
      CanvasEngine.selectTag(tag.id);
      renderTagsList(_currentImageId);
      
      const previewCanvas = document.getElementById('crop-preview');
      if (previewCanvas) CanvasEngine.drawPreview(tag, previewCanvas);

      UI.toast('Okvir kreiran. Možete ga pomaknuti po slici, a zatim kliknuti na ikonu uredi (olovka) u izborniku za odabir osobe.', 'info');
    };

    // Canvas callback za selekciju
    CanvasEngine.onTagSelected = (tagId) => {
      document.querySelectorAll('.tag-item').forEach(el => {
        el.classList.toggle('selected', el.dataset.tagId === tagId);
      });
      const tag = DB.getAllTags().find(t => t.id === tagId);
      const previewCanvas = document.getElementById('crop-preview');
      if (tag && previewCanvas) CanvasEngine.drawPreview(tag, previewCanvas);

      const selector = document.getElementById('sidebar-person-selector');
      const tagsListContainer = document.getElementById('sidebar-tags-list-container');
      
      if (tagId && tag) {
        selector.style.display = 'flex';
        if (tagsListContainer) tagsListContainer.style.display = 'none';
        
        const inputIme = document.getElementById('sidebar-filter-ime');
        const inputPrezime = document.getElementById('sidebar-filter-prezime');
        if (inputIme) inputIme.dataset.tagId = tagId;
        
        const activeChip = document.getElementById('tag-active-chip-name');
        const previewInfo = document.getElementById('preview-person-info');
        const familyInfo = document.getElementById('preview-family-info');
        
        if (tag.person_id) {
          const p = DB.getPersonById(tag.person_id);
          if (p) {
            if (inputIme) inputIme.value = p.ime || '';
            if (inputPrezime) inputPrezime.value = p.prezime || '';
            if (activeChip) activeChip.textContent = `${p.ime || ''} ${p.prezime || ''}`.trim();
            
            if (previewInfo) {
              previewInfo.innerHTML = `
                 <div style="font-weight: 700; font-size: 1.1rem; margin-bottom: 2px; color: #ffffff;">${UI.escapeHtml(UI.formatPersonName(p))}</div>
                 ${p.godina_rodenja || p.godina_smrti ? `<div style="color: var(--text-muted); font-size: 0.8rem; margin-bottom: 12px;">(${UI.escapeHtml(String(p.godina_rodenja || '?'))}. – ${UI.escapeHtml(String(p.godina_smrti || '?'))}.)</div>` : '<div style="margin-bottom: 12px;"></div>'}
                 <ul style="list-style: none; padding: 0; margin: 0; font-size: 0.8rem; color: #c9d1d9;">
                   ${p.godina_rodenja ? `<li style="margin-bottom: 4px;"><span style="color: #8b949e; margin-right: 4px;">• Rođenje:</span> ${UI.escapeHtml(String(p.godina_rodenja))}</li>` : ''}
                   ${p.godina_smrti ? `<li><span style="color: #8b949e; margin-right: 4px;">• Smrt:</span> ${UI.escapeHtml(String(p.godina_smrti))}</li>` : ''}
                   ${p.djevojacko_prezime ? `<li style="margin-top: 4px;"><span style="color: #8b949e; margin-right: 4px;">• Djev. prezime:</span> ${UI.escapeHtml(p.djevojacko_prezime)}</li>` : ''}
                 </ul>
              `;
            }

            if (familyInfo) {
              let famHtml = '<ul style="list-style: none; padding: 0; margin: 0;">';
              let hasFamily = false;
              if (p.supruznik) {
                hasFamily = true;
                famHtml += `<li style="margin-bottom: 6px; display: flex; align-items: flex-start; gap: 6px;"><svg viewBox="0 0 24 24" width="14" height="14" stroke="#58a6ff" stroke-width="2" fill="none" style="margin-top: 2px;"><path d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"></path></svg> <span style="color: #8b949e; margin-right: 4px;">Supružnik:</span> <span style="color: #c9d1d9;">${UI.escapeHtml(p.supruznik)}</span></li>`;
              }
              if (p.roditelji) {
                hasFamily = true;
                famHtml += `<li style="display: flex; align-items: flex-start; gap: 6px;"><svg viewBox="0 0 24 24" width="14" height="14" stroke="#58a6ff" stroke-width="2" fill="none" style="margin-top: 2px;"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg> <span style="color: #8b949e; margin-right: 4px;">Roditelji:</span> <span style="color: #c9d1d9;">${UI.escapeHtml(p.roditelji)}</span></li>`;
              }
              famHtml += '</ul>';
              
              if (!hasFamily) {
                famHtml = '<div style="color: var(--text-muted); font-size: 0.8rem; font-style: italic;">Nema unesenih obiteljskih veza.</div>';
              }
              familyInfo.innerHTML = famHtml;
            }
          }
        } else {
          if (inputIme) inputIme.value = '';
          if (inputPrezime) inputPrezime.value = '';
          if (activeChip) activeChip.textContent = 'Odaberite osobu';
          if (previewInfo) previewInfo.innerHTML = '<div style="color:var(--text-muted); padding-top: 20px; text-align: center;">Osoba još nije povezana. Odaberite je iz filtera lijevo.</div>';
          if (familyInfo) familyInfo.innerHTML = '';
        }
        
        updateSidebarDropdown();
      } else {
        selector.style.display = 'none';
        if (tagsListContainer) tagsListContainer.style.display = '';
      }
    };

    // Canvas callback za drag (prikaz uživo u sidebaru)
    CanvasEngine.onTagDrag = (tag) => {
      const previewCanvas = document.getElementById('crop-preview');
      if (previewCanvas) {
        CanvasEngine.drawPreview(tag, previewCanvas);
      }
    };

    // Canvas callback za promjenu pozicije ili veličine
    CanvasEngine.onTagChanged = (tag) => {
      const existing = DB.getAllTags().find(t => t.id === tag.id);
      if (existing) {
        const updated = DB.saveTag({
          ...existing,
          x: tag.x,
          y: tag.y,
          width: tag.width,
          height: tag.height
        });
        const person = DB.getPersonById(updated.person_id);
        CanvasEngine.addOrUpdateTag(updated, person);
        renderTagsList(_currentImageId);
      }
    };

    // Dual autocomplete sidebar
    const updateSidebarDropdown = UI.debounce(() => {
      const inputIme = document.getElementById('sidebar-filter-ime');
      const inputPrezime = document.getElementById('sidebar-filter-prezime');
      const dropdown = document.getElementById('sidebar-autocomplete-dropdown');
      const clearBtn = document.getElementById('sidebar-filter-clear');
      
      if (!inputIme || !inputPrezime || !dropdown) return;

      const qIme = (inputIme.value || '').toLowerCase().trim();
      const qPrezime = (inputPrezime.value || '').toLowerCase().trim();
      
      const hasQuery = qIme || qPrezime;
      if (clearBtn) clearBtn.style.display = hasQuery ? 'block' : 'none';

      let results = DB.getAllPersons();
      
      if (qIme) {
        results = results.filter(p => (p.ime || '').toLowerCase().includes(qIme));
      }
      if (qPrezime) {
        results = results.filter(p => {
          const prez = (p.prezime || '').toLowerCase();
          const djev = (p.djevojacko_prezime || '').toLowerCase();
          const rod = (p.roditelji || '').toLowerCase();
          return prez.includes(qPrezime) || djev.includes(qPrezime) || rod.includes(qPrezime);
        });
      }

      results = results.slice(0, 15); // limit to 15 results

      dropdown.innerHTML = '';
      if (results.length === 0) {
        dropdown.innerHTML = '<div style="padding:8px; font-size:0.8rem; color:var(--text-muted);">Nema rezultata.</div>';
      } else {
        results.forEach(person => {
          const item = document.createElement('div');
          item.className = 'autocomplete-item';
          
          // Izbroji na koliko slika je osoba označena
          const uniqueImages = new Set(DB.getAllTags().filter(t => t.person_id === person.id).map(t => t.image_id));
          const count = uniqueImages.size;
          const countText = count % 10 === 1 && count % 100 !== 11 ? `${count} slika` : [2,3,4].includes(count % 10) && ![12,13,14].includes(count % 100) ? `${count} slike` : `${count} slika`;

          const name = `${UI.formatPersonName(person)} (${countText})`;
          const years = UI.formatYears(person.godina_rodenja, person.godina_smrti);
          const maidenHtml = person.djevojacko_prezime ? `<span class="autocomplete-maiden">djev. ${UI.escapeHtml(person.djevojacko_prezime)}</span>` : '';
          const parentsHtml = person.roditelji ? `<div class="autocomplete-parents">Roditelji: ${UI.escapeHtml(person.roditelji)}</div>` : '';
          
          item.innerHTML = `
            <div class="autocomplete-main">
              <span class="autocomplete-name">${UI.escapeHtml(name)}</span>
              ${years ? `<span class="autocomplete-details">${UI.escapeHtml(years)}</span>` : ''}
            </div>
            ${maidenHtml || parentsHtml ? `
              <div class="autocomplete-sub">
                ${maidenHtml} ${parentsHtml}
              </div>
            ` : ''}
          `;
          item.addEventListener('click', () => {
            const tagId = inputIme.dataset.tagId;
            if (!tagId) return;
            
            inputIme.value = person.ime || '';
            inputPrezime.value = person.prezime || '';
            if (clearBtn) clearBtn.style.display = 'block';
            
            const existingTag = DB.getAllTags().find(t => t.id === tagId);
            if (existingTag) {
              const updated = DB.saveTag({ ...existingTag, person_id: person.id });
              CanvasEngine.addOrUpdateTag(updated, person);
              renderTagsList(_currentImageId);
              UI.toast(`${UI.formatPersonName(person)} – uspješno povezano.`, 'success');
              
              // Refresh card details
              CanvasEngine.onTagSelected(tagId);
            }
          });
          dropdown.appendChild(item);
        });
      }
      dropdown.style.display = 'block';
    }, 250);

    document.addEventListener('input', (e) => {
      if (e.target.id === 'sidebar-filter-ime' || e.target.id === 'sidebar-filter-prezime') {
        updateSidebarDropdown();
      }
    });

    const clearBtn = document.getElementById('sidebar-filter-clear');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        const inputIme = document.getElementById('sidebar-filter-ime');
        const inputPrezime = document.getElementById('sidebar-filter-prezime');
        if (inputIme) inputIme.value = '';
        if (inputPrezime) inputPrezime.value = '';
        updateSidebarDropdown();
      });
    }

    const activeChipClear = document.getElementById('tag-active-chip-clear');
    if (activeChipClear) {
      activeChipClear.addEventListener('click', () => {
        const inputIme = document.getElementById('sidebar-filter-ime');
        const inputPrezime = document.getElementById('sidebar-filter-prezime');
        const tagId = inputIme?.dataset.tagId;
        if (tagId) {
          const existingTag = DB.getAllTags().find(t => t.id === tagId);
          if (existingTag) {
            const updated = DB.saveTag({ ...existingTag, person_id: null });
            CanvasEngine.addOrUpdateTag(updated, null);
            renderTagsList(_currentImageId);
            if (inputIme) inputIme.value = '';
            if (inputPrezime) inputPrezime.value = '';
            if (clearBtn) clearBtn.style.display = 'none';
            UI.toast('Veza s osobom je uklonjena.', 'info');
            CanvasEngine.onTagSelected(tagId);
          }
        }
      });
    }
    
    // Zatvaranje dropdowna na klik izvan
    document.addEventListener('click', (e) => {
      const dropdown = document.getElementById('sidebar-autocomplete-dropdown');
      const inputIme = document.getElementById('sidebar-filter-ime');
      const inputPrezime = document.getElementById('sidebar-filter-prezime');
      if (dropdown && !dropdown.contains(e.target) && e.target !== inputIme && e.target !== inputPrezime) {
        dropdown.style.display = 'none';
      }
    });

    // Spremanje darovatelja slike
    document.getElementById('editor-image-donor')?.addEventListener('input', (e) => {
      const val = e.target.value;
      const imageRec = DB.getImageByDriveId(_currentImageId);
      if (imageRec) {
        DB.saveImage({ ...imageRec, donor: val });
      }
    });

    document.getElementById('btn-sidebar-delete-tag')?.addEventListener('click', async () => {
      const tagId = document.getElementById('sidebar-filter-ime')?.dataset.tagId;
      if (tagId) await deleteTag(tagId);
    });

    // Modal gumbi
    document.getElementById('btn-tag-save')?.addEventListener('click', saveTagFromModal);
    document.getElementById('btn-tag-cancel')?.addEventListener('click', () => {
      _pendingRect = null;
      UI.closeModal('modal-tag');
    });
    document.getElementById('modal-tag-close')?.addEventListener('click', () => {
      _pendingRect = null;
      UI.closeModal('modal-tag');
    });
    document.getElementById('btn-tag-delete')?.addEventListener('click', async () => {
      const tagId = document.getElementById('tag-id').value;
      if (tagId) { UI.closeModal('modal-tag'); await deleteTag(tagId); }
    });

    // GOTOVO button u editoru
    document.getElementById('btn-save-done')?.addEventListener('click', saveCurrentImageToDrive);

    // Export svih portreta
    document.getElementById('btn-export-all-portraits')?.addEventListener('click', downloadAllPortraits);
  }

  return {
    init, renderTagsList, openTagModal, saveTagFromModal,
    deleteTag, deleteSelectedTag, downloadPortrait, downloadAllPortraits,
    saveCurrentImageToDrive, setCurrentImageId, selectNextTag, buildPortraitFilename
  };
})();
