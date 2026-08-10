/**
 * ui.js – UI pomoćne funkcije: toast obavijesti, modali, loading overlay,
 * navigacija između pogleda, generalni UI helpers.
 */

const UI = (function () {
  'use strict';

  // ─── Toast sustav ──────────────────────────────────────────────────────────
  const TOAST_ICONS = {
    success: `<svg class="toast-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10l4 4 8-8"/></svg>`,
    error:   `<svg class="toast-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 5l10 10M15 5L5 15"/></svg>`,
    warning: `<svg class="toast-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10 4v7M10 14v1"/><circle cx="10" cy="10" r="8"/></svg>`,
    info:    `<svg class="toast-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="10" cy="10" r="8"/><path d="M10 9v5M10 7v.5"/></svg>`
  };

  /**
   * Prikazuje toast obavijest.
   * @param {string} msg - Poruka
   * @param {'success'|'error'|'warning'|'info'} type - Tip obavijesti
   * @param {string} [title] - Opcionalni naslov
   * @param {number} [duration] - Trajanje u ms (0 = ne nestaje automatski)
   */
  function toast(msg, type = 'info', title = null, duration = 4000) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const defaultTitles = { success: 'Uspjeh', error: 'Greška', warning: 'Upozorenje', info: 'Obavijest' };
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.innerHTML = `
      ${TOAST_ICONS[type] || TOAST_ICONS.info}
      <div class="toast-body">
        <div class="toast-title">${title || defaultTitles[type]}</div>
        ${msg ? `<div class="toast-msg">${escapeHtml(msg)}</div>` : ''}
      </div>
      <button class="toast-close" aria-label="Zatvori">
        <svg viewBox="0 0 14 14"><path d="M1 1l12 12M13 1L1 13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </button>
    `;

    el.querySelector('.toast-close').addEventListener('click', () => dismissToast(el));
    container.appendChild(el);

    if (duration > 0) {
      setTimeout(() => dismissToast(el), duration);
    }
    return el;
  }

  function dismissToast(el) {
    if (!el || !el.parentNode) return;
    el.classList.add('hiding');
    setTimeout(() => el.remove(), 200);
  }

  // ─── Modal sustav ──────────────────────────────────────────────────────────
  const _modalStack = [];

  function openModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    modal.style.display = 'flex';
    modal.setAttribute('aria-hidden', 'false');
    _modalStack.push(id);
    // Zatvori na klik izvan modala
    modal.addEventListener('click', _handleModalBackdrop, { once: true });
    document.body.style.overflow = 'hidden';
    // Fokus na prvi element
    setTimeout(() => {
      const focusable = modal.querySelector('input, button, textarea, select, [tabindex]');
      if (focusable) focusable.focus();
    }, 50);
  }

  function closeModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
    const idx = _modalStack.indexOf(id);
    if (idx > -1) _modalStack.splice(idx, 1);
    if (_modalStack.length === 0) document.body.style.overflow = '';
  }

  function closeAllModals() {
    [..._modalStack].forEach(id => closeModal(id));
  }

  function _handleModalBackdrop(e) {
    if (e.target === e.currentTarget) {
      const id = e.currentTarget.id;
      closeModal(id);
    }
  }

  /**
   * Prikazuje modal za potvrdu (da/ne).
   * @param {string} msg - Poruka pitanja
   * @param {string} [title] - Naslov modala
   * @param {string} [confirmText] - Tekst tipke potvrde
   * @returns {Promise<boolean>} - true = potvrđeno, false = odustalo
   */
  function confirm(msg, title = 'Potvrda', confirmText = 'Potvrdi') {
    return new Promise((resolve) => {
      document.getElementById('modal-confirm-title').textContent = title;
      document.getElementById('modal-confirm-msg').textContent = msg;
      document.getElementById('btn-confirm-ok').textContent = confirmText;

      const okBtn = document.getElementById('btn-confirm-ok');
      const cancelBtn = document.getElementById('btn-confirm-cancel');

      const cleanup = (result) => {
        closeModal('modal-confirm');
        okBtn.replaceWith(okBtn.cloneNode(true));
        cancelBtn.replaceWith(cancelBtn.cloneNode(true));
        resolve(result);
        // Re-attach handlers after replaceWith
        initConfirmModal();
      };

      okBtn.onclick = () => cleanup(true);
      cancelBtn.onclick = () => cleanup(false);

      openModal('modal-confirm');
    });
  }

  function initConfirmModal() {
    document.getElementById('btn-confirm-ok').onclick = null;
    document.getElementById('btn-confirm-cancel').onclick = null;
  }

  // ─── Loading overlay ────────────────────────────────────────────────────────
  function showLoading(msg = 'Učitavanje...') {
    const overlay = document.getElementById('loading-overlay');
    const msgEl = document.getElementById('loading-msg');
    if (!overlay) return;
    msgEl.textContent = msg;
    overlay.style.display = 'flex';
  }

  function hideLoading() {
    const overlay = document.getElementById('loading-overlay');
    if (overlay) overlay.style.display = 'none';
  }

  // ─── Navigacija između pogleda ─────────────────────────────────────────────
  let _currentView = 'gallery';

  function showView(viewName) {
    // Sakrij sve poglede
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    // Deaktiviraj sve nav linkove
    document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));

    // Prikaži traženi pogled
    const viewEl = document.getElementById(`view-${viewName}`);
    if (viewEl) {
      viewEl.classList.add('active');
      _currentView = viewName;
    }

    // Aktiviraj nav link
    const navLink = document.querySelector(`[data-view="${viewName}"]`);
    if (navLink) navLink.classList.add('active');

    // Zatvori mobilni izbornik
    document.getElementById('nav-links')?.classList.remove('open');
    document.getElementById('nav-hamburger')?.setAttribute('aria-expanded', 'false');

    // Emit event za App controller
    document.dispatchEvent(new CustomEvent('viewChanged', { detail: { view: viewName } }));
  }

  function getCurrentView() { return _currentView; }

  // ─── HTML escaping ─────────────────────────────────────────────────────────
  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ─── Formatiranje podataka ─────────────────────────────────────────────────
  function formatPersonName(person) {
    if (!person) return 'Nepoznata osoba';
    const parts = [person.ime, person.prezime].filter(Boolean);
    return parts.join(' ') || 'Nepoznata osoba';
  }

  function formatYears(godRod, godSm) {
    if (!godRod && !godSm) return '';
    if (godRod && godSm) return `${godRod} – ${godSm}`;
    if (godRod) return `*${godRod}`;
    if (godSm) return `†${godSm}`;
  }

  function formatFileSize(bytes) {
    if (!bytes) return '–';
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes; let unit = 0;
    while (size > 1024 && unit < units.length - 1) { size /= 1024; unit++; }
    return `${size.toFixed(1)} ${units[unit]}`;
  }

  function formatDate(isoStr) {
    if (!isoStr) return '–';
    try {
      return new Date(isoStr).toLocaleDateString('hr-HR', { day: '2-digit', month: '2-digit', year: 'numeric' });
    } catch { return isoStr; }
  }

  // ─── Person inicijali (za avatar) ─────────────────────────────────────────
  function getInitials(person) {
    const ime = (person.ime || '').charAt(0).toUpperCase();
    const prezime = (person.prezime || '').charAt(0).toUpperCase();
    return (ime + prezime) || '?';
  }

  // ─── Slider binding helper ─────────────────────────────────────────────────
  function bindSlider(sliderId, valueId, suffix = '') {
    const slider = document.getElementById(sliderId);
    const valueEl = document.getElementById(valueId);
    if (!slider || !valueEl) return;
    const update = () => valueEl.textContent = slider.value + suffix;
    slider.addEventListener('input', update);
    update();
  }

  // ─── Debounce ──────────────────────────────────────────────────────────────
  function debounce(fn, delay = 300) {
    let timer;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), delay);
    };
  }

  // ─── Throttle ──────────────────────────────────────────────────────────────
  function throttle(fn, limit = 16) {
    let last = 0;
    return function (...args) {
      const now = Date.now();
      if (now - last >= limit) { last = now; fn.apply(this, args); }
    };
  }

  // ─── Download helper ───────────────────────────────────────────────────────
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function downloadString(content, filename, mimeType = 'text/plain') {
    downloadBlob(new Blob([content], { type: mimeType }), filename);
  }

  // ─── Init ─────────────────────────────────────────────────────────────────
  function init() {
    // Navigacijski linkovi
    document.querySelectorAll('[data-view]').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        showView(link.dataset.view);
      });
    });

    // Hamburger menu
    const hamburger = document.getElementById('nav-hamburger');
    const navLinks = document.getElementById('nav-links');
    hamburger?.addEventListener('click', () => {
      const isOpen = navLinks.classList.toggle('open');
      hamburger.setAttribute('aria-expanded', isOpen.toString());
    });

    // Zatvori nav na klik izvan
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.navbar')) {
        navLinks?.classList.remove('open');
        hamburger?.setAttribute('aria-expanded', 'false');
      }
    });

    // ESC zatvara modalne i deselektira
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (_modalStack.length > 0) {
          closeModal(_modalStack[_modalStack.length - 1]);
        }
      }
    });

    // Slider za JPEG kvalitetu
    bindSlider('jpeg-quality', 'jpeg-quality-val', '%');
  }

  // ─── Public API ───────────────────────────────────────────────────────────
  return {
    toast, dismissToast,
    openModal, closeModal, closeAllModals, confirm,
    showLoading, hideLoading,
    showView, getCurrentView,
    escapeHtml, formatPersonName, formatYears, formatFileSize, formatDate, getInitials,
    debounce, throttle, downloadBlob, downloadString,
    init
  };
})();
