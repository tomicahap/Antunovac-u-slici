/**
 * keyboard.js – Globalni tipkovnički prečaci.
 */

const Keyboard = (function () {
  'use strict';

  function init() {
    document.addEventListener('keydown', (e) => {
      // Ignoruj ako je fokus na inputu
      const target = e.target;
      const inInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
      const view = UI.getCurrentView();

      // ─ Globalni (uvijek aktivni) ─
      if (e.key === 'Escape') return; // Handled by UI

      // ─ Editor prečaci ─
      if (view === 'editor') {
        // Ctrl/Cmd + S – Spremi
        if ((e.ctrlKey || e.metaKey) && e.key === 's' && !e.shiftKey) {
          e.preventDefault();
          Tags.saveCurrentImageToDrive();
          return;
        }

        // Ctrl/Cmd + Shift + S – Spremi sve
        if ((e.ctrlKey || e.metaKey) && e.key === 's' && e.shiftKey) {
          e.preventDefault();
          Tags.saveCurrentImageToDrive();
          return;
        }

        if (inInput) return; // Ostale tipke ne interceptiraj u inputima

        // Delete / Backspace – Obriši odabranu oznaku
        if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault();
          Tags.deleteSelectedTag();
          return;
        }

        // + / = – Zoom in
        if (e.key === '+' || e.key === '=') {
          e.preventDefault();
          CanvasEngine.zoomIn();
          return;
        }

        // - – Zoom out
        if (e.key === '-') {
          e.preventDefault();
          CanvasEngine.zoomOut();
          return;
        }

        // F – Fit to screen
        if (e.key === 'f' || e.key === 'F') {
          e.preventDefault();
          CanvasEngine.fitToScreen();
          return;
        }

        // D – Draw mode
        if (e.key === 'd' || e.key === 'D') {
          e.preventDefault();
          CanvasEngine.setMode('draw');
          return;
        }

        // P – Pan mode
        if (e.key === 'p' || e.key === 'P') {
          e.preventDefault();
          CanvasEngine.setMode('pan');
          return;
        }

        // Tab – Sljedeća oznaka
        if (e.key === 'Tab') {
          e.preventDefault();
          Tags.selectNextTag(!e.shiftKey);
          return;
        }
      }

      // ─ Pretraga – Ctrl+F ─
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        UI.showView('search');
        document.getElementById('search-ime')?.focus();
      }
    });
  }

  return { init };
})();
