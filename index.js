import express from 'express';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  downloadContentFromMessage,
  fetchLatestBaileysVersion,
  prepareWAMessageMedia,
  generateWAMessageFromContent
} from '@whiskeysockets/baileys';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { construirExif, inyectarExif } from './src/exif.js';
import { sondear, videoAWebp, videoAOpus } from './src/media.js';

// ---------- Configuración (todo ajustable por variables de entorno en Render) ----------
const DURACION_MAX = Number(process.env.DURACION_MAX || 7);          // segundos máximos de video (límite duro)
const MAX_VIDEO_BYTES = Number(process.env.MAX_VIDEO_BYTES || 25_000_000); // no descarga videos más pesados que esto
const MSJ_LARGO = process.env.MSJ_LARGO || `Sube un video de máximo ${DURACION_MAX} segundos ⏲️`;
const MAX_STICKER_BYTES = Number(process.env.MAX_STICKER_BYTES || 1_000_000);
const MODO_CUADRO = process.env.MODO_CUADRO || 'recortar';           // 'recortar' | 'bordes'
const PACK = process.env.STICKER_PACK || 'Kley🔥Bot☄️';
const AUTOR = process.env.STICKER_AUTOR || 'Kley🔥Bot☄️';
const SESION_DIR = process.env.SESION_DIR || './sesion_bot';          // apúntalo a un disco persistente
const TMP = process.env.TMP_DIR || '/tmp';
const MAX_COLA = Number(process.env.MAX_COLA || 50);                  // pedidos pendientes antes de pedir que reintenten
const CONCURRENCIA = Math.max(1, Number(process.env.CONCURRENCIA || 1)); // videos convertidos a la vez (sube a 2-3 con mas CPU)
const MSJ_SATURADO = process.env.MSJ_SATURADO || 'Vuelve a subir el video en pocos segundos, hay mucha demanda de stickers, perdón 🥺';
const PORT = process.env.PORT || 3000;
const URL_PUBLICA = process.env.RENDER_EXTERNAL_URL || process.env.URL_PUBLICA || '';

const logger = pino({ level: 'silent' });
const EXIF = construirExif({ pack: PACK, autor: AUTOR, packId: 'com.kleybot.stickers' });

// ---------- Servidor web + keep-alive (evita que Render duerma el servicio) ----------
const app = express();
let estado = 'iniciando';
app.get('/', (_req, res) => res.send('Kley🔥Bot☄️ activo'));
app.get('/ping', (_req, res) => res.type('text/plain').send('ok')); // para cron-job.org
app.get('/salud', (_req, res) => res.json({ ok: true, whatsapp: estado, uptime: Math.round(process.uptime()) }));
app.listen(PORT, () => console.log(`Servidor web escuchando en puerto ${PORT}`));

if (URL_PUBLICA) {
  setInterval(() => {
    fetch(`${URL_PUBLICA.replace(/\/$/, '')}/salud`).catch((e) => console.log('Keep-alive fallo:', e.message));
  }, 10 * 60 * 1000);
  console.log(`Keep-alive activo contra ${URL_PUBLICA}`);
} else {
  console.log('AVISO: sin RENDER_EXTERNAL_URL; el keep-alive no se activa (Render lo define solo).');
}

process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e));

// ---------- Utilidades ----------
function borrar(...rutas) {
  for (const r of rutas) {
    try { if (fs.existsSync(r)) fs.unlinkSync(r); } catch (e) { console.error('No se pudo borrar', r, e.message); }
  }
}

function desenvolver(m) {
  let c = m;
  while (c) {
    const n = c.ephemeralMessage?.message || c.viewOnceMessage?.message || c.viewOnceMessageV2?.message || c.documentWithCaptionMessage?.message;
    if (!n) break;
    c = n;
  }
  return c;
}

async function descargar(contenido, tipo) {
  const flujo = await downloadContentFromMessage(contenido, tipo);
  const partes = [];
  for await (const p of flujo) partes.push(p);
  return Buffer.concat(partes);
}

// Cola con hasta CONCURRENCIA videos a la vez (ffmpeg es pesado: en el plan gratuito deja 1).
const cola = [];
let activos = 0;
const pendientes = () => cola.length + activos;
function encolar(tarea) {
  cola.push(tarea);
  bombear();
}
function bombear() {
  while (activos < CONCURRENCIA && cola.length) {
    const t = cola.shift();
    activos++;
    t()
      .catch((e) => console.error('Error en tarea:', e))
      .finally(() => { activos--; bombear(); });
  }
}

