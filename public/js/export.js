/**
 * export.js – Uvoz/Izvoz baze podataka (JSON, CSV) i galerija slika.
 */

const ExportImport = (function () {
  'use strict';

  // ─── Izvoz JSON ────────────────────────────────────────────────────────────

  function exportJSON() {
    const data = DB.exportAll();
    const json = JSON.stringify(data, null, 2);
    const filename = `antunovac-baza-${new Date().toISOString().slice(0,10)}.json`;
    UI.downloadString(json, filename, 'application/json');
    UI.toast('Baza izvezena kao JSON.', 'success');
  }

  // ─── Izvoz CSV ─────────────────────────────────────────────────────────────

  function toCSV(rows, headers) {
    const escape = (v) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      if (s.includes(',') || s.includes('"') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };
    const lines = [headers.join(',')];
    rows.forEach(row => lines.push(headers.map(h => escape(row[h])).join(',')));
    return lines.join('\n');
  }

  function exportCSV() {
    const data = DB.exportAll();

    const personsCSV = toCSV(data.persons, ['id','ime','prezime','djevojacko_prezime','godina_rodenja','godina_smrti','napomena','created_at','updated_at']);
    const tagsCSV = toCSV(data.tags, ['id','person_id','image_id','x','y','width','height','portrait_filename','portrait_drive_id','created_at']);
    const imagesCSV = toCSV(data.images, ['id','original_drive_id','original_filename','output_drive_id','processed_at','status','folder_id']);

    const prefix = `antunovac-${new Date().toISOString().slice(0,10)}`;
    UI.downloadString(personsCSV, `${prefix}-osobe.csv`, 'text/csv;charset=utf-8');
    setTimeout(() => UI.downloadString(tagsCSV, `${prefix}-oznake.csv`, 'text/csv;charset=utf-8'), 300);
    setTimeout(() => UI.downloadString(imagesCSV, `${prefix}-slike.csv`, 'text/csv;charset=utf-8'), 600);
    UI.toast('Baza izvezena kao CSV (3 datoteke).', 'success');
  }

  // ─── Uvoz JSON ─────────────────────────────────────────────────────────────

  async function importJSON(file) {
    const mode = document.querySelector('input[name="import-mode"]:checked')?.value || 'merge';

    const modeText = mode === 'replace'
      ? 'ZAMIJENITI sve postojeće podatke s uvezenim (ova radnja se ne može poništiti!)'
      : 'SPOJITI uvezene podatke s postojećima (duplicati će biti preskočeni)';

    const confirmed = await UI.confirm(
      `Uvoz će ${modeText}.\n\nDatoteka: ${file.name}\n\nŽelite li nastaviti?`,
      'Potvrda uvoza',
      'Uvezi'
    );
    if (!confirmed) return;

    UI.showLoading('Uvoz podataka...');
    try {
      const text = await file.text();
      let data;
      try { data = JSON.parse(text); }
      catch { throw new Error('Nevažeći JSON format datoteke.'); }

      if (!data.persons && !data.tags && !data.images) {
        throw new Error('Datoteka ne sadrži prepoznatljive podatke (persons, tags, images).');
      }

      const result = await DB.importAll(data, mode);
      UI.toast(`Uvoz završen: ${result.persons} osoba, ${result.tags} oznaka, ${result.images} slika.`, 'success');
      updateExportStats();
      Persons.renderPersonsGrid();
    } catch (e) {
      UI.toast(`Greška pri uvozu: ${e.message}`, 'error');
    } finally {
      UI.hideLoading();
    }
  }

  // ─── Statistike ────────────────────────────────────────────────────────────

  function updateExportStats() {
    const stats = DB.getStats();
    const el = (id) => document.getElementById(id);
    if (el('stat-persons')) el('stat-persons').textContent = stats.persons;
    if (el('stat-tags')) el('stat-tags').textContent = stats.tags;
    if (el('stat-images')) el('stat-images').textContent = stats.images;
  }

  // ─── GEDCOM Uvoz ───────────────────────────────────────────────────────────

  async function importGEDCOM(file) {
    UI.showLoading('Učitavanje i parsiranje GEDCOM datoteke...');
    try {
      const text = await file.text();
      
      // Kratki yield da se UI ne zamrzne
      await new Promise(resolve => setTimeout(resolve, 50));

      const parsed = GEDCOMParser.parse(text);
      const persons = parsed.individuals || [];
      if (!persons || persons.length === 0) {
        throw new Error('Nije pronađena niti jedna osoba u GEDCOM datoteci.');
      }

      UI.showLoading(`Spremanje ${persons.length} osoba u bazu...`);
      await new Promise(resolve => setTimeout(resolve, 50));

      const totalCount = await DB.savePersonsBatch(persons);

      const verMsg = parsed.header?.version ? ` (GEDCOM ${parsed.header.version})` : '';
      UI.toast(`GEDCOM uvoz uspješan${verMsg}! Uvezeno ${persons.length} osoba (ukupno u bazi: ${totalCount}) sa svim sirovim (raw_data) podacima.`, 'success');
      updateExportStats();
      Persons.renderPersonsGrid();
    } catch (e) {
      UI.toast(`Greška pri GEDCOM uvozu: ${e.message}`, 'error');
    } finally {
      UI.hideLoading();
    }
  }

  async function loadDemoGEDCOM() {
    UI.showLoading('Učitavanje testnih GEDCOM podataka...');
    try {
      const demoGEDCOM = `0 HEAD
1 GEDC
2 VERS 5.5.1
2 FORM LINEAGE-LINKED
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Stjepan /Hap/
2 GIVN Stjepan
2 SURN Hap
1 SEX M
1 BIRT
2 DATE 12 MAY 1890
2 PLAC Antunovac
1 DEAT
2 DATE 14 OCT 1965
2 PLAC Antunovac
1 FAMC @F1@
1 FAMS @F2@
0 @I2@ INDI
1 NAME Ivan /Hap/
2 GIVN Ivan
2 SURN Hap
1 SEX M
1 BIRT 1860
1 FAMS @F1@
0 @I3@ INDI
1 NAME Ana /Kolar/
2 GIVN Ana
2 SURN Kolar
1 SEX F
1 BIRT 1865
1 FAMS @F1@
0 @I4@ INDI
1 NAME Marija /Koleg/
2 GIVN Marija
2 SURN Koleg
2 _MAIDEN Koleg
1 SEX F
1 BIRT 1895
1 FAMS @F2@
0 @I5@ INDI
1 NAME Antun /Hap/
2 GIVN Antun
2 SURN Hap
1 SEX M
1 BIRT 1920
1 FAMC @F2@
0 @F1@ FAM
1 HUSB @I2@
1 WIFE @I3@
1 CHIL @I1@
0 @F2@ FAM
1 HUSB @I1@
1 WIFE @I4@
1 CHIL @I5@
0 TRLR`;

      await new Promise(r => setTimeout(r, 200));
      const parsed = GEDCOMParser.parse(demoGEDCOM);
      const persons = parsed.individuals || [];
      
      const totalCount = await DB.savePersonsBatch(persons);
      UI.toast(`Uspješno uvezeno 5 testnih osoba (ukupno u bazi: ${totalCount}) s potpunim relacijama!`, 'success');
      updateExportStats();
      Persons.renderPersonsGrid();
    } catch (e) {
      UI.toast(`Greška pri uvozu testnih podataka: ${e.message}`, 'error');
    } finally {
      UI.hideLoading();
    }
  }

  // ─── Init ─────────────────────────────────────────────────────────────────

  function init() {
    document.getElementById('btn-export-json')?.addEventListener('click', exportJSON);
    document.getElementById('btn-export-csv')?.addEventListener('click', exportCSV);

    // Uvoz – browse
    const fileInput = document.getElementById('import-file-input');
    document.getElementById('btn-browse-import')?.addEventListener('click', () => fileInput?.click());
    fileInput?.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (file) { importJSON(file); e.target.value = ''; }
    });

    // GEDCOM Uvoz
    const gedcomInput = document.getElementById('gedcom-file-input');
    document.getElementById('btn-browse-gedcom')?.addEventListener('click', () => gedcomInput?.click());
    gedcomInput?.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (file) { importGEDCOM(file); e.target.value = ''; }
    });

    // Uvoz testnih GEDCOM podataka
    document.getElementById('btn-load-demo-gedcom')?.addEventListener('click', loadDemoGEDCOM);

    // Uvoz – drag & drop
    const dropZone = document.getElementById('import-drop-zone');
    dropZone?.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
    dropZone?.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
    dropZone?.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
      const file = e.dataTransfer.files?.[0];
      if (file) importJSON(file);
    });
    dropZone?.addEventListener('keydown', (e) => { if (e.key === 'Enter') fileInput?.click(); });

    // Force sync
    document.getElementById('btn-force-sync')?.addEventListener('click', async () => {
      UI.showLoading('Sinkronizacija...');
      await DB.flushQueue();
      await DB.pullFromFirestore();
      updateExportStats();
      UI.hideLoading();
      UI.toast('Sinkronizacija završena.', 'success');
    });

    // Ažuriraj statistike pri prelasku na Export pogled
    document.addEventListener('viewChanged', (e) => {
      if (e.detail.view === 'export') updateExportStats();
    });
  }

  return { init, exportJSON, exportCSV, importJSON, importGEDCOM, loadDemoGEDCOM, updateExportStats };
})();
