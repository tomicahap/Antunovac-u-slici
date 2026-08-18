/**
 * canvas.js – Interaktivni canvas engine.
 *
 * Funkcionalnosti:
 * - Prikaz slike (JPG, PNG; TIFF se prikazuje kao JPEG s backenda)
 * - Zoom (kotačić, pinch-to-zoom, +/- tipke) centriran na kursor
 * - Pan (drag, Space+drag, strelice)
 * - Crtanje pravokutnih okvira za oznake (draw mode)
 * - Prikaz postojećih okvira s bojama i labelama
 * - Hover/selekcija okvira
 * - Touch podrška (pinch + pan + crtanje)
 * - Koordinate u postotcima (0–100) neovisno o rezoluciji
 */

const CanvasEngine = (function () {
  'use strict';

  // ─── Boje oznaka ────────────────────────────────────────────────────────────
  const TAG_COLORS = [
    '#4f8ef7', '#f75b5b', '#3ecf8e', '#f5a623', '#a855f7',
    '#f75baf', '#4bf7e0', '#f7e84f', '#7bf75b', '#f75b75',
    '#f59e42', '#42d4f5', '#e842f5', '#42f584', '#f5c842'
  ];

  function getTagColor(index) {
    return TAG_COLORS[index % TAG_COLORS.length];
  }

  // ─── State ─────────────────────────────────────────────────────────────────
  let canvas, ctx, wrapper;
  let _image = null;          // HTMLImageElement
  let _imageFileId = null;
  let _imageMeta = null;      // { name, mimeType, ... }

  // Viewport
  let _scale = 1;
  let _offsetX = 0, _offsetY = 0;
  let _minScale = 0.05;
  let _maxScale = 20;

  // Draw state
  let _mode = 'draw'; // 'pan' | 'draw'
  let _isDrawing = false;
  let _drawStartX = 0, _drawStartY = 0;
  let _drawRect = null; // { x1, y1, x2, y2 } u canvas koordinatama

  // Pan state
  let _isPanning = false;
  let _panStartX = 0, _panStartY = 0;
  let _panStartOffX = 0, _panStartOffY = 0;
  let _spaceDown = false;

  // Touch state
  let _touches = {};
  let _lastPinchDist = 0;
  let _lastPinchMidX = 0, _lastPinchMidY = 0;
  let _touchMode = 'idle'; // 'idle' | 'pan' | 'pinch' | 'draw'

  // Tags
  let _tags = [];
  let _selectedTagId = null;
  let _hoveredTagId = null;

  // Settings
  let _showLabels = true;
  let _readOnly = false;

  // Drag/Resize Actions
  let _activeAction = null;        // null | 'moving' | 'resizing'
  let _actionStartPercent = null;   // { x, y }
  let _actionStartRect = null;      // { x, y, width, height }
  let _activeResizeHandle = null;   // 'tl' | 'tr' | 'bl' | 'br'
  let _onTagChanged = null;         // fn(tag)

  // Callbacks
  let _onTagDrawn = null;  // fn({ x, y, width, height }) – u postotcima
  let _onTagSelected = null; // fn(tagId)
  let _onTagDrag = null;     // fn(tag)
  let _onCursorPos = null;  // fn(percentX, percentY)

  let _animFrame = null;

  // ─── Koordinate ────────────────────────────────────────────────────────────

  function imageToCanvas(imgX, imgY) {
    if (!_image) return { x: 0, y: 0 };
    const dpr = window.devicePixelRatio || 1;
    const cw = canvas.width / dpr;
    const ch = canvas.height / dpr;
    const cx = (imgX - _image.naturalWidth / 2) * _scale + cw / 2 + _offsetX;
    const cy = (imgY - _image.naturalHeight / 2) * _scale + ch / 2 + _offsetY;
    return { x: cx, y: cy };
  }

  function canvasToImage(cx, cy) {
    if (!_image) return { x: 0, y: 0 };
    const dpr = window.devicePixelRatio || 1;
    const cw = canvas.width / dpr;
    const ch = canvas.height / dpr;
    const imgX = (cx - cw / 2 - _offsetX) / _scale + _image.naturalWidth / 2;
    const imgY = (cy - ch / 2 - _offsetY) / _scale + _image.naturalHeight / 2;
    return { x: imgX, y: imgY };
  }

  function imageToPercent(imgX, imgY) {
    if (!_image) return { x: 0, y: 0 };
    return {
      x: (imgX / _image.naturalWidth) * 100,
      y: (imgY / _image.naturalHeight) * 100
    };
  }

  function percentToImage(px, py) {
    if (!_image) return { x: 0, y: 0 };
    return {
      x: (px / 100) * _image.naturalWidth,
      y: (py / 100) * _image.naturalHeight
    };
  }

  function percentToCanvas(px, py) {
    const { x: imgX, y: imgY } = percentToImage(px, py);
    return imageToCanvas(imgX, imgY);
  }

  function canvasToPercent(cx, cy) {
    const { x: imgX, y: imgY } = canvasToImage(cx, cy);
    return imageToPercent(imgX, imgY);
  }

  // ─── Canvas resize ─────────────────────────────────────────────────────────

  function resizeCanvas() {
    if (!canvas || !wrapper) return;
    const dpr = window.devicePixelRatio || 1;
    const w = wrapper.clientWidth;
    const h = wrapper.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.scale(dpr, dpr);
    requestRedraw();
  }

  // ─── Fit to screen ─────────────────────────────────────────────────────────

  function fitToScreen() {
    if (!_image || !canvas) return;
    const cw = canvas.width / (window.devicePixelRatio || 1);
    const ch = canvas.height / (window.devicePixelRatio || 1);
    const padding = 40;
    const scaleX = (cw - padding * 2) / _image.naturalWidth;
    const scaleY = (ch - padding * 2) / _image.naturalHeight;
    _scale = Math.min(scaleX, scaleY, 1); // Ne povećavaj malene slike
    _offsetX = 0;
    _offsetY = 0;
    updateZoomDisplay();
    requestRedraw();
  }

  // ─── Zoom ──────────────────────────────────────────────────────────────────

  function zoomAt(factor, cx, cy) {
    const cw = canvas.width / (window.devicePixelRatio || 1);
    const ch = canvas.height / (window.devicePixelRatio || 1);
    // Pixel koordinate relativne na središte canvasa
    const relX = (cx !== undefined ? cx : cw / 2) - cw / 2;
    const relY = (cy !== undefined ? cy : ch / 2) - ch / 2;

    const newScale = Math.min(Math.max(_scale * factor, _minScale), _maxScale);
    const scaleDiff = newScale / _scale;

    // Prilagodi offset da zoom bude centriran na (cx, cy)
    _offsetX = relX + ((_offsetX - relX) * scaleDiff);
    _offsetY = relY + ((_offsetY - relY) * scaleDiff);
    _scale = newScale;

    updateZoomDisplay();
    requestRedraw();
  }

  function zoomIn(cx, cy) { zoomAt(1.2, cx, cy); }
  function zoomOut(cx, cy) { zoomAt(1 / 1.2, cx, cy); }

  function setZoom(level) {
    _scale = Math.min(Math.max(level, _minScale), _maxScale);
    updateZoomDisplay();
    requestRedraw();
  }

  function updateZoomDisplay() {
    const el = document.getElementById('zoom-level');
    if (el) el.textContent = Math.round(_scale * 100) + '%';
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  function requestRedraw() {
    if (_animFrame) cancelAnimationFrame(_animFrame);
    _animFrame = requestAnimationFrame(render);
  }

  function render() {
    _animFrame = null;
    if (!ctx || !canvas) return;

    const dpr = window.devicePixelRatio || 1;
    const cw = canvas.width / dpr;
    const ch = canvas.height / dpr;

    // Poništi transformaciju DPR-a
    ctx.save();
    ctx.scale(1 / dpr, 1 / dpr);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.scale(dpr, dpr);

    if (_image) {
      // Izračunaj poziciju i dimenzije slike
      const iw = _image.naturalWidth * _scale;
      const ih = _image.naturalHeight * _scale;
      const ix = cw / 2 + _offsetX - iw / 2;
      const iy = ch / 2 + _offsetY - ih / 2;

      // Lagana sjena
      ctx.shadowColor = 'rgba(0,0,0,0.5)';
      ctx.shadowBlur = 20;
      ctx.drawImage(_image, ix, iy, iw, ih);
      ctx.shadowBlur = 0;
      ctx.shadowColor = 'transparent';

      // Crtaj oznake
      _tags.forEach((tag, idx) => {
        drawTag(tag, idx);
      });

      // Trenutni okvir koji se crta
      if (_isDrawing && _drawRect) {
        drawCurrentRect();
      }
    } else {
      // Placeholder kad nema slike
      ctx.fillStyle = 'rgba(255,255,255,0.03)';
      ctx.fillRect(0, 0, cw, ch);
    }

    ctx.restore();
  }

  function drawTag(tag, idx) {
    if (!_image) return;

    const color = getTagColor(idx);
    const isSelected = tag.id === _selectedTagId;
    const isHovered = tag.id === _hoveredTagId;

    // Konvertiraj postotke u canvas koordinate
    const tl = percentToCanvas(tag.x, tag.y);
    const br = percentToCanvas(tag.x + tag.width, tag.y + tag.height);
    const tw = br.x - tl.x;
    const th = br.y - tl.y;

    if (tw < 2 || th < 2) return; // Presitan za prikaz

    // Ispuna s niskom prozirnosti
    ctx.fillStyle = hexToRgba(color, isSelected ? 0.2 : isHovered ? 0.12 : 0.08);
    ctx.fillRect(tl.x, tl.y, tw, th);

    // Okvir
    ctx.strokeStyle = color;
    ctx.lineWidth = isSelected ? 2.5 : 1.5;
    ctx.setLineDash(isSelected ? [] : []);
    ctx.strokeRect(tl.x, tl.y, tw, th);

    // Kutne točke (handles) kad je selektiran
    if (isSelected) {
      const hs = 6;
      ctx.fillStyle = color;
      const corners = [
        [tl.x, tl.y], [br.x, tl.y], [tl.x, br.y], [br.x, br.y],
        [(tl.x + br.x) / 2, tl.y], [(tl.x + br.x) / 2, br.y],
        [tl.x, (tl.y + br.y) / 2], [br.x, (tl.y + br.y) / 2]
      ];
      corners.forEach(([hx, hy]) => {
        ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
      });
    }

    // Labela (redni broj + ime/prezime)
    if (_showLabels) {
      const person = tag._person;
      const nameStr = person ? UI.formatPersonName(person) : 'Osoba';
      const label = `#${idx + 1} ${nameStr}`;
      drawTagLabel(label, color, tl.x, tl.y, tw);
    }
  }

  function drawTagLabel(text, color, x, y, maxWidth) {
    const padding = 4;
    const fontSize = Math.max(10, Math.min(14, _scale * 8));
    ctx.font = `500 ${fontSize}px Inter, sans-serif`;

    const textW = Math.min(ctx.measureText(text).width, maxWidth - padding * 2);
    const boxW = textW + padding * 2;
    const boxH = fontSize + padding * 2;
    const boxY = y - boxH - 2;
    const boxX = x;

    // Pozadina labele
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(boxX, Math.max(2, boxY), boxW, boxH, 3);
    ctx.fill();

    // Tekst
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, boxX + padding, Math.max(boxH, boxY + boxH - padding), textW);
  }

  function drawCurrentRect() {
    if (!_drawRect) return;

    const { x1, y1, x2, y2 } = _drawRect;
    const x = Math.min(x1, x2);
    const y = Math.min(y1, y2);
    const w = Math.abs(x2 - x1);
    const h = Math.abs(y2 - y1);

    if (w < 3 || h < 3) return;

    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 3]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);

    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(x, y, w, h);

    // Dimenzije
    if (w > 60 && h > 30) {
      const { x: px1, y: py1 } = canvasToPercent(x, y);
      const { x: px2, y: py2 } = canvasToPercent(x + w, y + h);
      const pw = Math.abs(px2 - px1).toFixed(1);
      const ph = Math.abs(py2 - py1).toFixed(1);
      ctx.font = '11px Inter, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.fillText(`${pw}% × ${ph}%`, x + 4, y + h - 6);
    }
  }

  // ─── Hit test ──────────────────────────────────────────────────────────────

  function getTagAtCanvas(cx, cy) {
    // Iterira u obrnutom redoslijedu (posljednji nacrtani = na vrhu)
    for (let i = _tags.length - 1; i >= 0; i--) {
      const tag = _tags[i];
      const tl = percentToCanvas(tag.x, tag.y);
      const br = percentToCanvas(tag.x + tag.width, tag.y + tag.height);
      if (cx >= tl.x && cx <= br.x && cy >= tl.y && cy <= br.y) {
        return tag.id;
      }
    }
    return null;
  }

  function isInsideImage(cx, cy) {
    if (!_image) return false;
    const { x: imgX, y: imgY } = canvasToImage(cx, cy);
    return imgX >= 0 && imgX <= _image.naturalWidth && imgY >= 0 && imgY <= _image.naturalHeight;
  }

  // ─── Event handlers – Mouse ─────────────────────────────────────────────────

  function createNewTagBox(px, py) {
    if (!_image) return;

    let targetW = 413;
    let targetH = 531;

    // Ako je slika manja, prilagodi zadržavajući omjer 7:9
    if (targetW > _image.naturalWidth || targetH > _image.naturalHeight) {
      const maxH = Math.min(_image.naturalHeight, _image.naturalWidth * (9 / 7)) * 0.8;
      targetH = maxH;
      targetW = maxH * (7 / 9);
    }

    const percentWidth = (targetW / _image.naturalWidth) * 100;
    const percentHeight = (targetH / _image.naturalHeight) * 100;

    let rectX = px - percentWidth / 2;
    let rectY = py - percentHeight / 2;

    // Clamp
    if (rectX < 0) rectX = 0;
    if (rectX + percentWidth > 100) rectX = 100 - percentWidth;
    if (rectY < 0) rectY = 0;
    if (rectY + percentHeight > 100) rectY = 100 - percentHeight;

    const rect = {
      x: rectX,
      y: rectY,
      width: percentWidth,
      height: percentHeight
    };

    if (_onTagDrawn) {
      _onTagDrawn(rect);
    }
  }

  // ─── Event handlers – Mouse ─────────────────────────────────────────────────

  function getCanvasPos(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  let _potentialPanStartX = null;
  let _potentialPanStartY = null;

  function onMouseDown(e) {
    if (e.button === 1 || e.button === 2) {
      e.preventDefault();
      startPan(e);
      return;
    }
    if (e.button !== 0) return;

    const { x, y } = getCanvasPos(e);

    // 1. Ako je označen tag i nismo u read-only načinu, provjeri klik na handles ili micanje
    if (_selectedTagId && !_readOnly) {
      const tag = _tags.find(t => t.id === _selectedTagId);
      if (tag) {
        const tl = percentToCanvas(tag.x, tag.y);
        const br = percentToCanvas(tag.x + tag.width, tag.y + tag.height);
        
        // 8 handles
        const handles = [
          { name: 'tl', x: tl.x, y: tl.y },
          { name: 'tr', x: br.x, y: tl.y },
          { name: 'bl', x: tl.x, y: br.y },
          { name: 'br', x: br.x, y: br.y },
          { name: 'tm', x: (tl.x + br.x) / 2, y: tl.y },
          { name: 'bm', x: (tl.x + br.x) / 2, y: br.y },
          { name: 'lm', x: tl.x, y: (tl.y + br.y) / 2 },
          { name: 'rm', x: br.x, y: (tl.y + br.y) / 2 }
        ];
        
        const hit = handles.find(h => Math.hypot(x - h.x, y - h.y) < 10);
        if (hit) {
          e.preventDefault();
          _activeAction = 'resizing';
          _activeResizeHandle = ['tl', 'tm', 'lm'].includes(hit.name) ? 'tl' : 
                                ['tr'].includes(hit.name) ? 'tr' :
                                ['bl'].includes(hit.name) ? 'bl' : 'br';
          _actionStartPercent = canvasToPercent(x, y);
          _actionStartRect = { x: tag.x, y: tag.y, width: tag.width, height: tag.height };
          return;
        }
        
        // Provjeri micanje (drag)
        if (x >= tl.x && x <= br.x && y >= tl.y && y <= br.y) {
          e.preventDefault();
          _activeAction = 'moving';
          _actionStartPercent = canvasToPercent(x, y);
          _actionStartRect = { x: tag.x, y: tag.y, width: tag.width, height: tag.height };
          return;
        }
      }
    }

    // 2. Klik na drugi tag = selekcija (dostupno u svim modovima)
    const hitTagId = getTagAtCanvas(x, y);
    if (hitTagId) {
      e.preventDefault();
      selectTag(hitTagId);
      return;
    }

    // 3. Klik na prazan prostor
    if (_spaceDown || _mode === 'draw' && !_readOnly) {
      _potentialPanStartX = e.clientX;
      _potentialPanStartY = e.clientY;
    }
  }

  function onMouseMove(e) {
    const { x, y } = getCanvasPos(e);

    // Rukovanje micanjem ili promjenom veličine oznake
    if (_activeAction && _selectedTagId && !_readOnly) {
      const tag = _tags.find(t => t.id === _selectedTagId);
      if (tag && _actionStartPercent && _actionStartRect) {
        const { x: px, y: py } = canvasToPercent(x, y);
        
        if (_activeAction === 'moving') {
          const dx = px - _actionStartPercent.x;
          const dy = py - _actionStartPercent.y;
          
          let newX = _actionStartRect.x + dx;
          let newY = _actionStartRect.y + dy;
          
          if (newX < 0) newX = 0;
          if (newX + _actionStartRect.width > 100) newX = 100 - _actionStartRect.width;
          if (newY < 0) newY = 0;
          if (newY + _actionStartRect.height > 100) newY = 100 - _actionStartRect.height;
          
          tag.x = newX;
          tag.y = newY;
          requestRedraw();
          if (_onTagDrag) _onTagDrag(tag);
        } else if (_activeAction === 'resizing') {
          const aspectPct = (3.5 / 4.5) * (_image.naturalHeight / _image.naturalWidth);
          const dx = px - _actionStartPercent.x;
          
          let anchorX, anchorY;
          let signX = 1, signY = 1;
          
          if (_activeResizeHandle === 'br') {
            anchorX = _actionStartRect.x;
            anchorY = _actionStartRect.y;
            signX = 1; signY = 1;
          } else if (_activeResizeHandle === 'bl') {
            anchorX = _actionStartRect.x + _actionStartRect.width;
            anchorY = _actionStartRect.y;
            signX = -1; signY = 1;
          } else if (_activeResizeHandle === 'tr') {
            anchorX = _actionStartRect.x;
            anchorY = _actionStartRect.y + _actionStartRect.height;
            signX = 1; signY = -1;
          } else if (_activeResizeHandle === 'tl') {
            anchorX = _actionStartRect.x + _actionStartRect.width;
            anchorY = _actionStartRect.y + _actionStartRect.height;
            signX = -1; signY = -1;
          }
          
          let newW = _actionStartRect.width + dx * signX;
          let newH = newW / aspectPct;
          
          if (newW < 5) { newW = 5; newH = newW / aspectPct; }
          
          let newX = signX === 1 ? anchorX : anchorX - newW;
          let newY = signY === 1 ? anchorY : anchorY - newH;
          
          if (newX < 0) { newX = 0; newW = anchorX; newH = newW / aspectPct; }
          if (newX + newW > 100) { newW = 100 - anchorX; newH = newW / aspectPct; }
          if (newY < 0) { newY = 0; newH = anchorY; newW = newH * aspectPct; }
          if (newY + newH > 100) { newH = 100 - anchorY; newW = newH * aspectPct; }
          
          newX = signX === 1 ? anchorX : anchorX - newW;
          newY = signY === 1 ? anchorY : anchorY - newH;
          
          tag.x = newX;
          tag.y = newY;
          tag.width = newW;
          tag.height = newH;
          requestRedraw();
          if (_onTagDrag) _onTagDrag(tag);
        }
      }
      return;
    }

    // Hover
    if (_mode !== 'draw') {
      const tagId = getTagAtCanvas(x, y);
      if (tagId !== _hoveredTagId) {
        _hoveredTagId = tagId;
        canvas.style.cursor = tagId ? 'pointer' : '';
        requestRedraw();
      }
    }

    // Cursor position
    if (_onCursorPos && _image) {
      const { x: px, y: py } = canvasToPercent(x, y);
      if (px >= 0 && px <= 100 && py >= 0 && py <= 100) {
        _onCursorPos(px.toFixed(1), py.toFixed(1));
      }
    }
  }

  function onMouseUp(e) {
    if (_isPanning) {
      endPan();
      return;
    }

    if (_potentialPanStartX !== null) {
      _potentialPanStartX = null;
    }

    if (_activeAction) {
      const tag = _tags.find(t => t.id === _selectedTagId);
      if (tag && _onTagChanged) {
        _onTagChanged(tag);
      }
      _activeAction = null;
      _activeResizeHandle = null;
      _actionStartPercent = null;
      _actionStartRect = null;
    }
  }

  function onMouseLeave() {
    if (_isDrawing) endDraw();
    _hoveredTagId = null;
    _activeAction = null;
    requestRedraw();
  }

  function onWheel(e) {
    e.preventDefault();
    const { x, y } = getCanvasPos(e);
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    zoomAt(factor, x, y);
  }

  function onContextMenu(e) { e.preventDefault(); }

  // ─── Pan ───────────────────────────────────────────────────────────────────

  function startPan(e) {
    _isPanning = true;
    _panStartX = e.clientX;
    _panStartY = e.clientY;
    _panStartOffX = _offsetX;
    _panStartOffY = _offsetY;
    wrapper.classList.add('panning');
  }

  function doPan(e) {
    _offsetX = _panStartOffX + (e.clientX - _panStartX);
    _offsetY = _panStartOffY + (e.clientY - _panStartY);
    requestRedraw();
  }

  function endPan() {
    _isPanning = false;
    wrapper.classList.remove('panning');
  }

  // ─── Draw ──────────────────────────────────────────────────────────────────

  function startDraw(x, y) {
    _isDrawing = true;
    _drawStartX = x;
    _drawStartY = y;
    _drawRect = { x1: x, y1: y, x2: x, y2: y };
  }

  function endDraw() {
    if (!_isDrawing) return;
    _isDrawing = false;

    if (_drawRect) {
      const { x1, y1, x2, y2 } = _drawRect;
      const x = Math.min(x1, x2);
      const y = Math.min(y1, y2);
      const w = Math.abs(x2 - x1);
      const h = Math.abs(y2 - y1);

      _drawRect = null;
      requestRedraw();

      // Minimalna veličina okvira (10x10 canvas px)
      if (w >= 10 && h >= 10) {
        // Konvertiraj u postotke
        const { x: px1, y: py1 } = canvasToPercent(x, y);
        const { x: px2, y: py2 } = canvasToPercent(x + w, y + h);

        const rect = {
          x: Math.max(0, Math.min(px1, px2)),
          y: Math.max(0, Math.min(py1, py2)),
          width: Math.abs(px2 - px1),
          height: Math.abs(py2 - py1)
        };

        // Klampaj na granice slike
        if (rect.x + rect.width > 100) rect.width = 100 - rect.x;
        if (rect.y + rect.height > 100) rect.height = 100 - rect.y;

        if (rect.width > 0.5 && rect.height > 0.5 && _onTagDrawn) {
          _onTagDrawn(rect);
        }
      }
    }
  }

  // ─── Touch events ──────────────────────────────────────────────────────────

  function getTouchDistance(t1, t2) {
    const dx = t1.clientX - t2.clientX;
    const dy = t1.clientY - t2.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function getTouchMidpoint(t1, t2, rect) {
    return {
      x: (t1.clientX + t2.clientX) / 2 - rect.left,
      y: (t1.clientY + t2.clientY) / 2 - rect.top
    };
  }

  function onTouchStart(e) {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const touches = e.touches;

    if (touches.length === 1) {
      const t = touches[0];
      const cx = t.clientX - rect.left;
      const cy = t.clientY - rect.top;

      if (_mode === 'draw' && isInsideImage(cx, cy)) {
        _touchMode = 'draw';
        startDraw(cx, cy);
      } else {
        _touchMode = 'pan';
        _isPanning = true;
        _panStartX = t.clientX;
        _panStartY = t.clientY;
        _panStartOffX = _offsetX;
        _panStartOffY = _offsetY;
      }
    } else if (touches.length === 2) {
      if (_isDrawing) { _isDrawing = false; _drawRect = null; }
      _isPanning = false;
      _touchMode = 'pinch';
      _lastPinchDist = getTouchDistance(touches[0], touches[1]);
      const mid = getTouchMidpoint(touches[0], touches[1], rect);
      _lastPinchMidX = mid.x;
      _lastPinchMidY = mid.y;
    }
  }

  function onTouchMove(e) {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const touches = e.touches;

    if (_touchMode === 'pinch' && touches.length >= 2) {
      const dist = getTouchDistance(touches[0], touches[1]);
      const mid = getTouchMidpoint(touches[0], touches[1], rect);

      if (_lastPinchDist > 0) {
        const factor = dist / _lastPinchDist;
        zoomAt(factor, mid.x, mid.y);
      }

      // Pan iz pomaka središta
      const dx = mid.x - _lastPinchMidX;
      const dy = mid.y - _lastPinchMidY;
      _offsetX += dx;
      _offsetY += dy;

      _lastPinchDist = dist;
      _lastPinchMidX = mid.x;
      _lastPinchMidY = mid.y;
      requestRedraw();
    } else if (_touchMode === 'pan' && touches.length === 1) {
      const t = touches[0];
      _offsetX = _panStartOffX + (t.clientX - _panStartX);
      _offsetY = _panStartOffY + (t.clientY - _panStartY);
      requestRedraw();
    } else if (_touchMode === 'draw' && touches.length === 1) {
      const t = touches[0];
      const cx = t.clientX - rect.left;
      const cy = t.clientY - rect.top;
      if (_drawRect) { _drawRect.x2 = cx; _drawRect.y2 = cy; }
      requestRedraw();
    }
  }

  function onTouchEnd(e) {
    e.preventDefault();
    if (_touchMode === 'draw') endDraw();
    else if (_touchMode === 'pan') { _isPanning = false; }
    _touchMode = 'idle';
    _lastPinchDist = 0;
  }

  // ─── Keyboard ──────────────────────────────────────────────────────────────

  function handleKeydown(e) {
    if (!canvas) return;
    // Strelice za pan
    const step = 20;
    switch (e.key) {
      case 'ArrowLeft':  _offsetX += step; requestRedraw(); e.preventDefault(); break;
      case 'ArrowRight': _offsetX -= step; requestRedraw(); e.preventDefault(); break;
      case 'ArrowUp':    _offsetY += step; requestRedraw(); e.preventDefault(); break;
      case 'ArrowDown':  _offsetY -= step; requestRedraw(); e.preventDefault(); break;
      case ' ':
        if (!_spaceDown) { _spaceDown = true; wrapper.classList.add('mode-pan'); }
        e.preventDefault();
        break;
    }
  }

  function handleKeyup(e) {
    if (e.key === ' ') {
      _spaceDown = false;
      if (_mode === 'draw') wrapper.classList.remove('mode-pan');
    }
  }

  // ─── Public API – Image loading ─────────────────────────────────────────────

  async function loadImageProgressive(thumbUrl, highResUrl, fileId, meta) {
    try {
      const overlay = document.getElementById('canvas-overlay-msg');
      if (overlay) {
        overlay.classList.remove('hidden');
        overlay.innerHTML = `<p id="loading-progress">Brzo učitavanje...</p>`;
      }

      // 1. Odmah učitaj thumbnail da korisnik može početi raditi
      const thumbImg = new Image();
      thumbImg.crossOrigin = 'anonymous';
      await new Promise((resolve, reject) => {
        thumbImg.onload = resolve;
        thumbImg.onerror = reject;
        thumbImg.src = thumbUrl;
      });

      _image = thumbImg;
      _imageFileId = fileId;
      _imageMeta = meta || {};
      
      fitToScreen();
      requestRedraw();
      updateImageInfo();
      
      // 2. Sada u pozadini povlači pravu sliku uz progress
      if (overlay) {
        overlay.innerHTML = `<div style="background: rgba(0,0,0,0.7); padding: 5px 15px; border-radius: 20px; font-size: 0.8rem; border: 1px solid var(--accent);"><span class="spinner" style="width:12px; height:12px; border-width:2px; display:inline-block; vertical-align:middle; margin-right:8px;"></span><span id="loading-progress">Učitavanje originala...</span></div>`;
      }

      const response = await fetch(highResUrl);
      if (!response.ok) throw new Error('Greška pri dohvaćanju originala');

      const total = parseInt(meta?.size || response.headers.get('content-length'), 10);
      let loaded = 0;

      const reader = response.body.getReader();
      const chunks = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;

        const progressEl = document.getElementById('loading-progress');
        if (progressEl) {
          if (total) {
            const pct = Math.round((loaded / total) * 100);
            progressEl.textContent = `Original: ${pct}% (${(loaded / (1024*1024)).toFixed(1)} MB / ${(total / (1024*1024)).toFixed(1)} MB)`;
          } else {
            progressEl.textContent = `Original: ${(loaded / (1024*1024)).toFixed(1)} MB`;
          }
        }
      }

      const blob = new Blob(chunks, { type: meta?.mimeType || 'image/jpeg' });
      const objectUrl = URL.createObjectURL(blob);

      const highResImg = new Image();
      highResImg.crossOrigin = 'anonymous';
      
      highResImg.onload = () => {
        // Hot-swap
        _image = highResImg;
        if (overlay) overlay.classList.add('hidden');
        URL.revokeObjectURL(objectUrl);
        requestRedraw();
      };
      
      highResImg.onerror = () => {
        if (overlay) overlay.classList.add('hidden');
        UI.toast('Pogreška pri učitavanju slike visoke rezolucije', 'error');
      };
      
      highResImg.src = objectUrl;

    } catch (err) {
      console.error(err);
      UI.toast('Pogreška pri učitavanju', 'error');
      const overlay = document.getElementById('canvas-overlay-msg');
      if (overlay) overlay.classList.add('hidden');
    }
  }

  async function loadImageFromUrl(url, fileId, meta) {
    try {
      const overlay = document.getElementById('canvas-overlay-msg');
      if (overlay) {
        overlay.classList.remove('hidden');
        overlay.innerHTML = `<p id="loading-progress">Učitavanje: 0 KB</p>`;
      }

      const response = await fetch(url);
      if (!response.ok) {
        let errMsg = `Status: ${response.status} ${response.statusText}`;
        try {
          const errData = await response.json();
          if (errData && errData.error) {
            errMsg += ` - ${errData.error}`;
          }
        } catch {}
        console.error(`[CanvasEngine] Greška pri dohvaćanju slike s rute ${url}: ${errMsg}`);
        throw new Error(`Greška pri dohvaćanju slike (${errMsg})`);
      }

      const total = parseInt(meta?.size || response.headers.get('content-length'), 10);
      let loaded = 0;

      const reader = response.body.getReader();
      const chunks = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;

        const progressEl = document.getElementById('loading-progress');
        if (progressEl) {
          if (total) {
            progressEl.textContent = `Učitavanje: ${(loaded / 1024).toFixed(1)} KB / ${(total / 1024).toFixed(1)} KB`;
          } else {
            progressEl.textContent = `Učitavanje: ${(loaded / 1024).toFixed(1)} KB`;
          }
        }
      }

      const blob = new Blob(chunks, { type: meta?.mimeType || 'image/jpeg' });
      const objectUrl = URL.createObjectURL(blob);

      return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          _image = img;
          _imageFileId = fileId;
          _imageMeta = meta || {};

          if (overlay) overlay.classList.add('hidden');
          URL.revokeObjectURL(objectUrl);

          fitToScreen();
          requestRedraw();
          updateImageInfo();
          resolve(img);
        };
        img.onerror = () => {
          reject(new Error('Nije moguće renderirati sliku.'));
        };
        img.src = objectUrl;
      });
    } catch (err) {
      throw err;
    }
  }

  function clearImage() {
    _image = null;
    _imageFileId = null;
    _imageMeta = null;
    _tags = [];
    _selectedTagId = null;
    _hoveredTagId = null;
    const overlay = document.getElementById('canvas-overlay-msg');
    if (overlay) overlay.classList.remove('hidden');
    requestRedraw();
  }

  function updateImageInfo() {
    const el = document.getElementById('status-image-info');
    const sep = document.getElementById('status-sep');
    if (!el) return;
    if (_image && _imageMeta) {
      el.textContent = `${_imageMeta.name || ''} — ${_image.naturalWidth}×${_image.naturalHeight}px`;
      if (sep) sep.style.display = '';
    } else {
      el.textContent = '';
      if (sep) sep.style.display = 'none';
    }
  }

  // ─── Tags management ───────────────────────────────────────────────────────

  function setTags(tags, persons) {
    // Dodaj referencu na osobu za brz pristup
    const personMap = {};
    (persons || []).forEach(p => { personMap[p.id] = p; });
    _tags = tags.map(t => ({ ...t, _person: personMap[t.person_id] || null }));
    _selectedTagId = null;
    requestRedraw();
  }

  function addOrUpdateTag(tag, person) {
    const existing = _tags.findIndex(t => t.id === tag.id);
    const enriched = { ...tag, _person: person };
    if (existing > -1) _tags[existing] = enriched;
    else _tags.push(enriched);
    requestRedraw();
  }

  function removeTag(tagId) {
    _tags = _tags.filter(t => t.id !== tagId);
    if (_selectedTagId === tagId) _selectedTagId = null;
    requestRedraw();
  }

  function selectTag(tagId) {
    _selectedTagId = tagId;
    requestRedraw();
    if (_onTagSelected) _onTagSelected(tagId);
  }

  function setHoveredTagId(tagId) {
    _hoveredTagId = tagId;
    requestRedraw();
  }

  function zoomToTag(tagId) {
    if (!_image || !canvas) return;
    const tag = _tags.find(t => t.id === tagId);
    if (!tag) return;

    const tagImgW = (tag.width / 100) * _image.naturalWidth;
    const tagImgH = (tag.height / 100) * _image.naturalHeight;
    const tagCenterX = (tag.x + tag.width / 2) / 100 * _image.naturalWidth;
    const tagCenterY = (tag.y + tag.height / 2) / 100 * _image.naturalHeight;

    const dpr = window.devicePixelRatio || 1;
    const cw = canvas.width / dpr;
    const ch = canvas.height / dpr;

    const targetScaleW = (cw * 0.4) / tagImgW;
    const targetScaleH = (ch * 0.4) / tagImgH;
    const targetScale = Math.max(_minScale, Math.min(_maxScale, Math.min(targetScaleW, targetScaleH)));

    _scale = targetScale;
    _offsetX = cw / 2 - tagCenterX * _scale;
    _offsetY = ch / 2 - tagCenterY * _scale;

    selectTag(tagId);
    requestRedraw();
  }

  function getSelectedTagId() { return _selectedTagId; }

  // ─── Mode ──────────────────────────────────────────────────────────────────

  function setMode(mode) {
    _mode = mode; // 'pan' | 'draw'
    wrapper.className = 'canvas-wrapper mode-' + mode;
    const panBtn = document.getElementById('mode-pan');
    const drawBtn = document.getElementById('mode-draw');
    if (panBtn) panBtn.classList.toggle('active', mode === 'pan');
    if (drawBtn) drawBtn.classList.toggle('active', mode === 'draw');
  }

  function getMode() { return _mode; }

  // ─── Crop portreta ─────────────────────────────────────────────────────────

  /**
   * Izrezuje dio slike prema tag koordinatama (u postotcima).
   * @param {Object} tag – tag s x, y, width, height u postotcima
   * @param {number} quality – JPEG kvaliteta (0-1)
   * @returns {Promise<Blob>} – JPEG blob portreta
   */
  async function cropPortrait(tag) {
    if (!_imageFileId) throw new Error('Nema učitane slike s diska (potreban Drive ID).');
    const mimeType = _imageMeta?.mimeType || 'image/jpeg';
    
    // Server-side crop for perfect quality and TIFF support
    const res = await fetch(`/api/drive/file/${_imageFileId}/crop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        x: tag.x,
        y: tag.y,
        width: tag.width,
        height: tag.height,
        mimeType
      })
    });
    
    if (!res.ok) throw new Error('Izrezivanje na serveru neuspješno.');
    return await res.blob();
  }

  /**
   * Snima čistu kopiju slike (bez okvira) kao Blob.
   * @returns {Promise<Blob>}
   */
  async function exportCleanImage() {
    if (!_imageFileId) throw new Error('Nema učitane slike s diska (potreban Drive ID).');
    // Preuzmi original bez konverzije direktno sa servera
    const res = await fetch(`/api/drive/file/${_imageFileId}/download?convert=false`);
    if (!res.ok) throw new Error('Export originalne slike neuspješan.');
    return await res.blob();
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  function createNewTagBox(cxPct, cyPct) {
    // 300 DPI za 35mm sirine iznosi cca 413 px. (35 / 25.4 * 300 = 413.3)
    const targetWidthPx = 413;
    let tagW = (targetWidthPx / _image.naturalWidth) * 100;
    
    // Zadrzi izmedu 2% i 50% slike da ne bude premalo ni preveliko ako je slika ekstremno velika/mala
    if (tagW < 2) tagW = 2;
    if (tagW > 50) tagW = 50;

    let tagH = tagW / (3.5 / 4.5) * (_image.naturalWidth / _image.naturalHeight);
    if (tagH > 100) { tagH = 100; tagW = tagH * (3.5 / 4.5) * (_image.naturalHeight / _image.naturalWidth); }

    let tagX = cxPct - tagW / 2;
    let tagY = cyPct - tagH / 2;
    
    tagX = Math.max(0, Math.min(100 - tagW, tagX));
    tagY = Math.max(0, Math.min(100 - tagH, tagY));

    // Sprjecavanje preklapanja okvira
    let attempts = 0;
    while (attempts < 20) {
      const isOverlapping = _tags.some(t => {
        // Dodajemo i mali razmak (padding) od 1% prilikom provjere
        return !(tagX + tagW + 1 < t.x || tagX - 1 > t.x + t.width || tagY + tagH + 1 < t.y || tagY - 1 > t.y + t.height);
      });
      if (!isOverlapping) break;
      
      tagX += 3;
      tagY += 3;
      
      if (tagX + tagW > 100 || tagY + tagH > 100) {
         // Ako izadje van, probaj na random lokaciji
         tagX = Math.random() * (100 - tagW);
         tagY = Math.random() * (100 - tagH);
      }
      attempts++;
    }

    if (_onTagDrawn) _onTagDrawn({ x: tagX, y: tagY, width: tagW, height: tagH });
  }

  function createNewTagBoxInCenter() {
    if (!_image || _readOnly) return;
    const dpr = window.devicePixelRatio || 1;
    const cw = canvas.width / dpr;
    const ch = canvas.height / dpr;
    
    const { x: px, y: py } = canvasToPercent(cw / 2, ch / 2);
    
    if (px >= 0 && px <= 100 && py >= 0 && py <= 100) {
      createNewTagBox(px, py);
    } else {
      createNewTagBox(50, 50);
    }
  }

  function drawPreview(tag, previewCanvas) {
    if (!_image || !previewCanvas) return;
    const ctx = previewCanvas.getContext('2d');
    
    const x = (tag.x / 100) * _image.naturalWidth;
    const y = (tag.y / 100) * _image.naturalHeight;
    const w = (tag.width / 100) * _image.naturalWidth;
    const h = (tag.height / 100) * _image.naturalHeight;
    
    const cx = Math.max(0, Math.round(x));
    const cy = Math.max(0, Math.round(y));
    const cw = Math.min(Math.round(w), _image.naturalWidth - cx);
    const ch = Math.min(Math.round(h), _image.naturalHeight - cy);

    ctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
    if (cw > 0 && ch > 0) {
      const cropAspect = cw / ch;
      const canvasAspect = previewCanvas.width / previewCanvas.height;
      let destW, destH, destX, destY;
      if (cropAspect > canvasAspect) {
        destW = previewCanvas.width;
        destH = destW / cropAspect;
        destX = 0;
        destY = (previewCanvas.height - destH) / 2;
      } else {
        destH = previewCanvas.height;
        destW = destH * cropAspect;
        destX = (previewCanvas.width - destW) / 2;
        destY = 0;
      }
      ctx.drawImage(_image, cx, cy, cw, ch, destX, destY, destW, destH);
    }
  }

  function hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  // ─── Init ──────────────────────────────────────────────────────────────────

  function init(canvasId, wrapperId) {
    canvas = document.getElementById(canvasId);
    wrapper = document.getElementById(wrapperId);
    if (!canvas || !wrapper) return;
    ctx = canvas.getContext('2d');

    resizeCanvas();
    new ResizeObserver(resizeCanvas).observe(wrapper);

    // Mouse events
    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('mouseleave', onMouseLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', onContextMenu);

    // Touch events
    canvas.addEventListener('touchstart', onTouchStart, { passive: false });
    canvas.addEventListener('touchmove', onTouchMove, { passive: false });
    canvas.addEventListener('touchend', onTouchEnd, { passive: false });

    // Keyboard (na canvas elementu)
    document.addEventListener('keydown', handleKeydown);
    document.addEventListener('keyup', handleKeyup);

    // Zoom buttons
    document.getElementById('btn-zoom-in')?.addEventListener('click', () => zoomIn());
    document.getElementById('btn-zoom-out')?.addEventListener('click', () => zoomOut());
    document.getElementById('btn-zoom-fit')?.addEventListener('click', fitToScreen);

    // Mode buttons
    document.getElementById('mode-pan')?.addEventListener('click', () => setMode('pan'));
    document.getElementById('mode-draw')?.addEventListener('click', () => setMode('draw'));

    setMode('pan');
    render();
  }

  // ─── Public API ───────────────────────────────────────────────────────────
  return {
    init,
    loadImageFromUrl, clearImage,
    fitToScreen, zoomIn, zoomOut, setZoom,
    setMode, getMode,
    setTags, addOrUpdateTag, removeTag, selectTag, getSelectedTagId, zoomToTag, setHoveredTagId,
    cropPortrait, exportCleanImage,
    createNewTagBoxInCenter,
    loadImageProgressive,
    get currentFileId() { return _imageFileId; },
    get currentMeta() { return _imageMeta; },
    get hasImage() { return !!_image; },
    set onTagDrawn(fn) { _onTagDrawn = fn; },
    set onTagSelected(fn) { _onTagSelected = fn; },
    set onTagDrag(fn) { _onTagDrag = fn; },
    set onTagChanged(fn) { _onTagChanged = fn; },
    set onCursorPos(fn) { _onCursorPos = fn; },
    set showLabels(v) { _showLabels = v; requestRedraw(); },
    setReadOnly(ro) { _readOnly = !!ro; if (_readOnly) setMode('pan'); },
    get isReadOnly() { return _readOnly; },
    drawPreview,
    getTagColor, TAG_COLORS
  };
})();
