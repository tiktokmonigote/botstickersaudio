import express from 'express';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import pino from 'pino';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

const execFileAsync = promisify(execFile);

// ---------- Configuración ----------
const DURACION_MAX = 5;                  // segundos (entre 4 y 6)
const MAX_STICKER_BYTES = 500 * 1024;    // límite de WhatsApp para stickers animados
const INYECTAR_AUDIO_EN_WEBP = false;    // WhatsApp no reconoce el chunk AUDI (probado)
const ENVIAR_NOTA_DE_VOZ = true;         // envía el audio como nota de voz tras el sticker

const AJUSTES_NORMALES = { fps: 12, escala: 512, calidad: 40, nivel: 2 };
const AJUSTES_LIVIANOS = { fps: 8, escala: 384, calidad: 25, nivel: 2 };

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('Bot de stickers activo');
});

app.listen(PORT, () => {
  console.log(`Servidor web escuchando en puerto ${PORT}`);
});

// ---------- Utilidades de conversión ----------

async function convertirVideoASticker(entrada, salidaWebp, ajustes) {
  const { fps, escala, calidad, nivel } = ajustes;
  const filtro =
    `fps=${fps},scale=${escala}:${escala}:force_original_aspect_ratio=decrease:flags=fast_bilinear,` +
    `format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000`;

  await execFileAsync('ffmpeg', [
    '-nostdin',
    '-loglevel', 'error',
    '-y',
    '-t', String(DURACION_MAX),
    '-i', entrada,
    '-vf', filtro,
    '-vcodec', 'libwebp',
    '-lossless', '0',
    '-compression_level', String(nivel),
    '-q:v', String(calidad),
    '-loop', '0',
    '-preset', 'default',
    '-an',
    '-vsync', '0',
    salidaWebp
  ]);
}

// Una pasada normal; solo si pesa de más, un único reintento más liviano.
async function crearSticker(entrada, salidaWebp) {
  await convertirVideoASticker(entrada, salidaWebp, AJUSTES_NORMALES);
  let webp = fs.readFileSync(salidaWebp);

  if (webp.length > MAX_STICKER_BYTES) {
    console.log(`Sticker de ${webp.length} bytes, reintentando con ajustes livianos...`);
    await convertirVideoASticker(entrada, salidaWebp, AJUSTES_LIVIANOS);
    webp = fs.readFileSync(salidaWebp);
  }
  return webp;
}

// Devuelve el Buffer de audio (Opus/OGG mono) o null si no hay audio.
async function obtenerAudio(entrada, salidaOgg) {
  try {
    await execFileAsync('ffmpeg', [
      '-nostdin',
      '-loglevel', 'error',
      '-y',
      '-t', String(DURACION_MAX),
      '-i', entrada,
      '-vn',
      '-ac', '1',
      '-c:a', 'libopus',
      '-b:a', '24k',
      '-f', 'ogg',
      salidaOgg
    ]);
    if (fs.existsSync(salidaOgg) && fs.statSync(salidaOgg).size > 0) {
      return fs.readFileSync(salidaOgg);
    }
    console.log('Audio: ffmpeg termino pero no genero datos.');
    return null;
  } catch (e) {
    const detalle = String(e.stderr || e.message || e).trim().split('\n').slice(-2).join(' | ');
    console.log('Audio no disponible (puede que el video no tenga audio):', detalle);
    return null;
  }
}

// Agrega un chunk RIFF 'AUDI' al final del WebP (desactivado por defecto: WhatsApp no lo reconoce).
function inyectarAudioEnWebp(webp, audio) {
  if (
    webp.length < 12 ||
    webp.toString('ascii', 0, 4) !== 'RIFF' ||
    webp.toString('ascii', 8, 12) !== 'WEBP'
  ) {
    throw new Error('El archivo no es un WebP RIFF valido');
  }

  const partes = [webp];
  if (webp.length % 2 === 1) partes.push(Buffer.alloc(1));

  const cabeceraChunk = Buffer.alloc(8);
  cabeceraChunk.write('AUDI', 0, 4, 'ascii');
  cabeceraChunk.writeUInt32LE(audio.length, 4);

  partes.push(cabeceraChunk, audio);
  if (audio.length % 2 === 1) partes.push(Buffer.alloc(1));

  const resultado = Buffer.concat(partes);
  resultado.writeUInt32LE(resultado.length - 8, 4);
  return resultado;
}

