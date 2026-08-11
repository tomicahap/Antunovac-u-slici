/**
 * Google Drive API proxy rute.
 * Sve operacije na Drive-u prolaze kroz ovaj backend –
 * access tokeni i tajni ključevi NIKAD ne odlaze na frontend.
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const { getDriveClient, getAuthenticatedClient } = require('../utils/driveClient');
const { isTiff, tiffToJpeg } = require('../utils/tiffConverter');

// Multer za upload u memoriji (ne na disk)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 } // 50 MB
});

// Podržani MIME tipovi slika
const IMAGE_MIME_TYPES = [
  'image/jpeg', 'image/png', 'image/tiff', 'image/tif',
  'image/x-tiff', 'image/webp'
];

// ─── Middleware: provjera autentifikacije ────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session || !req.session.encryptedRefreshToken) {
    return res.status(401).json({ error: 'Niste prijavljeni. Povežite Google Drive.' });
  }
  next();
}

router.use(requireAuth);

// ─── GET /api/drive/folders ──────────────────────────────────────────────────
// Popis podmapa zadane mape (ili My Drive root)
router.get('/folders', async (req, res) => {
  try {
    const { parentId = 'root', pageToken } = req.query;
    const drive = await getDriveClient(req.session);

    const params = {
      q: `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'nextPageToken, files(id, name, modifiedTime)',
      orderBy: 'name',
      pageSize: 100
    };
    if (pageToken) params.pageToken = pageToken;

    const response = await drive.files.list(params);
    res.json({
      folders: response.data.files || [],
      nextPageToken: response.data.nextPageToken || null
    });
  } catch (err) {
    console.error('[Drive] Greška pri dohvatu mapa:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ─── POST /api/drive/file/:id/copy ───────────────────────────────────────────
// Kopiranje slike u drugi folder sa novim imenom
router.post('/file/:id/copy', express.json(), async (req, res) => {
  try {
    const originalDriveId = req.params.id;
    const { outputFolderId, newFilename } = req.body;
    if (!outputFolderId) return res.status(400).json({ error: 'Nedostaje outputFolderId.' });
    if (!newFilename) return res.status(400).json({ error: 'Nedostaje newFilename.' });

    const drive = await getDriveClient(req.session);
    const response = await drive.files.copy({
      fileId: originalDriveId,
      requestBody: {
        name: newFilename,
        parents: [outputFolderId]
      },
      fields: 'id, name, webViewLink, thumbnailLink'
    });

    res.json({ success: true, file: response.data });
  } catch (err) {
    console.error('[Drive] Greška pri kopiranju datoteke:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ─── GET /api/drive/files ────────────────────────────────────────────────────
// Popis slika u zadanoj mapi
router.get('/files', async (req, res) => {
  try {
    const { folderId = 'root', pageToken, pageSize = 50 } = req.query;
    const drive = await getDriveClient(req.session);

    const mimeQuery = IMAGE_MIME_TYPES.map(m => `mimeType = '${m}'`).join(' or ');
    const params = {
      q: `'${folderId}' in parents and (${mimeQuery}) and trashed = false`,
      fields: 'nextPageToken, files(id, name, size, mimeType, modifiedTime, imageMediaMetadata, thumbnailLink)',
      orderBy: 'name',
      pageSize: parseInt(pageSize)
    };
    if (pageToken) params.pageToken = pageToken;

    const response = await drive.files.list(params);
    res.json({
      files: response.data.files || [],
      nextPageToken: response.data.nextPageToken || null
    });
  } catch (err) {
    console.error('[Drive] Greška pri dohvatu datoteka:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ─── GET /api/drive/file/:id/metadata ───────────────────────────────────────
// Metapodaci pojedine datoteke
router.get('/file/:id/metadata', async (req, res) => {
  try {
    const drive = await getDriveClient(req.session);
    const response = await drive.files.get({
      fileId: req.params.id,
      fields: 'id, name, size, mimeType, modifiedTime, imageMediaMetadata, parents'
    });
    res.json(response.data);
  } catch (err) {
    console.error('[Drive] Greška pri dohvatu metapodataka:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ─── GET /api/drive/file/:id/download ───────────────────────────────────────
// Preuzimanje/proxy sadržaja datoteke
// Za TIFF datoteke: automatska konverzija u JPEG
router.get('/file/:id/download', async (req, res) => {
  try {
    const drive = await getDriveClient(req.session);
    const { id } = req.params;
    const { convert = 'true' } = req.query; // convert=false za preuzimanje originala

    // Dohvati metapodatke
    const metaResponse = await drive.files.get({
      fileId: id,
      fields: 'id, name, mimeType, size'
    });
    const fileMeta = metaResponse.data;

    // Preuzmi sadržaj
    const fileResponse = await drive.files.get(
      { fileId: id, alt: 'media' },
      { responseType: 'stream' }
    );

    const shouldConvert = convert !== 'false' && isTiff(fileMeta.name, fileMeta.mimeType);

    if (shouldConvert) {
      // Skupi stream u buffer, konvertiraj TIFF → JPEG
      const chunks = [];
      fileResponse.data.on('data', chunk => chunks.push(chunk));
      fileResponse.data.on('end', async () => {
        try {
          const tiffBuffer = Buffer.concat(chunks);
          const { buffer: jpegBuffer } = await tiffToJpeg(tiffBuffer);
          
          res.set({
            'Content-Type': 'image/jpeg',
            'Content-Length': jpegBuffer.length,
            'Cache-Control': 'private, max-age=3600',
            'X-Original-Format': 'tiff',
            'X-Original-Filename': fileMeta.name
          });
          res.send(jpegBuffer);
        } catch (convErr) {
          console.error('[Drive] TIFF konverzija neuspješna:', convErr.message);
          res.status(500).json({ error: 'TIFF konverzija neuspješna: ' + convErr.message });
        }
      });
      fileResponse.data.on('error', err => {
        console.error('[Drive] Stream greška:', err.message);
        res.status(500).json({ error: 'Greška pri preuzimanju datoteke.' });
      });
    } else {
      // Direktni proxy streama
      res.set({
        'Content-Type': fileMeta.mimeType || 'application/octet-stream',
        'Cache-Control': 'private, max-age=3600',
        'X-Original-Filename': fileMeta.name
      });
      fileResponse.data.pipe(res);
    }
  } catch (err) {
    console.error('[Drive] Greška pri preuzimanju:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ─── GET /api/drive/file/:id/thumbnail ──────────────────────────────────────
// Thumbnail slike za galerijski prikaz (manja verzija)
router.get('/file/:id/thumbnail', async (req, res) => {
  try {
    const drive = await getDriveClient(req.session);
    const { id } = req.params;
    const { size = 200 } = req.query;

    const metaResponse = await drive.files.get({
      fileId: id,
      fields: 'id, name, mimeType, thumbnailLink'
    });
    const fileMeta = metaResponse.data;

    if (fileMeta.thumbnailLink) {
      const targetSize = parseInt(size, 10);
      // Google-ovi linkovi imaju sufiks npr. =s220 ili =s220-c. Zamjenjujemo to sa ciljanom veličinom.
      const thumbUrl = fileMeta.thumbnailLink.replace(/=s\d+(?:-c)?$/, `=s${targetSize}`);
      
      const auth = await getAuthenticatedClient(req.session);
      const response = await auth.request({
        url: thumbUrl,
        responseType: 'stream'
      });

      res.set({
        'Content-Type': 'image/jpeg', // Google thumbnaili su uvijek JPEG
        'Cache-Control': 'private, max-age=86400',
        'X-Original-Filename': fileMeta.name
      });
      response.data.pipe(res);
    } else {
      // Ako nema pre-generiranog thumbnail-a, preuzmi original i pošalji ga
      const fileResponse = await drive.files.get(
        { fileId: id, alt: 'media' },
        { responseType: 'stream' }
      );
      res.set({
        'Content-Type': fileMeta.mimeType || 'application/octet-stream',
        'Cache-Control': 'private, max-age=86400',
        'X-Original-Filename': fileMeta.name
      });
      fileResponse.data.pipe(res);
    }
  } catch (err) {
    console.error('[Drive] Greška pri dohvatu thumbnailа:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ─── POST /api/drive/file/:id/crop ──────────────────────────────────────
// Izrezivanje (crop) originalne slike na serveru (čuva TIFF kvalitetu)
router.post('/file/:id/crop', express.json(), async (req, res) => {
  try {
    const drive = await getDriveClient(req.session);
    const { id } = req.params;
    const { x, y, width, height } = req.body;

    // Dohvati metapodatke o datoteci radi točnog formata (mimeType)
    const fileMetadata = await drive.files.get({
      fileId: id,
      fields: 'name, mimeType'
    });
    const originalMimeType = fileMetadata.data.mimeType || 'image/jpeg';
    console.log(`[Crop] Datoteka: ${fileMetadata.data.name}, originalni MIME tip: ${originalMimeType}`);

    const fileResponse = await drive.files.get(
      { fileId: id, alt: 'media' },
      { responseType: 'stream' }
    );

    const chunks = [];
    fileResponse.data.on('data', chunk => chunks.push(chunk));
    fileResponse.data.on('end', async () => {
      try {
        const buffer = Buffer.concat(chunks);
        let sharp;
        try { sharp = require('sharp'); } catch(e) { throw new Error('Sharp nije instaliran.'); }
        
        // Bake orientation before cropping to align coordinate system
        const rotatedBuffer = await sharp(buffer).rotate().toBuffer();
        const img = sharp(rotatedBuffer);
        const meta = await img.metadata();
        
        console.log(`[Crop] Originalna veličina slike: ${meta.width}x${meta.height}, format: ${meta.format}`);
        
        const px = Math.round((x / 100) * meta.width);
        const py = Math.round((y / 100) * meta.height);
        const pw = Math.round((width / 100) * meta.width);
        const ph = Math.round((height / 100) * meta.height);
        
        const cropX = Math.max(0, px);
        const cropY = Math.max(0, py);
        const cropW = Math.max(1, Math.min(pw, meta.width - cropX));
        const cropH = Math.max(1, Math.min(ph, meta.height - cropY));

        console.log(`[Crop] Izrezivanje regije: left=${cropX}, top=${cropY}, width=${cropW}, height=${cropH}`);

        let processed = img.extract({ left: cropX, top: cropY, width: cropW, height: cropH });

        if (originalMimeType && (originalMimeType.includes('tiff') || originalMimeType.includes('tif'))) {
          processed = processed.tiff({
            compression: 'none',
            quality: 100,
            xres: 300,
            yres: 300
          });
        } else if (originalMimeType && originalMimeType.includes('png')) {
          processed = processed.png({
            compressionLevel: 0,
            xres: 300,
            yres: 300
          });
        } else if (originalMimeType && originalMimeType.includes('webp')) {
          processed = processed.webp({
            quality: 100,
            lossless: true
          });
        } else {
          processed = processed.jpeg({
            quality: 100,
            chromaSubsampling: '4:4:4',
            xres: 300,
            yres: 300
          });
        }

        const outBuffer = await processed.toBuffer();
        console.log(`[Crop] Izrezano uspješno, veličina izlaznog međuspremnika: ${outBuffer.length} bajtova`);

        res.set({
          'Content-Type': originalMimeType,
          'Content-Length': outBuffer.length
        });
        res.send(outBuffer);
      } catch (err) {
        console.error('[Drive] Greška pri izrezivanju:', err);
        res.status(500).json({ error: 'Greška pri izrezivanju: ' + err.message });
      }
    });
    fileResponse.data.on('error', err => {
      res.status(500).json({ error: 'Greška pri preuzimanju za crop.' });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/drive/file/:id/crop-and-upload ────────────────────────────
// Izrezivanje i izravan prijenos na Google Drive s poslužitelja (bez slanja klijentu)
router.post('/file/:id/crop-and-upload', express.json(), async (req, res) => {
  try {
    const drive = await getDriveClient(req.session);
    const { id } = req.params;
    const { x, y, width, height, folderId, filename, existingFileId } = req.body;

    if (!folderId || !filename) {
      return res.status(400).json({ error: 'Nedostaje folderId ili filename.' });
    }

    // 1. Dohvati metapodatke o datoteci radi točnog formata (mimeType)
    const fileMetadata = await drive.files.get({
      fileId: id,
      fields: 'name, mimeType'
    });
    const originalMimeType = fileMetadata.data.mimeType || 'image/jpeg';
    console.log(`[CropAndUpload] Datoteka: ${fileMetadata.data.name}, originalni MIME tip: ${originalMimeType}`);

    // 2. Preuzmi medijski sadržaj
    const fileResponse = await drive.files.get(
      { fileId: id, alt: 'media' },
      { responseType: 'stream' }
    );

    const chunks = [];
    fileResponse.data.on('data', chunk => chunks.push(chunk));
    fileResponse.data.on('end', async () => {
      try {
        const buffer = Buffer.concat(chunks);
        let sharp;
        try { sharp = require('sharp'); } catch(e) { throw new Error('Sharp nije instaliran.'); }
        
        // Bake orientation before cropping to align coordinate system
        const rotatedBuffer = await sharp(buffer).rotate().toBuffer();
        const img = sharp(rotatedBuffer);
        const meta = await img.metadata();
        
        console.log(`[CropAndUpload] Originalna veličina: ${meta.width}x${meta.height}, format: ${meta.format}`);
        
        const px = Math.round((x / 100) * meta.width);
        const py = Math.round((y / 100) * meta.height);
        const pw = Math.round((width / 100) * meta.width);
        const ph = Math.round((height / 100) * meta.height);
        
        const cropX = Math.max(0, px);
        const cropY = Math.max(0, py);
        const cropW = Math.max(1, Math.min(pw, meta.width - cropX));
        const cropH = Math.max(1, Math.min(ph, meta.height - cropY));

        console.log(`[CropAndUpload] Rezanje: left=${cropX}, top=${cropY}, width=${cropW}, height=${cropH}`);

        let processed = img.extract({ left: cropX, top: cropY, width: cropW, height: cropH });

        if (originalMimeType && (originalMimeType.includes('tiff') || originalMimeType.includes('tif'))) {
          processed = processed.tiff({
            compression: 'none',
            quality: 100,
            xres: 300,
            yres: 300
          });
        } else if (originalMimeType && originalMimeType.includes('png')) {
          processed = processed.png({
            compressionLevel: 0,
            xres: 300,
            yres: 300
          });
        } else if (originalMimeType && originalMimeType.includes('webp')) {
          processed = processed.webp({
            quality: 100,
            lossless: true
          });
        } else {
          processed = processed.jpeg({
            quality: 100,
            chromaSubsampling: '4:4:4',
            xres: 300,
            yres: 300
          });
        }

        const outBuffer = await processed.toBuffer();
        console.log(`[CropAndUpload] Rezanje uspješno. Veličina buffera: ${outBuffer.length} bajtova.`);

        // 3. Prenesi novonastalu sliku izravno na Google Drive
        const { Readable } = require('stream');
        const uploadStream = Readable.from(outBuffer);

        let response;
        if (existingFileId) {
          // Prepiši postojeći portret
          console.log(`[CropAndUpload] Ažuriranje postojećeg portreta: ${existingFileId}`);
          response = await drive.files.update({
            fileId: existingFileId,
            media: {
              mimeType: originalMimeType,
              body: uploadStream
            },
            fields: 'id, name, webViewLink'
          });
        } else {
          // Riješi konflikt naziva i kreiraj novu datoteku
          const finalFilename = await resolveFilenameConflict(drive, folderId, filename);
          console.log(`[CropAndUpload] Kreiranje novog portreta: ${finalFilename} u mapi: ${folderId}`);
          response = await drive.files.create({
            requestBody: {
              name: finalFilename,
              parents: [folderId]
            },
            media: {
              mimeType: originalMimeType,
              body: uploadStream
            },
            fields: 'id, name, webViewLink'
          });
        }

        res.json({
          success: true,
          fileId: response.data.id,
          filename: response.data.name,
          webViewLink: response.data.webViewLink
        });
      } catch (err) {
        console.error('[CropAndUpload] Greška pri obradi/prijenosu:', err);
        res.status(500).json({ error: 'Greška pri obradi/prijenosu: ' + err.message });
      }
    });
    fileResponse.data.on('error', err => {
      res.status(500).json({ error: 'Greška pri preuzimanju originala.' });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/drive/upload ──────────────────────────────────────────────────
// Upload datoteke u Google Drive mapu
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    const { folderId, filename, mimeType = 'image/jpeg', fileId } = req.body;

    if (!req.file && !req.body.base64data) {
      return res.status(400).json({ error: 'Nedostaje datoteka za upload.' });
    }
    if (!folderId) {
      return res.status(400).json({ error: 'Nedostaje folderId.' });
    }

    const drive = await getDriveClient(req.session);

    // Provjera konflikta naziva datoteke (samo kod kreiranja)
    let finalFilename = filename || req.file?.originalname || 'upload.jpg';
    if (!fileId) {
      finalFilename = await resolveFilenameConflict(drive, folderId, finalFilename);
    }

    // Pripremi sadržaj
    let fileBuffer;
    if (req.file) {
      fileBuffer = req.file.buffer;
    } else if (req.body.base64data) {
      const base64 = req.body.base64data.replace(/^data:[^;]+;base64,/, '');
      fileBuffer = Buffer.from(base64, 'base64');
    }

    const { Readable } = require('stream');
    const stream = Readable.from(fileBuffer);

    let response;
    if (fileId) {
      // Overwrite / update postojecu datoteku
      response = await drive.files.update({
        fileId: fileId,
        requestBody: {
          name: finalFilename
        },
        media: {
          mimeType: mimeType,
          body: stream
        },
        fields: 'id, name, webViewLink'
      });
    } else {
      // Kreiraj novu datoteku
      response = await drive.files.create({
        requestBody: {
          name: finalFilename,
          parents: [folderId]
        },
        media: {
          mimeType: mimeType,
          body: stream
        },
        fields: 'id, name, webViewLink'
      });
    }

    res.json({
      success: true,
      fileId: response.data.id,
      filename: response.data.name,
      webViewLink: response.data.webViewLink
    });
  } catch (err) {
    console.error('[Drive] Upload greška:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Izbriši datoteku iz Google Drivea
router.delete('/file/:id', async (req, res) => {
  try {
    const drive = await getDriveClient(req.session);
    const { id } = req.params;
    await drive.files.delete({ fileId: id });
    res.json({ success: true });
  } catch (err) {
    console.error('[Drive] Greška pri brisanju datoteke:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/drive/folder ──────────────────────────────────────────────────
// Kreiranje podmape u Google Drive-u
router.post('/folder', async (req, res) => {
  try {
    const { parentId, name } = req.body;
    if (!parentId || !name) {
      return res.status(400).json({ error: 'Nedostaje parentId ili name.' });
    }

    const drive = await getDriveClient(req.session);

    // Provjera postoji li mapa već
    const existing = await drive.files.list({
      q: `'${parentId}' in parents and name = '${name.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id, name)',
      pageSize: 1
    });

    if (existing.data.files && existing.data.files.length > 0) {
      return res.json({
        success: true,
        folderId: existing.data.files[0].id,
        name: existing.data.files[0].name,
        existing: true
      });
    }

    const response = await drive.files.create({
      requestBody: {
        name: name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentId]
      },
      fields: 'id, name'
    });

    res.json({
      success: true,
      folderId: response.data.id,
      name: response.data.name,
      existing: false
    });
  } catch (err) {
    console.error('[Drive] Greška pri kreiranju mape:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ─── GET /api/drive/resolve ──────────────────────────────────────────────────
// Parsiranje Google Drive URL-a → file ID ili folder ID
router.get('/resolve', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) {
      return res.status(400).json({ error: 'Nedostaje URL parametar.' });
    }

    const result = parseDriveUrl(url.trim());
    if (!result) {
      return res.status(400).json({ error: 'Nije moguće parsirati Drive URL ili ID.' });
    }

    // Dohvati metapodatke da potvrdimo ispravnost ID-a
    try {
      const drive = await getDriveClient(req.session);
      const meta = await drive.files.get({
        fileId: result.id,
        fields: 'id, name, mimeType'
      });
      res.json({
        id: result.id,
        type: result.type,
        name: meta.data.name,
        mimeType: meta.data.mimeType
      });
    } catch {
      // Vratimo samo ID bez validacije
      res.json({ id: result.id, type: result.type, name: null });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/drive/check-name ───────────────────────────────────────────────
// Provjera dostupnosti naziva datoteke u mapi
router.get('/check-name', async (req, res) => {
  try {
    const { folderId, filename } = req.query;
    if (!folderId || !filename) {
      return res.status(400).json({ error: 'Nedostaje folderId ili filename.' });
    }
    const drive = await getDriveClient(req.session);
    const finalName = await resolveFilenameConflict(drive, folderId, filename);
    res.json({ available: finalName === filename, suggestedName: finalName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Pomoćne funkcije ────────────────────────────────────────────────────────

/**
 * Parsiranje Google Drive URL-a u ID i tip (file/folder).
 */
