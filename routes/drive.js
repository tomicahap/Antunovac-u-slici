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
const firebaseDb = require('../utils/firebase');

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
// Kopiranje slike u drugi folder sa automatskim rednim brojem na temelju sadržaja mape
router.post('/file/:id/copy', express.json(), async (req, res) => {
  try {
    const originalDriveId = req.params.id;
    const { outputFolderId } = req.body;
    if (!outputFolderId) return res.status(400).json({ error: 'Nedostaje outputFolderId.' });

    const drive = await getDriveClient(req.session);

    // 1. Pretraži datoteke u mapi kako bismo izračunali zadnji redni broj
    let maxSeq = 0;
    try {
      const filesResponse = await drive.files.list({
        q: `'${outputFolderId}' in parents and name contains 'Antunovac-u-slici-' and trashed = false`,
        fields: 'files(name)',
        pageSize: 1000
      });
      const files = filesResponse.data.files || [];
      files.forEach(f => {
        const match = f.name.match(/Antunovac-u-slici-(\d+)/i);
        if (match) {
          const seq = parseInt(match[1], 10);
          if (seq > maxSeq) maxSeq = seq;
        }
      });
    } catch (e) {
      console.warn('[Drive] Nije moguće učitati redne brojeve za kopiranje:', e.message);
    }

    const nextSeq = maxSeq + 1;

    // 2. Saznaj format originalne datoteke
    const fileMetadata = await drive.files.get({
      fileId: originalDriveId,
      fields: 'name'
    });
    const originalName = fileMetadata.data.name || 'slika.jpg';
    const ext = originalName.split('.').pop() || 'jpg';
    const computedFilename = `Antunovac-u-slici-${String(nextSeq).padStart(4, '0')}.${ext}`;

    console.log(`[Drive] Kopiranje originala ${originalDriveId} kao ${computedFilename} (redni broj: ${nextSeq})`);

    // 3. Izvedi kopiranje
    const response = await drive.files.copy({
      fileId: originalDriveId,
      requestBody: {
        name: computedFilename,
        parents: [outputFolderId]
      },
      fields: 'id, name, webViewLink, thumbnailLink'
    });

    res.json({ success: true, file: response.data, sequence_no: nextSeq });
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
    const { x, y, width, height, folderId, filename, existingFileId, existingTisakFileId } = req.body;

    const tisakFolderId = req.body.portraitsTisakFolderId || process.env.PORTRAITS_TISAK_FOLDER_ID || folderId;
    const webFolderId = req.body.portraitsWebFolderId || process.env.PORTRAITS_WEB_FOLDER_ID || folderId;

    if (!tisakFolderId || !webFolderId || !filename) {
      return res.status(400).json({ error: 'Nedostaju identifikatori mapa ili naziv datoteke.' });
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

        // ─── A. TISAK VERZIJA (Originalna rezolucija) ───
        let processedTisak = img.extract({ left: cropX, top: cropY, width: cropW, height: cropH });

        if (originalMimeType.includes('tiff') || originalMimeType.includes('tif')) {
          processedTisak = processedTisak.tiff({ compression: 'none', quality: 100 });
        } else if (originalMimeType.includes('png')) {
          processedTisak = processedTisak.png({ compressionLevel: 0 });
        } else if (originalMimeType.includes('webp')) {
          processedTisak = processedTisak.webp({ quality: 100, lossless: true });
        } else {
          processedTisak = processedTisak.jpeg({ quality: 100, chromaSubsampling: '4:4:4' });
        }
        const tisakBuffer = await processedTisak.toBuffer();

        // ─── B. WEB VERZIJA (Maksimalno 800px, komprimirana) ───
        let webW = cropW;
        let webH = cropH;
        if (webW > 800 || webH > 800) {
          if (webW > webH) {
            webH = Math.round((800 / webW) * webH);
            webW = 800;
          } else {
            webW = Math.round((800 / webH) * webW);
            webH = 800;
          }
        }
        
        let processedWeb = sharp(rotatedBuffer)
          .extract({ left: cropX, top: cropY, width: cropW, height: cropH })
          .resize(webW, webH)
          .jpeg({ quality: 65, chromaSubsampling: '4:2:0' });
        const webBuffer = await processedWeb.toBuffer();

        console.log(`[CropAndUpload] Obrada završena. Tisak buffer: ${tisakBuffer.length} B, Web buffer: ${webBuffer.length} B.`);

        // ─── C. PRIJENOS NA GOOGLE DRIVE ───
        const { Readable } = require('stream');

        // 1. Upload TISAK verzije
        let tisakResponse;
        if (existingTisakFileId) {
          console.log(`[CropAndUpload] Ažuriranje postojećeg TISAK portreta: ${existingTisakFileId}`);
          tisakResponse = await drive.files.update({
            fileId: existingTisakFileId,
            media: {
              mimeType: originalMimeType,
              body: Readable.from(tisakBuffer)
            },
            fields: 'id, name, webViewLink'
          });
        } else {
          const finalFilenameTisak = await resolveFilenameConflict(drive, tisakFolderId, filename);
          console.log(`[CropAndUpload] Kreiranje novog TISAK portreta: ${finalFilenameTisak} u mapi: ${tisakFolderId}`);
          tisakResponse = await drive.files.create({
            requestBody: {
              name: finalFilenameTisak,
              parents: [tisakFolderId]
            },
            media: {
              mimeType: originalMimeType,
              body: Readable.from(tisakBuffer)
            },
            fields: 'id, name, webViewLink'
          });
        }

        // 2. Upload WEB verzije
        let webResponse;
        if (existingFileId) {
          console.log(`[CropAndUpload] Ažuriranje postojećeg WEB portreta: ${existingFileId}`);
          webResponse = await drive.files.update({
            fileId: existingFileId,
            media: {
              mimeType: 'image/jpeg',
              body: Readable.from(webBuffer)
            },
            fields: 'id, name, webViewLink'
          });
        } else {
          const finalFilenameWeb = await resolveFilenameConflict(drive, webFolderId, filename);
          console.log(`[CropAndUpload] Kreiranje novog WEB portreta: ${finalFilenameWeb} u mapi: ${webFolderId}`);
          webResponse = await drive.files.create({
            requestBody: {
              name: finalFilenameWeb,
              parents: [webFolderId]
            },
            media: {
              mimeType: 'image/jpeg',
              body: Readable.from(webBuffer)
            },
            fields: 'id, name, webViewLink'
          });
        }

        res.json({
          success: true,
          fileId: webResponse.data.id,
          filename: webResponse.data.name,
          webViewLink: webResponse.data.webViewLink,
          tisakFileId: tisakResponse.data.id,
          tisakWebViewLink: tisakResponse.data.webViewLink
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
// Učitava bazu podataka s Firebase Firestore ili iz lokalnog fallbacka
router.get('/db/load', async (req, res) => {
  try {
    const data = await firebaseDb.loadAll();
    res.json(data);
  } catch (err) {
    console.error('[DB-Load] Greška:', err.message);
    res.json({ settings: {}, persons: [], tags: [], images: [], comments: [] });
  }
});

// ─── POST /api/drive/db/save-item ────────────────────────────────────────────
// Granularno spremanje jedne stavke u Firestore
router.post('/db/save-item', express.json({ limit: '5mb' }), async (req, res) => {
  try {
    const { collection, id, data } = req.body;
    if (!collection || !id || !data) {
      return res.status(400).json({ error: 'Nedostaju collection, id ili data.' });
    }
    await firebaseDb.saveDoc(collection, id, data);
    res.json({ success: true });
  } catch (err) {
    console.error('[DB-SaveItem] Greška:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/drive/db/delete-item ──────────────────────────────────────────
// Granularno brisanje jedne stavke iz Firestorea
router.post('/db/delete-item', express.json(), async (req, res) => {
  try {
    const { collection, id } = req.body;
    if (!collection || !id) {
      return res.status(400).json({ error: 'Nedostaju collection ili id.' });
    }
    await firebaseDb.deleteDoc(collection, id);
    res.json({ success: true });
  } catch (err) {
    console.error('[DB-DeleteItem] Greška:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/drive/db/save ─────────────────────────────────────────────────
// Sprema cjelokupnu bazu (zadržano radi kompatibilnosti)
router.post('/db/save', express.json({ limit: '10mb' }), async (req, res) => {
  try {
    const dbData = req.body;
    if (!dbData) return res.status(400).json({ error: 'Nedostaje sadržaj baze.' });

    // Ako je Firestore omogućen, sinkroniziraj asinkrono u pozadini
    if (firebaseDb.isEnabled()) {
      (async () => {
        try {
          if (dbData.settings) await firebaseDb.saveDoc('settings', 'app_settings', dbData.settings);
          if (dbData.persons) {
            for (const p of dbData.persons) await firebaseDb.saveDoc('persons', p.id, p);
          }
          if (dbData.tags) {
            for (const t of dbData.tags) await firebaseDb.saveDoc('tags', t.id, t);
          }
          if (dbData.images) {
            for (const img of dbData.images) await firebaseDb.saveDoc('images', img.id, img);
          }
          if (dbData.comments) {
            for (const c of dbData.comments) await firebaseDb.saveDoc('comments', c.id, c);
          }
          console.log('[DB-Save] Cijela baza sinkronizirana u Firestore u pozadini.');
        } catch (e) {
          console.error('[DB-Save] Greška pri pozadinskom Firestore syncu:', e.message);
        }
      })();
    } else {
      firebaseDb.writeLocalDb(dbData);
    }
    res.json({ success: true, message: 'Baza sinkronizirana.' });
  } catch (err) {
    console.error('[DB-Save] Greška:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
