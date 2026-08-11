const Comments = (function () {
  let _userRole = 'visitor';

  function init() {
    // Registriraj event listenere
    document.getElementById('comments-search')?.addEventListener('input', renderCommentsList);
    
    // Učitaj komentare na pokretu
    renderCommentsList();

    // Re-render when database is synced from server
    document.addEventListener('dbSynced', () => {
      renderCommentsList();
    });
  }

  function setRole(role) {
    _userRole = role;
    renderCommentsList();
  }

  function renderCommentsList() {
    const listContainer = document.getElementById('comments-dashboard-list');
    const subtitle = document.getElementById('comments-count-subtitle');
    if (!listContainer) return;

    const query = (document.getElementById('comments-search')?.value || '').toLowerCase().trim();
    const comments = DB.getAllComments();
    
    // Sortiraj: Najnoviji komentari na vrhu
    const sortedComments = [...comments].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    const filtered = sortedComments.filter(c => {
      const matchText = (c.comment_text || '').toLowerCase().includes(query);
      const matchAuthor = (c.author_name || '').toLowerCase().includes(query);
      return matchText || matchAuthor;
    });

    if (subtitle) {
      subtitle.textContent = `${comments.length} komentara u bazi (${filtered.length} filtrirano)`;
    }

    listContainer.innerHTML = '';

    if (filtered.length === 0) {
      listContainer.innerHTML = `
        <div class="card text-center" style="padding: var(--space-xl); color: var(--text-muted);">
          <p>Nema pronađenih komentara.</p>
        </div>
      `;
      return;
    }

    filtered.forEach(comment => {
      // Pronađi pripadajuću sliku
      let imgName = 'Nepoznata slika';
      let fileMeta = null;
      
      const imageRec = DB.getAllImages().find(img => img.original_drive_id === comment.target_id || img.id === comment.target_id);
      if (imageRec) {
        imgName = imageRec.original_filename;
        fileMeta = { id: imageRec.original_drive_id, name: imageRec.original_filename };
      }

      const card = document.createElement('div');
      card.className = 'card comment-dashboard-card';
      card.style.padding = 'var(--space-md)';
      card.style.display = 'flex';
      card.style.justifyContent = 'space-between';
      card.style.alignItems = 'flex-start';
      card.style.gap = 'var(--space-md)';
      card.style.marginBottom = 'var(--space-sm)';

      const dateStr = new Date(comment.created_at).toLocaleString('hr-HR');

      const deleteBtnHtml = _userRole === 'admin' 
        ? `<button class="btn btn-outline btn-xs" style="color: var(--danger); border-color: var(--danger);" data-id="${comment.id}" data-action="delete">Obriši</button>`
        : '';

      card.innerHTML = `
        <div style="flex: 1;">
          <div style="display: flex; align-items: baseline; gap: var(--space-sm); margin-bottom: 6px;">
            <strong style="color: var(--primary); font-size: 0.95rem;">${UI.escapeHtml(comment.author_name)}</strong>
            <span style="color: var(--text-muted); font-size: 0.75rem;">${dateStr}</span>
          </div>
          <p style="font-size: 0.9rem; line-height: 1.4; color: var(--text-primary); margin-bottom: 12px; white-space: pre-wrap;">${UI.escapeHtml(comment.comment_text)}</p>
          <div style="font-size: 0.8rem; color: var(--text-muted); display: flex; align-items: center; gap: 6px;">
            <span>Slika:</span>
            <a href="#" class="comment-image-link" style="color: var(--link-color); text-decoration: underline; font-weight: 500;" data-file-id="${comment.target_id}">${UI.escapeHtml(imgName)}</a>
          </div>
        </div>
        <div style="display: flex; flex-direction: column; gap: var(--space-sm); align-items: flex-end; justify-content: space-between; height: 100%;">
          <button class="btn btn-primary btn-xs" data-file-id="${comment.target_id}" data-action="open">Otvori sliku</button>
          ${deleteBtnHtml}
        </div>
      `;

      // Event listeneri na gumbe
      const imgLink = card.querySelector('.comment-image-link');
      const openBtn = card.querySelector('[data-action="open"]');
      const deleteBtn = card.querySelector('[data-action="delete"]');

      const handleOpen = (e) => {
        e.preventDefault();
        if (fileMeta) {
          window.app.openInEditor(fileMeta);
        } else {
          UI.toast('Slika nije pronađena u bazi.', 'error');
        }
      };

      imgLink?.addEventListener('click', handleOpen);
      openBtn?.addEventListener('click', handleOpen);

      deleteBtn?.addEventListener('click', () => {
        if (confirm('Jeste li sigurni da želite obrisati ovaj komentar?')) {
          DB.deleteComment(comment.id);
          renderCommentsList();
          UI.toast('Komentar obrisan.', 'success');
        }
      });

      listContainer.appendChild(card);
    });
  }

  return {
    init,
    setRole,
    renderCommentsList
  };
})();