function parseDriveUrl(input) {
  // Uobičajeni Drive URL formati
  const patterns = [
    // Mapa: https://drive.google.com/drive/folders/{id}
    { regex: /drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\/([a-zA-Z0-9_-]+)/, type: 'folder' },
    // Datoteka: https://drive.google.com/file/d/{id}/view
    { regex: /drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/, type: 'file' },
    // Dijeljeni link: https://drive.google.com/open?id={id}
    { regex: /drive\.google\.com\/open\?id=([a-zA-Z0-9_-]+)/, type: 'unknown' },
    // Docs: https://docs.google.com/spreadsheets/d/{id}
    { regex: /docs\.google\.com\/[^/]+\/d\/([a-zA-Z0-9_-]+)/, type: 'file' },
    // Goli ID (25-33 alfanumerička znaka/crtica/podvlaka)
    { regex: /^([a-zA-Z0-9_-]{25,44})$/, type: 'unknown' }
  ];

  for (const pattern of patterns) {
    const match = input.match(pattern.regex);
    if (match) {
      return { id: match[1], type: pattern.type };
    }
  }
  return null;
}

/**
 * Rješava konflikt naziva datoteke dodavanjem sufiksa (_2, _3, ...).
 * Ne pita korisnika, ne prepisuje postojeće datoteke.
 */
