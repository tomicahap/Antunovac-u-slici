/**
 * TIFF konverzija u JPEG/PNG koristeći sharp library.
 * Koristi se na backendu za prikaz TIFF slika na frontend canvasu.
 * Originalne TIFF datoteke na Google Drive-u se nikad ne mijenjaju.
 */

let sharp;
try {
  sharp = require('sharp');
} catch (e) {
  console.warn('[TIFF] sharp nije dostupan. TIFF konverzija neće raditi.', e.message);
  sharp = null;
}

/**
 * Podržani TIFF MIME tipovi i ekstenzije
 */
const TIFF_MIME_TYPES = [
  'image/tiff',
  'image/tif',
  'image/x-tiff',
  'image/x-tif'
];

const TIFF_EXTENSIONS = ['.tiff', '.tif'];

/**
 * Provjera je li datoteka TIFF format.
 * @param {string} filename - Naziv datoteke
 * @param {string} mimeType - MIME tip (opcionalno)
 * @returns {boolean}
 */
function isTiff(filename, mimeType = '') {
  const ext = filename ? filename.toLowerCase().slice(filename.lastIndexOf('.')) : '';
  return TIFF_EXTENSIONS.includes(ext) || TIFF_MIME_TYPES.includes(mimeType.toLowerCase());
}

/**
 * Konvertira TIFF buffer u JPEG buffer.
 * @param {Buffer} tiffBuffer - TIFF datoteka kao Buffer
 * @param {Object} options - Opcije konverzije
 * @param {number} options.quality - JPEG kvaliteta (1-100, default: 92)
 * @param {number} options.maxWidth - Maksimalna širina (default: 3000)
 * @returns {Promise<{buffer: Buffer, width: number, height: number}>}
 */
async function tiffToJpeg(tiffBuffer, options = {}) {
  if (!sharp) {
    throw new Error('TIFF konverzija nije dostupna (sharp library nije instaliran).');
  }

  const { quality = 92, maxWidth = 3000 } = options;

  try {
    let pipeline = sharp(tiffBuffer, { limitInputPixels: false });

    // Dohvati metapodatke
    const metadata = await pipeline.metadata();
    
    // Resize ako je slika prevelika (ne smanjujemo, samo downscale za prikaz)
    if (metadata.width > maxWidth) {
      pipeline = pipeline.resize(maxWidth, null, { 
        withoutEnlargement: true,
        fit: 'inside'
      });
    }

    const result = await pipeline
      .rotate() // Automatski ispravi EXIF orientaciju
      .jpeg({ quality, progressive: true })
      .toBuffer({ resolveWithObject: true });

    return {
      buffer: result.data,
      width: result.info.width,
      height: result.info.height
    };
  } catch (err) {
    console.error('[TIFF] Greška pri konverziji:', err.message);
    throw new Error(`Nije moguće konvertirati TIFF: ${err.message}`);
  }
}

/**
 * Izrezuje (crop) regiju iz slike i vraća JPEG buffer.
 * @param {Buffer} imageBuffer - Izvorna slika kao Buffer
 * @param {Object} cropRect - Koordinate isjecka u pikselima
 * @param {number} cropRect.x - X koordinata lijevog gornjeg kuta
 * @param {number} cropRect.y - Y koordinata lijevog gornjeg kuta
 * @param {number} cropRect.width - Širina isjecka
 * @param {number} cropRect.height - Visina isjecka
 * @param {number} quality - JPEG kvaliteta (1-100)
 * @returns {Promise<Buffer>}
 */
async function cropImage(imageBuffer, cropRect, quality = 92) {
  if (!sharp) {
    throw new Error('Isjecanje nije dostupno (sharp library nije instaliran).');
  }

  const { x, y, width, height } = cropRect;
  
  return sharp(imageBuffer, { limitInputPixels: false })
    .rotate() // Ispravi EXIF orientaciju
    .extract({ left: Math.round(x), top: Math.round(y), width: Math.round(width), height: Math.round(height) })
    .jpeg({ quality })
    .toBuffer();
}

module.exports = { isTiff, tiffToJpeg, cropImage, TIFF_MIME_TYPES, TIFF_EXTENSIONS };