function borrarArchivos(...rutas) {
  for (const ruta of rutas) {
    try {
      if (fs.existsSync(ruta)) fs.unlinkSync(ruta);
    } catch (e) {
      console.error('No se pudo borrar', ruta, e);
    }
  }
}

// ---------- Análisis de stickers (/analizar) ----------

const CHUNKS_CONOCIDOS = new Set(['VP8 ', 'VP8L', 'VP8X', 'ANIM', 'ANMF', 'ALPH', 'ICCP', 'EXIF', 'XMP ']);

const FIRMAS_AUDIO = [
  ['OggS', 'contenedor Ogg (Opus/Vorbis)'],
  ['OpusHead', 'cabecera Opus'],
  ['ID3', 'MP3 con etiqueta ID3'],
  ['ftyp', 'contenedor MP4/M4A/AAC'],
  ['fLaC', 'FLAC'],
  ['#!AMR', 'AMR'],
  ['WAVE', 'WAVE'],
  ['AUDI', 'texto AUDI']
];

function hexVolcado(buf, desde, largo) {
  const f = buf.subarray(desde, Math.min(buf.length, desde + largo));
  const h = [...f].map((b) => b.toString(16).padStart(2, '0')).join(' ');
  const a = [...f].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
  return `${h}  |${a}|`;
}

function textoImprimible(buf, max) {
  return buf
    .subarray(0, max)
    .toString('latin1')
    .replace(/[^\x20-\x7e]/g, '.');
}

// Devuelve { detalle: [...lineas para logs], resumen: [...lineas cortas para el chat] }
function analizarWebp(buf) {
  const D = [];
  const R = [];

  D.push(`Tamano total: ${buf.length} bytes`);
  R.push(`Tamano: ${buf.length} bytes`);

  if (
    buf.length < 12 ||
    buf.toString('ascii', 0, 4) !== 'RIFF' ||
    buf.toString('ascii', 8, 12) !== 'WEBP'
  ) {
    D.push('NO es un WebP RIFF estandar. Primeros 48 bytes: ' + hexVolcado(buf, 0, 48));
    R.push('No es un WebP RIFF estandar.');
    return { detalle: D, resumen: R };
  }

  const declarado = buf.readUInt32LE(4) + 8;
  D.push(`Cabecera RIFF: declara ${declarado} bytes, el archivo real tiene ${buf.length}`);

  let extra = 0;
  if (buf.length > declarado) {
    extra = buf.length - declarado;
    D.push(`!! Hay ${extra} bytes DESPUES del final RIFF declarado. Primeros: ` + hexVolcado(buf, declarado, 48));
    R.push(`Hay ${extra} bytes despues del final del RIFF.`);
  } else if (buf.length < declarado) {
    D.push('!! El archivo es mas corto de lo que declara la cabecera (truncado).');
  }

  const fin = Math.min(buf.length, declarado);
  const secuencia = [];
  const desconocidos = [];
  let frames = 0;
  let pos = 12;

  while (pos + 8 <= fin) {
    const id = buf.toString('ascii', pos, pos + 4);
    const tam = buf.readUInt32LE(pos + 4);
    const ini = pos + 8;
    const conocido = CHUNKS_CONOCIDOS.has(id);

    if (id === 'ANMF') {
      frames++;
      if (frames <= 2) D.push(`@${pos} ANMF tam=${tam} (fotograma ${frames})`);
    } else {
      D.push(`@${pos} '${id}' tam=${tam}${conocido ? '' : '   <-- DESCONOCIDO'}`);
      if (!secuencia.includes(id)) secuencia.push(id);
    }

    if (ini + tam > buf.length) {
      D.push('!! Este bloque se sale del archivo (truncado). Fin del analisis de bloques.');
      break;
    }

    if (id === 'VP8X' && tam >= 10) {
      const fl = buf[ini];
      const ancho = 1 + (buf[ini + 4] | (buf[ini + 5] << 8) | (buf[ini + 6] << 16));
      const alto = 1 + (buf[ini + 7] | (buf[ini + 8] << 8) | (buf[ini + 9] << 16));
      D.push(
        `   VP8X flags=0x${fl.toString(16)} (ICC=${!!(fl & 0x20)} alfa=${!!(fl & 0x10)} EXIF=${!!(fl & 0x08)} XMP=${!!(fl & 0x04)} anim=${!!(fl & 0x02)}) lienzo=${ancho}x${alto}`
      );
    } else if (id === 'ANIM' && tam >= 6) {
      D.push(`   ANIM fondo=${hexVolcado(buf, ini, 4).split('  ')[0]} repeticiones=${buf.readUInt16LE(ini + 4)}`);
    } else if (id === 'EXIF') {
      D.push('   EXIF hex: ' + hexVolcado(buf, ini, 64));
      D.push('   EXIF texto: ' + textoImprimible(buf.subarray(ini, ini + tam), 400));
    } else if (id === 'XMP ') {
      D.push('   XMP texto: ' + textoImprimible(buf.subarray(ini, ini + tam), 400));
    } else if (!conocido) {
      desconocidos.push(`${id}(${tam})`);
      D.push('   datos hex: ' + hexVolcado(buf, ini, 64));
      D.push('   datos texto: ' + textoImprimible(buf.subarray(ini, ini + tam), 200));
    }

    pos = ini + tam + (tam % 2);
  }

  if (pos < fin) D.push(`!! Quedaron ${fin - pos} bytes sin interpretar dentro del RIFF en @${pos}: ` + hexVolcado(buf, pos, 32));

  D.push(`Fotogramas ANMF: ${frames}`);
  D.push('Ultimos 48 bytes del archivo: ' + hexVolcado(buf, Math.max(0, buf.length - 48), 48));

  R.push(`Bloques: ${secuencia.join(', ')}${frames ? ` (+${frames} fotogramas)` : ''}`);
  if (desconocidos.length) R.push(`Bloques DESCONOCIDOS: ${desconocidos.join(', ')}`);

  // Búsqueda de firmas de audio en todo el archivo
  const hallazgos = [];
  for (const [firma, nombre] of FIRMAS_AUDIO) {
    let desde = 0;
    let veces = 0;
    while (veces < 5) {
      const i = buf.indexOf(firma, desde, 'latin1');
      if (i === -1) break;
      const dentro = i < declarado ? 'dentro del RIFF' : 'FUERA del RIFF';
      D.push(`Firma '${firma}' (${nombre}) en @${i} (${dentro}): ` + hexVolcado(buf, i, 24));
      hallazgos.push(`${firma}@${i}`);
      desde = i + 1;
      veces++;
    }
  }
  R.push(hallazgos.length ? `Firmas de audio: ${hallazgos.join(', ')}` : 'Firmas de audio: ninguna encontrada');

  return { detalle: D, resumen: R };
}

