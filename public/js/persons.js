/**
 * persons.js – Upravljanje osobama i autocomplete widget.
 */

const Persons = (function () {
  'use strict';

  // ─── Render popis osoba ────────────────────────────────────────────────────

  function getFilterCriteria() {
    return {
      query: document.getElementById('persons-search')?.value || '',
      ime: document.getElementById('filter-ime')?.value || '',
      prezime: document.getElementById('filter-prezime')?.value || '',
      djevojacko: document.getElementById('filter-djevojacko')?.value || '',
      roditelj: document.getElementById('filter-roditelj')?.value || '',
      supruznik: document.getElementById('filter-supruznik')?.value || '',
      dijete: document.getElementById('filter-dijete')?.value || '',
      godRodOd: document.getElementById('filter-rod-od')?.value || null,
      godRodDo: document.getElementById('filter-rod-do')?.value || null,
      godSmOd: document.getElementById('filter-sm-od')?.value || null,
      godSmDo: document.getElementById('filter-sm-do')?.value || null
    };
  }

  function renderPersonsGrid() {
    const tableBody = document.getElementById('persons-table-body');
    const empty = document.getElementById('persons-empty');
    const subtitle = document.getElementById('persons-count-subtitle');
    if (!tableBody) return;

    const filterCriteria = getFilterCriteria();
    const sortBy = document.getElementById('persons-sort')?.value || 'prezime';
    let persons = DB.searchPersons(filterCriteria);

    // Sortiranje
    persons.sort((a, b) => {
      switch (sortBy) {
        case 'ime': return (a.ime || '').localeCompare(b.ime || '', 'hr');
        case 'godina_rodenja': return (a.godina_rodenja || 9999) - (b.godina_rodenja || 9999);
        case 'slika_count': {
          const ac = DB.getTagsByPersonId(a.id).length;
          const bc = DB.getTagsByPersonId(b.id).length;
          return bc - ac;
        }
        default: return (a.prezime || '').localeCompare(b.prezime || '', 'hr');
      }
    });

    if (subtitle) subtitle.textContent = `${persons.length} osoba pronađeno`;

    tableBody.innerHTML = '';

    if (persons.length === 0) {
      if (empty) empty.style.display = 'block';
      return;
    }
    if (empty) empty.style.display = 'none';

    let renderLimit = 80;
    function appendTableBatch(start, limit) {
      const batch = persons.slice(start, start + limit);
      batch.forEach(person => {
        const row = createPersonRow(person);
        tableBody.appendChild(row);
      });
    }

    appendTableBatch(0, renderLimit);

    // Ukloni stari load more red
    const oldLoadMore = document.getElementById('persons-load-more-tr');
    if (oldLoadMore) oldLoadMore.remove();

    if (persons.length > renderLimit) {
      const trMore = document.createElement('tr');
      trMore.id = 'persons-load-more-tr';
      let currentShown = renderLimit;
      trMore.innerHTML = `
        <td colspan="5" style="text-align: center; padding: 15px; background: var(--bg-surface-secondary);">
          <button class="btn btn-outline btn-sm" id="btn-more-persons">
            Prikaži još osoba (prikazano ${currentShown} od ${persons.length})
          </button>
        </td>
      `;

      trMore.querySelector('button')?.addEventListener('click', () => {
        appendTableBatch(currentShown, 100);
        currentShown += 100;
        if (currentShown >= persons.length) {
          trMore.remove();
        } else {
          trMore.querySelector('button').textContent = `Prikaži još osoba (prikazano ${currentShown} od ${persons.length})`;
        }
      });

      tableBody.appendChild(trMore);
    }
  }

  function createPersonRow(person) {
    const tr = document.createElement('tr');
    tr.className = 'person-table-row';
    tr.dataset.personId = person.id;
    tr.style.cssText = 'border-bottom: 1px solid var(--border-color); cursor: pointer; transition: background 0.15s;';

    const initials = UI.getInitials(person);
    const years = UI.formatYears(person.godina_rodenja, person.godina_smrti);
    const maiden = person.djevojacko_prezime ? `(r. ${person.djevojacko_prezime})` : '';
    const tagsCount = DB.getTagsByPersonId(person.id).length;

    tr.innerHTML = `
      <td style="padding: 8px 12px;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <div class="person-avatar-xs" style="width:28px;height:28px;border-radius:50%;background:var(--primary-color-alpha);color:var(--primary-color);display:flex;align-items:center;justify-content:center;font-weight:600;font-size:0.75rem;">${initials}</div>
          <strong style="color: var(--text-main);">${UI.escapeHtml(person.ime || '–')}</strong>
        </div>
      </td>
      <td style="padding: 8px 12px;">
        <strong style="color: var(--text-main);">${UI.escapeHtml(person.prezime || '–')}</strong>
        ${maiden ? `<span style="font-size:0.75rem; color:var(--text-muted); margin-left:4px;">${UI.escapeHtml(maiden)}</span>` : ''}
      </td>
      <td style="padding: 8px 12px; color: var(--text-muted);">${UI.escapeHtml(years || '–')}</td>
      <td style="padding: 8px 12px; font-size: 0.8rem;">${UI.escapeHtml(person.roditelji || '–')}</td>
      <td style="padding: 8px 12px; font-size: 0.8rem;">${UI.escapeHtml(person.supruznici || '–')}</td>
      <td style="padding: 8px 12px; text-align: center;">
        <span class="badge" style="padding: 2px 6px; border-radius: 4px; font-size: 0.75rem; background: ${tagsCount > 0 ? 'rgba(46,125,50,0.15)' : 'var(--bg-surface-secondary)'}; color: ${tagsCount > 0 ? '#2e7d32' : 'var(--text-muted)'};">${tagsCount} slika</span>
      </td>
    `;

    tr.addEventListener('mouseenter', () => tr.style.background = 'var(--bg-surface-secondary)');
    tr.addEventListener('mouseleave', () => tr.style.background = '');

    const badgeTd = tr.querySelector('td:last-child');
    if (tagsCount > 0) {
      badgeTd.style.cursor = 'pointer';
      badgeTd.addEventListener('click', (e) => {
        e.stopPropagation();
        goToGalleryForPerson(person);
      });
    }

    return tr;
  }

  function goToGalleryForPerson(person) {
    const searchInput = document.getElementById('gallery-search-input');
    if (searchInput) {
      searchInput.value = (person.ime + ' ' + person.prezime).trim();
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const navGallery = document.getElementById('nav-gallery');
    if (navGallery) navGallery.click();
  }

  // ─── Modal za osobu ────────────────────────────────────────────────────────

  function openPersonModal(personId = null) {
    const person = personId ? DB.getPersonById(personId) : null;
    const isNew = !person;

    document.getElementById('modal-person-title').textContent = isNew ? 'Nova osoba' : 'Podaci o osobi';
    document.getElementById('person-id').value = person?.id || '';
    document.getElementById('person-ime').value = person?.ime || '';
    document.getElementById('person-prezime').value = person?.prezime || '';
    document.getElementById('person-djevojacko').value = person?.djevojacko_prezime || '';
    document.getElementById('person-god-rod').value = person?.godina_rodenja || '';
    document.getElementById('person-god-sm').value = person?.godina_smrti || '';
    document.getElementById('person-napomena').value = person?.napomena || '';

    // Fotografije ove osobe
    const photosGrid = document.getElementById('person-photos-grid');
    const photoCount = document.getElementById('person-photo-count');
    if (photosGrid && person) {
      const tags = DB.getTagsByPersonId(person.id);
      photoCount.textContent = tags.length;
      photosGrid.innerHTML = '';
      tags.forEach(tag => {
        if (tag.portrait_drive_id) {
          const thumb = document.createElement('div');
          thumb.className = 'person-photo-thumb';
          const img = document.createElement('img');
          img.src = DriveAPI.getThumbnailUrl(tag.portrait_drive_id, 120);
          img.alt = 'Portret';
          img.loading = 'lazy';
          thumb.appendChild(img);
          photosGrid.appendChild(thumb);
        }
      });
    }

    // Zaštita GEDCOM podataka - onemogući uređivanje/brisanje ako je uvezen iz GEDCOM-a
    const isGedcom = !!(person && (person.is_gedcom || person.raw_data || person.xref));
    const gedcomNotice = document.getElementById('person-gedcom-notice');
    if (gedcomNotice) gedcomNotice.style.display = isGedcom ? 'block' : 'none';

    ['person-ime', 'person-prezime', 'person-djevojacko', 'person-god-rod', 'person-god-sm', 'person-napomena'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.disabled = isGedcom;
    });

    const saveBtn = document.getElementById('btn-person-save');
    if (saveBtn) saveBtn.style.display = isGedcom ? 'none' : '';

    const deleteBtn = document.getElementById('btn-person-delete');
    if (deleteBtn) deleteBtn.style.display = (person && !isGedcom) ? '' : 'none';

    UI.openModal('modal-person');
  }

  function savePersonFromModal() {
    const id = document.getElementById('person-id').value;
    if (id) {
      const existing = DB.getPersonById(id);
      if (existing && (existing.is_gedcom || existing.raw_data || existing.xref)) {
        UI.toast('GEDCOM podaci su trajno zaštićeni i ne mogu se mijenjati.', 'warning');
        return null;
      }
    }

    const ime = document.getElementById('person-ime').value.trim();
    const prezime = document.getElementById('person-prezime').value.trim();

    if (!ime || !prezime) {
      UI.toast('Ime i prezime su obavezni.', 'warning');
      return null;
    }

    const data = {
      id: id || undefined,
      ime,
      prezime,
      djevojacko_prezime: document.getElementById('person-djevojacko').value.trim(),
      godina_rodenja: document.getElementById('person-god-rod').value || null,
      godina_smrti: document.getElementById('person-god-sm').value || null,
      napomena: document.getElementById('person-napomena').value.trim()
    };

    const person = DB.savePerson(data);
    UI.toast(`${UI.formatPersonName(person)} – podaci spremljeni.`, 'success');
    UI.closeModal('modal-person');
    renderPersonsGrid();
    return person;
  }

  async function deletePersonFromModal() {
    const id = document.getElementById('person-id').value;
    if (!id) return;

    const person = DB.getPersonById(id);
    if (person && (person.is_gedcom || person.raw_data || person.xref)) {
      UI.toast('GEDCOM podaci su trajno zaštićeni i ne mogu se brisati.', 'warning');
      return;
    }

    const confirmed = await UI.confirm(
      `Jeste li sigurni da želite obrisati osobu "${UI.formatPersonName(person)}"? Sve oznake ove osobe bit će obrisane.`,
      'Brisanje osobe',
      'Obriši'
    );

    if (!confirmed) return;

    DB.deletePerson(id);
    UI.toast(`${UI.formatPersonName(person)} – obrisano.`, 'success');
    UI.closeModal('modal-person');
    renderPersonsGrid();
  }

  // ─── Autocomplete widget ────────────────────────────────────────────────────

  let _autocompleteTarget = null; // { prefix, onSelect }

  function initAutocomplete(inputId, dropdownId, onSelect) {
    const input = document.getElementById(inputId);
    const dropdown = document.getElementById(dropdownId);
    if (!input || !dropdown) return;

    _autocompleteTarget = { onSelect };

    let focusIndex = -1;
    let items = [];

    function showDropdown(persons) {
      if (persons.length === 0) { dropdown.style.display = 'none'; return; }
      dropdown.innerHTML = '';
      focusIndex = -1;
      items = persons;

      persons.forEach((person, idx) => {
        const item = document.createElement('div');
        item.className = 'autocomplete-item';
        item.dataset.idx = idx;

        const name = UI.formatPersonName(person);
        const years = UI.formatYears(person.godina_rodenja, person.godina_smrti);
        const maiden = person.djevojacko_prezime ? `<div class="autocomplete-maiden">djev. ${UI.escapeHtml(person.djevojacko_prezime)}</div>` : '';
        const parents = person.roditelji ? `<div class="autocomplete-parents">Roditelji: ${UI.escapeHtml(person.roditelji)}</div>` : '';

        item.innerHTML = `
          <div class="autocomplete-main">
            <span class="autocomplete-name">${UI.escapeHtml(name)}</span>
            ${years ? `<span class="autocomplete-details">${UI.escapeHtml(years)}</span>` : ''}
          </div>
          ${maiden || parents ? `<div class="autocomplete-sub">${maiden}${parents}</div>` : ''}
        `;

        item.addEventListener('mousedown', (e) => {
          e.preventDefault();
          selectAutocompleteItem(person);
        });

        dropdown.appendChild(item);
      });

      dropdown.style.display = '';
    }

    function hideDropdown() {
      dropdown.style.display = 'none';
      focusIndex = -1;
    }

    function selectAutocompleteItem(person) {
      input.value = '';
      hideDropdown();
      if (onSelect) onSelect(person);
    }

    input.addEventListener('input', UI.debounce(() => {
      const q = input.value.trim();
      if (q.length < 1) { hideDropdown(); return; }
      const results = DB.searchPersons(q).slice(0, 8);
      showDropdown(results);
    }, 150));

    input.addEventListener('keydown', (e) => {
      if (dropdown.style.display === 'none') return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        focusIndex = Math.min(focusIndex + 1, items.length - 1);
        updateFocus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        focusIndex = Math.max(focusIndex - 1, -1);
        updateFocus();
      } else if (e.key === 'Enter' && focusIndex >= 0) {
        e.preventDefault();
        selectAutocompleteItem(items[focusIndex]);
      } else if (e.key === 'Escape') {
        hideDropdown();
      }
    });

    input.addEventListener('blur', () => {
      setTimeout(hideDropdown, 200);
    });

    function updateFocus() {
      dropdown.querySelectorAll('.autocomplete-item').forEach((item, idx) => {
        item.classList.toggle('focused', idx === focusIndex);
      });
    }
  }

  /**
   * Popunjava formu za oznaku (modal-tag) s podacima osobe iz autocomplete.
   */
  function fillTagFormWithPerson(person) {
    document.getElementById('tag-person-id').value = person.id;
    document.getElementById('tag-ime').value = person.ime || '';
    document.getElementById('tag-prezime').value = person.prezime || '';
    document.getElementById('tag-djevojacko').value = person.djevojacko_prezime || '';
    document.getElementById('tag-god-rod').value = person.godina_rodenja || '';
    document.getElementById('tag-god-sm').value = person.godina_smrti || '';
    document.getElementById('tag-napomena').value = person.napomena || '';
  }

  // ─── Init ─────────────────────────────────────────────────────────────────

  function init() {
    // Autocomplete u tag formi
    initAutocomplete('tag-autocomplete', 'tag-autocomplete-dropdown', fillTagFormWithPerson);

    // Događaji za filtre i pretragu
    const filterInputs = [
      'persons-search', 'filter-ime', 'filter-prezime', 'filter-djevojacko',
      'filter-roditelj', 'filter-supruznik', 'filter-dijete',
      'filter-rod-od', 'filter-rod-do', 'filter-sm-od', 'filter-sm-do'
    ];

    const debouncedRender = UI.debounce(() => renderPersonsGrid(), 200);

    filterInputs.forEach(id => {
      document.getElementById(id)?.addEventListener('input', debouncedRender);
    });

    // Sortiranje
    document.getElementById('persons-sort')?.addEventListener('change', () => renderPersonsGrid());

    // Nova osoba
    document.getElementById('btn-add-person')?.addEventListener('click', () => openPersonModal());

    // Modal gumbi
    document.getElementById('btn-person-save')?.addEventListener('click', savePersonFromModal);
    document.getElementById('btn-person-delete')?.addEventListener('click', deletePersonFromModal);
    document.getElementById('btn-person-cancel')?.addEventListener('click', () => UI.closeModal('modal-person'));
    document.getElementById('modal-person-close')?.addEventListener('click', () => UI.closeModal('modal-person'));
  }

  // ─── Public API ───────────────────────────────────────────────────────────
  return {
    init, renderPersonsGrid, openPersonModal, savePersonFromModal, deletePersonFromModal, initAutocomplete
  };
})();