// ---------- Envío del sticker con sonido ----------
// Formato real de WhatsApp: audioStickerMessage (134) > stickerMessage > audioMessage (26).
async function enviarStickerSonoro(sock, jid, webp, lado, ogg, segundosAudio) {
  const subida = { upload: sock.waUploadToServer, logger };

  const [{ stickerMessage }, { audioMessage }] = await Promise.all([
    prepareWAMessageMedia({ sticker: webp }, subida),
    prepareWAMessageMedia({ audio: ogg }, subida)
  ]);
  stickerMessage.isAnimated = true;
  stickerMessage.width = lado;
  stickerMessage.height = lado;
  audioMessage.mimetype = 'audio/ogg; codecs=opus';
  audioMessage.ptt = false;
  if (!audioMessage.seconds) audioMessage.seconds = Math.max(1, Math.round(segundosAudio));
  stickerMessage.audioMessage = audioMessage;

  const waMsg = generateWAMessageFromContent(
    jid,
    { audioStickerMessage: { message: { stickerMessage } } },
    { userJid: sock.user.id }
  );
  await sock.relayMessage(jid, waMsg.message, { messageId: waMsg.key.id });
  return waMsg.key.id;
}

async function manejarSticker(sock, msg, contenido) {
  const jid = msg.key.remoteJid;
  const ext = contenido.extendedTextMessage?.contextInfo;
  const videoDirecto = contenido.videoMessage;
  const videoCitado = desenvolver(ext?.quotedMessage)?.videoMessage;

  if (!videoDirecto && !videoCitado) {
    await sock.sendMessage(jid, { text: 'Envía un video corto con /crea o responde /crea a un video.' }, { quoted: msg });
    return;
  }

  // Respuesta inmediata: el reloj aparece al instante mientras se convierte.
  const reaccionar = (emoji) => sock.sendMessage(jid, { react: { text: emoji, key: msg.key } }).catch(() => {});

  const id = Date.now();
  const entrada = path.join(TMP, `in_${id}.mp4`);
  const salidaWebp = path.join(TMP, `out_${id}.webp`);
  const salidaOgg = path.join(TMP, `audio_${id}.ogg`);

  try {
    const inicio = Date.now();
    const fuente = videoDirecto || videoCitado;
    const buffer = await descargar(fuente, 'video');
    fs.writeFileSync(entrada, buffer);

    const { tieneAudio, duracion, ladoMin } = await sondear(entrada);
    if (duracion > DURACION_MAX + 0.6) {
      await sock.sendMessage(jid, { text: MSJ_LARGO }, { quoted: msg });
      reaccionar('❌');
      return;
    }
    const segundos = Math.min(DURACION_MAX, duracion || DURACION_MAX);
    console.log(`Video ${buffer.length} B, ${duracion}s, audio=${tieneAudio}`);

    const [{ webp, lado }, ogg] = await Promise.all([
      videoAWebp(entrada, salidaWebp, { segundos, maxBytes: MAX_STICKER_BYTES, exif: EXIF, modo: MODO_CUADRO, ladoMin }),
      tieneAudio
        ? videoAOpus(entrada, salidaOgg, { segundos: Math.max(0.5, segundos - 0.1) }).catch((e) => {
            console.log('Audio no disponible:', e.message);
            return null;
          })
        : Promise.resolve(null)
    ]);
    console.log(`Conversión lista en ${Date.now() - inicio} ms`);

    if (ogg) {
      try {
        const idEnviado = await enviarStickerSonoro(sock, jid, webp, lado, ogg, segundos - 0.1);
        console.log(`Sticker con sonido enviado (${idEnviado}) en ${Date.now() - inicio} ms`);
        reaccionar('✅');
        return;
      } catch (e) {
        console.error('Fallo el sticker con sonido, uso el plan B:', e);
        await sock.sendMessage(jid, { sticker: webp }, { quoted: msg });
        await sock.sendMessage(jid, { audio: ogg, mimetype: 'audio/ogg; codecs=opus', ptt: true }, { quoted: msg });
        return;
      }
    }

    // Video sin audio: sticker animado normal
    await sock.sendMessage(jid, { sticker: webp }, { quoted: msg });
    console.log(`Sticker (sin audio) enviado en ${Date.now() - inicio} ms`);
    reaccionar('✅');
  } catch (e) {
    reaccionar('❌');
    console.error('Error procesando mensaje:', e);
    try { await sock.sendMessage(jid, { text: 'No pude convertir el video.' }, { quoted: msg }); } catch {}
  } finally {
    borrar(entrada, salidaWebp, salidaOgg, `${salidaOgg}.paso1.ogg`);
  }
}

