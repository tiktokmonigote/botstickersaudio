// Metadatos EXIF de stickers de WhatsApp + utilidades RIFF/WebP.
const WA_EXIF_HEADER = Buffer.from([
  0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x16, 0x00, 0x00, 0x00
]);
const VP8X_EXIF_FLAG = 0x08;

export function construirExif({ pack = '', autor = '', packId = 'com.bot.stickersonoros', emojis = [''] } = {}) {
  const json = Buffer.from(
    JSON.stringify({
      'sticker-pack-id': packId,
      'sticker-pack-name': pack,
      'sticker-pack-publisher': autor,
      emojis
    }),
    'utf8'
  );
  const cab = Buffer.from(WA_EXIF_HEADER);
  cab.writeUInt32LE(json.length, 14);
  return Buffer.concat([cab, json]);
}

function chunk(fourcc, payload) {
  const h = Buffer.alloc(8);
  h.write(fourcc, 0, 4, 'ascii');
  h.writeUInt32LE(payload.length, 4);
  return Buffer.concat([h, payload, payload.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

// Inserta (o reemplaza) el chunk EXIF y activa el flag en VP8X.
export function inyectarExif(webp, exif, { ancho = 512, alto = 512 } = {}) {
  if (webp.length < 12 || webp.toString('ascii', 0, 4) !== 'RIFF' || webp.toString('ascii', 8, 12) !== 'WEBP') {
    throw new Error('WebP invalido (sin cabecera RIFF/WEBP)');
  }
  const chunks = [];
  let tieneVp8x = false;
  let alfa = false;
  let anim = false;
  let pos = 12;

  while (pos + 8 <= webp.length) {
    const id = webp.toString('ascii', pos, pos + 4);
    const tam = webp.readUInt32LE(pos + 4);
    const ini = pos + 8;
    const fin = ini + tam;
    if (fin > webp.length) throw new Error(`Chunk WebP truncado: ${id}`);

    if (id !== 'EXIF') {
      const datos = Buffer.from(webp.subarray(ini, fin));
      if (id === 'VP8X') {
        datos[0] |= VP8X_EXIF_FLAG;
        tieneVp8x = true;
      } else if (id === 'ALPH') alfa = true;
      else if (id === 'ANIM') anim = true;
      chunks.push(chunk(id, datos));
    }
    pos = fin + (tam % 2);
  }

  if (!tieneVp8x) {
    const p = Buffer.alloc(10);
    p[0] = VP8X_EXIF_FLAG | (alfa ? 0x10 : 0) | (anim ? 0x02 : 0);
    p.writeUIntLE(ancho - 1, 4, 3);
    p.writeUIntLE(alto - 1, 7, 3);
    chunks.unshift(chunk('VP8X', p));
  }
  chunks.push(chunk('EXIF', exif));

  const cuerpo = Buffer.concat(chunks);
  const cab = Buffer.alloc(12);
  cab.write('RIFF', 0, 4, 'ascii');
  cab.writeUInt32LE(4 + cuerpo.length, 4);
  cab.write('WEBP', 8, 4, 'ascii');
  return Buffer.concat([cab, cuerpo]);
}