async function resolveFilenameConflict(drive, folderId, desiredFilename) {
  const lastDot = desiredFilename.lastIndexOf('.');
  const nameWithoutExt = lastDot > 0 ? desiredFilename.slice(0, lastDot) : desiredFilename;
  const ext = lastDot > 0 ? desiredFilename.slice(lastDot) : '';

  // Pretraži sve datoteke s istim baznim imenom u mapi
  const safeName = nameWithoutExt.replace(/'/g, "\\'");
  const response = await drive.files.list({
    q: `'${folderId}' in parents and name contains '${safeName}' and trashed = false`,
    fields: 'files(name)',
    pageSize: 100
  });

  const existingNames = new Set((response.data.files || []).map(f => f.name));

  if (!existingNames.has(desiredFilename)) {
    return desiredFilename;
  }

  // Dodaj sufiks dok ne nađemo slobodan naziv
  for (let i = 2; i <= 999; i++) {
    const candidate = `${nameWithoutExt}_${i}${ext}`;
    if (!existingNames.has(candidate)) {
      return candidate;
    }
  }

  // Fallback: dodaj timestamp
  return `${nameWithoutExt}_${Date.now()}${ext}`;
}

const fs = require('fs');
const path = require('path');
const dbFile = path.join(__dirname, '..', 'data', 'db.json');

// Pokretanje pozadinskog preuzimanja baze s Google Drive-a na startu poslužitelja ako lokalna datoteka ne postoji
setTimeout(async () => {
  if (!fs.existsSync(dbFile)) {
    try {
      const { getDriveClient } = require('../utils/driveClient');
      const drive = await getDriveClient(null);
      
      console.log('[Startup] Pokušaj preuzimanja baze antunovac_db.json s Google Drive-a...');
      const filesResponse = await drive.files.list({
        q: "name = 'antunovac_db.json' and trashed = false",
        fields: 'files(id, name)',
        pageSize: 1
      });

      const files = filesResponse.data.files || [];
      if (files.length > 0) {
        const fileId = files[0].id;
        const downloadResponse = await drive.files.get(
          { fileId, alt: 'media' },
          { responseType: 'text' }
        );
        
        let dbData = downloadResponse.data;
        if (typeof dbData === 'string') {
          try { dbData = JSON.parse(dbData); } catch {}
        }
        
        const dataDir = path.dirname(dbFile);
        if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(dbFile, JSON.stringify(dbData, null, 2));
        console.log('[Startup] Uspješno preuzeta i pohranjena zajednička baza s Google Drive-a.');
      } else {
        console.log('[Startup] Nije pronađena postojeća baza antunovac_db.json na Google Drive-u.');
      }
    } catch (err) {
      console.warn('[Startup] Nije moguće preuzeti bazu s Google Drive-a (vjerojatno još nema spojenog računa ili varijabli):', err.message);
    }
  }
}, 5000);

// ─── GET /api/drive/db/load ──────────────────────────────────────────────────
// Učitava bazu podataka s Google Drive-a ili iz lokalnog cache-a
router.get('/db/load', async (req, res) => {
  try {
    // 1. Ako postoji lokalni cache, vrati ga odmah
    if (fs.existsSync(dbFile)) {
      const data = fs.readFileSync(dbFile, 'utf8');
      return res.json(JSON.parse(data));
    }

    // 2. Ako ne postoji lokalni cache, probaj skinuti s Google Drive-a
    let drive;
    try {
      drive = await getDriveClient(req.session);
    } catch {
      // Nema Google Drive sesije (korisnik je posjetitelj i još se nitko nije spojio)
      return res.json({ settings: {}, persons: [], tags: [], images: [], comments: [] });
    }

    // Pretraži Google Drive za naziv datoteke 'antunovac_db.json'
    const filesResponse = await drive.files.list({
      q: "name = 'antunovac_db.json' and trashed = false",
      fields: 'files(id, name)',
      pageSize: 1
    });

    const files = filesResponse.data.files || [];
    if (files.length > 0) {
      const fileId = files[0].id;
      const downloadResponse = await drive.files.get(
        { fileId, alt: 'media' },
        { responseType: 'text' }
      );
      
      let dbData = downloadResponse.data;
      if (typeof dbData === 'string') {
        try { dbData = JSON.parse(dbData); } catch {}
      }
      
      // Spremi lokalno
      const dataDir = path.dirname(dbFile);
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(dbFile, JSON.stringify(dbData, null, 2));

      return res.json(dbData);
    }

    // 3. Ako nigdje ne postoji, vrati praznu bazu
    res.json({ settings: {}, persons: [], tags: [], images: [], comments: [] });
  } catch (err) {
    console.error('[DB-Load] Greška:', err.message);
    res.json({ settings: {}, persons: [], tags: [], images: [], comments: [] });
  }
});

// ─── POST /api/drive/db/save ─────────────────────────────────────────────────
// Sprema bazu podataka lokalno i sinkronizira je na Google Drive u pozadini
router.post('/db/save', express.json({ limit: '10mb' }), async (req, res) => {
  try {
    const dbData = req.body;
    if (!dbData) return res.status(400).json({ error: 'Nedostaje sadržaj baze.' });

    // 1. Spremi lokalno na disk (brzi cache)
    const dataDir = path.dirname(dbFile);
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(dbFile, JSON.stringify(dbData, null, 2));

    // Odgovori klijentu odmah
    res.json({ success: true, message: 'Baza spremljena lokalno.' });

    // 2. Sinkroniziraj na Google Drive asinkrono u pozadini
    const outputFolderId = dbData.settings?.outputFolderId;
    if (!outputFolderId) return;

    (async () => {
      try {
        const drive = await getDriveClient(req.session);
        
        // Nađi postojeću antunovac_db.json u output mapi
        const searchResponse = await drive.files.list({
          q: `name = 'antunovac_db.json' and '${outputFolderId}' in parents and trashed = false`,
          fields: 'files(id, name)',
          pageSize: 1
        });

        const files = searchResponse.data.files || [];
        const { Readable } = require('stream');
        const stream = Readable.from(JSON.stringify(dbData, null, 2));

        if (files.length > 0) {
          // Ažuriraj postojeću
          await drive.files.update({
            fileId: files[0].id,
            media: {
              mimeType: 'application/json',
              body: stream
            }
          });
          console.log('[DB-Save] Baza antunovac_db.json uspješno ažurirana na Google Drive-u.');
        } else {
          // Kreiraj novu
          await drive.files.create({
            requestBody: {
              name: 'antunovac_db.json',
              parents: [outputFolderId]
            },
            media: {
              mimeType: 'application/json',
              body: stream
            }
          });
          console.log('[DB-Save] Nova baza antunovac_db.json uspješno kreirana na Google Drive-u.');
        }
      } catch (err) {
        console.error('[DB-Save-Background] Greška pri sinkronizaciji na Drive:', err.message);
      }
    })();

  } catch (err) {
    console.error('[DB-Save] Greška:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