// BRAT-INICIO
// ---------- /brat: texto -> sticker blanco con letras negras ----------
const BRAT_FUENTE = process.env.BRAT_FUENTE || '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf';
const BRAT_DESENFOQUE = Number(process.env.BRAT_DESENFOQUE ?? 0.6);          // 0 = nítido; 1 = más difuminado
const BRAT_MAX_CARACTERES = Number(process.env.BRAT_MAX_CARACTERES || 150);
const BRAT_MAX_SIMULTANEOS = Number(process.env.BRAT_MAX_SIMULTANEOS || 2);
let bratActivos = 0;

// Ancho aproximado de cada letra (en "em", como Arial) para repartir el texto sin cortarlo.
function anchoLetra(c) {
  if (c === ' ') return 0.278;
  if ('ijl'.includes(c)) return 0.222;
  if ('tfI.,:;\'!|'.includes(c)) return 0.278;
  if (c === 'r') return 0.333;
  if (c === 'm') return 0.833;
  if (c === 'w') return 0.722;
  if (c === 'W') return 0.944;
  if (c === 'M') return 0.833;
  if (/[0-9]/.test(c)) return 0.556;
  if (c !== c.toLowerCase()) return 0.7; // mayúsculas
  return 0.556;
}
const anchoTexto = (t, size) => [...t].reduce((n, c) => n + anchoLetra(c), 0) * size * 1.04;

function envolverTexto(texto, size) {
  const max = 456; // 512 menos márgenes
  const lineas = [];
  for (const parrafo of texto.split('\n')) {
    let linea = '';
    for (let palabra of parrafo.split(/\s+/).filter(Boolean)) {
      while (anchoTexto(palabra, size) > max) { // palabra más ancha que la línea: se parte
        if (linea) { lineas.push(linea); linea = ''; }
        let n = palabra.length;
        while (n > 1 && anchoTexto(palabra.slice(0, n), size) > max) n--;
        lineas.push(palabra.slice(0, n));
        palabra = palabra.slice(n);
      }
      if (!linea) linea = palabra;
      else if (anchoTexto(`${linea} ${palabra}`, size) <= max) linea += ` ${palabra}`;
      else { lineas.push(linea); linea = palabra; }
    }
    if (linea) lineas.push(linea);
  }
  return lineas;
}

function maquetarBrat(texto) {
  for (let size = 150; size >= 24; size -= 2) {
    const lineas = envolverTexto(texto, size);
    if (lineas.length * size * 1.15 <= 456) return { lineas, size };
  }
  return { lineas: envolverTexto(texto, 24), size: 24 };
}

async function generarBrat(texto, id) {
  const { lineas, size } = maquetarBrat(texto);
  const archivoTxt = path.join(TMP, `brat_${id}.txt`);
  const salida = path.join(TMP, `brat_${id}.webp`);
  try {
    fs.writeFileSync(archivoTxt, lineas.join('\n'));
    const blur = BRAT_DESENFOQUE > 0 ? `,gblur=sigma=${BRAT_DESENFOQUE}` : '';
    const filtro =
      `drawtext=fontfile=${BRAT_FUENTE}:textfile=${archivoTxt}:expansion=none:fontsize=${size}` +
      `:fontcolor=black:x=28:y=24:line_spacing=${Math.round(size * 0.15)}${blur}`;
    await new Promise((resolve, reject) => {
      execFile('ffmpeg', [
        '-nostdin', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'color=c=white:s=512x512:d=1',
        '-vf', filtro,
        '-frames:v', '1',
        '-c:v', 'libwebp', '-lossless', '0', '-q:v', '85', '-compression_level', '4',
        salida
      ], { timeout: 30_000 }, (err, _out, stderr) => {
        if (err) reject(new Error(String(stderr || err.message).trim().split('\n').slice(-2).join(' | ')));
        else resolve();
      });
    });
    return inyectarExif(fs.readFileSync(salida), EXIF, { ancho: 512, alto: 512 });
  } finally {
    borrar(archivoTxt, salida);
  }
}