// Convierte Buffers y Long en algo legible para imprimir el mensaje del sticker.
function mensajeLegible(obj) {
  return JSON.stringify(
    obj,
    function (clave, valor) {
      const original = this[clave];
      if (original instanceof Uint8Array) return `<${original.length} bytes>`;
      if (original && typeof original.toNumber === 'function') return original.toNumber();
      return valor;
    },
    2
  );
}

async function manejarAnalizar(sock, msg) {
  const jid = msg.key.remoteJid;
  const ctx = msg.message.extendedTextMessage?.contextInfo;
  const quoted = ctx?.quotedMessage;
  const sticker = quoted?.stickerMessage;

  if (!sticker) {
    await sock.sendMessage(
      jid,
      { text: 'Responde /analizar a un sticker para analizarlo.' },
      { quoted: msg }
    );
    return;
  }

  try {
    const mensajeMedia = {
      key: { remoteJid: jid, id: ctx.stanzaId, participant: ctx.participant },
      message: quoted
    };

    const buffer = await downloadMediaMessage(
      mensajeMedia,
      'buffer',
      {},
      { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
    );

    const { detalle, resumen } = analizarWebp(buffer);

    console.log('[ANALIZAR] ===== INICIO =====');
    console.log('[ANALIZAR] Tipos en el mensaje citado:', Object.keys(quoted).join(', '));
    console.log('[ANALIZAR] stickerMessage:\n' + mensajeLegible(sticker));
    for (const linea of detalle) console.log('[ANALIZAR] ' + linea);
    console.log('[ANALIZAR] ===== FIN =====');

    await sock.sendMessage(jid, { text: 'Analisis del sticker:\n' + resumen.join('\n') }, { quoted: msg });

    await sock.sendMessage(
      jid,
      {
        document: buffer,
        mimetype: 'application/octet-stream',
        fileName: `sticker_analizado_${Date.now()}.webp`
      },
      { quoted: msg }
    );
  } catch (e) {
    console.error('[ANALIZAR] Error:', e);
    try {
      await sock.sendMessage(jid, { text: 'No pude analizar ese sticker.' }, { quoted: msg });
    } catch {}
  }
}

// ---------- Bot ----------

async function iniciarBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./sesion_bot');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    auth: state,
    printQRInTerminal: false,
    browser: ['Ubuntu', 'Chrome', '20.0.04']
  });

  if (!sock.authState.creds.registered) {
    const numeroBot = (process.env.NUMERO_BOT || '').replace(/[^0-9]/g, '');
    if (numeroBot) {
      setTimeout(async () => {
        try {
          const codigo = await sock.requestPairingCode(numeroBot);
          console.log('=========================================');
          console.log('TU CODIGO DE VINCULACION ES:', codigo);
          console.log('=========================================');
        } catch (err) {
          console.error('Error al pedir codigo de vinculacion:', err);
        }
      }, 4000);
    } else {
      console.log('AVISO: Agrega la variable NUMERO_BOT en Render (ej: 584121234567)');
    }
  }

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      console.log('Bot conectado a WhatsApp correctamente.');
    } else if (connection === 'close') {
      const codigoError = lastDisconnect?.error?.output?.statusCode;
      if (codigoError !== DisconnectReason.loggedOut) {
        iniciarBot();
      } else {
        console.log('Sesion cerrada. Borra la carpeta de sesion y vincula de nuevo.');
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const texto = (
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.videoMessage?.caption ||
      ''
    ).trim().toLowerCase();

    if (texto.startsWith('/analizar')) {
      await manejarAnalizar(sock, msg);
      return;
    }

    if (!texto.startsWith('/sa')) return;

    const videoDirecto = msg.message.videoMessage;
    const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
    const videoCitado = quoted?.videoMessage;

    if (!videoDirecto && !videoCitado) {
      await sock.sendMessage(
        msg.key.remoteJid,
        { text: 'Envía un video corto con /sa o responde /sa a un video.' },
        { quoted: msg }
      );
      return;
    }

    const idTemp = Date.now();
    const entrada = path.join('/tmp', `in_${idTemp}.mp4`);
    const salidaWebp = path.join('/tmp', `out_${idTemp}.webp`);
    const salidaAudio = path.join('/tmp', `audio_${idTemp}.ogg`);

    try {
      const inicio = Date.now();

      const mensajeMedia = videoDirecto
        ? msg
        : {
            key: {
              remoteJid: msg.key.remoteJid,
              id: msg.message.extendedTextMessage.contextInfo.stanzaId,
              participant: msg.message.extendedTextMessage.contextInfo.participant
            },
            message: quoted
          };

      const buffer = await downloadMediaMessage(
        mensajeMedia,
        'buffer',
        {},
        { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
      );

      fs.writeFileSync(entrada, buffer);
      console.log(`Video descargado en ${Date.now() - inicio} ms`);

      // Sticker y audio se procesan a la vez
      const [webp, audioBuffer] = await Promise.all([
        crearSticker(entrada, salidaWebp),
        obtenerAudio(entrada, salidaAudio)
      ]);
      console.log(`Conversion lista en ${Date.now() - inicio} ms (sticker ${webp.length} bytes)`);

      const stickerFinal =
        INYECTAR_AUDIO_EN_WEBP && audioBuffer ? inyectarAudioEnWebp(webp, audioBuffer) : webp;

      await sock.sendMessage(msg.key.remoteJid, { sticker: stickerFinal }, { quoted: msg });

      if (ENVIAR_NOTA_DE_VOZ && audioBuffer) {
        await sock.sendMessage(
          msg.key.remoteJid,
          { audio: audioBuffer, mimetype: 'audio/ogg; codecs=opus', ptt: true },
          { quoted: msg }
        );
      }

      console.log(`Respuesta enviada en ${Date.now() - inicio} ms`);
    } catch (e) {
      console.error('Error procesando mensaje:', e);
      try {
        await sock.sendMessage(msg.key.remoteJid, { text: 'No pude convertir el video.' }, { quoted: msg });
      } catch {}
    } finally {
      borrarArchivos(entrada, salidaWebp, salidaAudio);
    }
  });
}

iniciarBot();