async function manejarBrat(sock, msg, contenido) {
  const jid = msg.key.remoteJid;
  const quitarEmojis = (t) => t.replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, '').replace(/[\u0000-\u0008\u000B-\u001F]/g, '').trim();
  const original = (contenido.conversation || contenido.extendedTextMessage?.text || contenido.imageMessage?.caption || '').trim();
  let texto = quitarEmojis(original.replace(/^\/brat\s*/i, ''));
  if (!texto) {
    const citado = desenvolver(contenido.extendedTextMessage?.contextInfo?.quotedMessage);
    texto = quitarEmojis(citado?.conversation || citado?.extendedTextMessage?.text || '');
  }
  if (!texto) {
    await sock.sendMessage(jid, { text: 'Escribe el texto después del comando. Ejemplo: /brat Hola gente' }, { quoted: msg });
    return;
  }
  if (texto.length > BRAT_MAX_CARACTERES) {
    await sock.sendMessage(jid, { text: `Máximo ${BRAT_MAX_CARACTERES} caracteres.` }, { quoted: msg });
    return;
  }
  if (bratActivos >= BRAT_MAX_SIMULTANEOS) {
    await sock.sendMessage(jid, { text: MSJ_SATURADO }, { quoted: msg });
    return;
  }
  bratActivos++;
  try {
    const webp = await generarBrat(texto, `${Date.now()}_${Math.floor(Math.random() * 1000)}`);
    await sock.sendMessage(jid, { sticker: webp }, { quoted: msg });
    console.log(`/brat enviado (${texto.length} caracteres, ${webp.length} B)`);
  } catch (e) {
    console.error('Error en /brat:', e);
    try { await sock.sendMessage(jid, { text: 'No pude crear el sticker.' }, { quoted: msg }); } catch {}
  } finally {
    bratActivos--;
  }
}
// BRAT-FIN

// ---------- /analizar (ahora también reconoce stickers con sonido) ----------
async function manejarAnalizar(sock, msg, contenido) {
  const jid = msg.key.remoteJid;
  const citado = desenvolver(contenido.extendedTextMessage?.contextInfo?.quotedMessage);
  const conSonido = citado?.audioStickerMessage?.message?.stickerMessage;
  const sticker = conSonido || citado?.stickerMessage;

  if (!sticker) {
    await sock.sendMessage(jid, { text: 'Responde /analizar a un sticker para analizarlo.' }, { quoted: msg });
    return;
  }

  try {
    const webp = await descargar(sticker, 'sticker');
    const lineas = [
      `Tipo: ${conSonido ? 'STICKER CON SONIDO (audioStickerMessage)' : 'sticker normal'}`,
      `Animado: ${!!sticker.isAnimated}`,
      `WebP: ${webp.length} bytes`
    ];
    let ogg = null;
    if (sticker.audioMessage) {
      ogg = await descargar(sticker.audioMessage, 'audio');
      lineas.push(`Audio: ${ogg.length} bytes, ${sticker.audioMessage.seconds ?? '?'} s, ${sticker.audioMessage.mimetype}`);
    }

    const campos = JSON.stringify(
      sticker,
      function (k, v) {
        const o = this[k];
        if (o instanceof Uint8Array) return `<${o.length} bytes>`;
        if (o && typeof o.toNumber === 'function') return o.toNumber();
        return v;
      },
      2
    );
    console.log('[ANALIZAR] ' + lineas.join(' | ') + '\n' + campos);

    await sock.sendMessage(jid, { text: 'Análisis:\n' + lineas.join('\n') }, { quoted: msg });
    await sock.sendMessage(jid, { document: webp, mimetype: 'application/octet-stream', fileName: `sticker_${Date.now()}.webp` }, { quoted: msg });
    if (ogg) {
      await sock.sendMessage(jid, { document: ogg, mimetype: 'application/octet-stream', fileName: `audio_${Date.now()}.ogg` }, { quoted: msg });
    }
  } catch (e) {
    console.error('[ANALIZAR] Error:', e);
    try { await sock.sendMessage(jid, { text: 'No pude analizar ese sticker.' }, { quoted: msg }); } catch {}
  }
}

// ---------- Bot ----------
let intentos = 0;

async function iniciarBot() {
  // Si defines MONGODB_URI en Render, la sesión se guarda en MongoDB y no se pierde al reiniciar.
  let auth;
  if (process.env.MONGODB_URI) {
    const { usarAuthMongo } = await import('./src/auth-mongo.js');
    auth = await usarAuthMongo(process.env.MONGODB_URI);
  } else {
    auth = await useMultiFileAuthState(SESION_DIR);
  }
  const { state, saveCreds } = auth;
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger,
    auth: state,
    browser: ['Ubuntu', 'Chrome', '20.0.04'],
    markOnlineOnConnect: false,   // no se muestra "en línea": el teléfono sigue recibiendo notificaciones
    keepAliveIntervalMs: 25_000,
    connectTimeoutMs: 60_000,
    syncFullHistory: false
  });

  if (!sock.authState.creds.registered) {
    const numero = (process.env.NUMERO_BOT || '').replace(/[^0-9]/g, '');
    if (numero) {
      setTimeout(async () => {
        try {
          const codigo = await sock.requestPairingCode(numero);
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
      intentos = 0;
      estado = 'conectado';
      console.log('Bot conectado a WhatsApp correctamente.');
    } else if (connection === 'close') {
      estado = 'reconectando';
      const codigo = lastDisconnect?.error?.output?.statusCode;
      if (codigo === DisconnectReason.loggedOut) {
        estado = 'sesion cerrada';
        console.log('Sesion cerrada. Borra la carpeta de sesion y vincula de nuevo.');
        return;
      }
      const espera = Math.min(30_000, 2_000 * 2 ** Math.min(intentos++, 4));
      console.log(`Conexión cerrada (código ${codigo}). Reintentando en ${espera / 1000}s...`);
      try { sock.ev.removeAllListeners(); } catch {}
      setTimeout(() => iniciarBot().catch((e) => { console.error('Error al reiniciar:', e); setTimeout(iniciarBot, 10_000); }), espera);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      const contenido = desenvolver(msg.message);
      if (!contenido) continue;

      const texto = (
        contenido.conversation ||
        contenido.extendedTextMessage?.text ||
        contenido.videoMessage?.caption ||
        ''
      ).trim().toLowerCase();

      if (texto.startsWith('/analizar')) encolar(() => manejarAnalizar(sock, msg, contenido));
      else if (/^\/brat(\s|$)/.test(texto)) manejarBrat(sock, msg, contenido).catch((e) => console.error('Error en /brat:', e));
      else if (texto.startsWith('/crea')) {
        const fuenteVideo = contenido.videoMessage || desenvolver(contenido.extendedTextMessage?.contextInfo?.quotedMessage)?.videoMessage;
        const segundosVideo = Number(fuenteVideo?.seconds || 0);
        const bytesVideo = Number(fuenteVideo?.fileLength?.toNumber ? fuenteVideo.fileLength.toNumber() : fuenteVideo?.fileLength || 0);
        if (fuenteVideo && (segundosVideo > DURACION_MAX || bytesVideo > MAX_VIDEO_BYTES)) {
          console.log(`Video rechazado: ${segundosVideo}s, ${bytesVideo} B (limite ${DURACION_MAX}s)`);
          sock.sendMessage(msg.key.remoteJid, { text: MSJ_LARGO }, { quoted: msg }).catch(() => {});
          continue;
        }
        if (pendientes() >= MAX_COLA) {
          console.log(`Saturado (${pendientes()} pendientes): pido reintentar`);
          sock.sendMessage(msg.key.remoteJid, { text: MSJ_SATURADO }, { quoted: msg }).catch(() => {});
        } else {
          // Reacción inmediata al recibirlo (aunque esté esperando turno en la cola).
          const hayVideo = contenido.videoMessage || desenvolver(contenido.extendedTextMessage?.contextInfo?.quotedMessage)?.videoMessage;
          if (hayVideo) sock.sendMessage(msg.key.remoteJid, { react: { text: '⏳', key: msg.key } }).catch(() => {});
          encolar(() => manejarSticker(sock, msg, contenido));
        }
      }
    }
  });
}

iniciarBot().catch((e) => {
  console.error('Error fatal al iniciar:', e);
  process.exit(1);
});
