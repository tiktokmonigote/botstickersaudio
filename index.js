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
import { construirExif } from './src/exif.js';
import { sondear, videoAWebp, videoAOpus } from './src/media.js';

// ---------- Configuración (todo ajustable por variables de entorno en Render) ----------
const DURACION_MAX = Number(process.env.DURACION_MAX || 6);          // segundos de video
const MAX_STICKER_BYTES = Number(process.env.MAX_STICKER_BYTES || 1_000_000);
const MODO_CUADRO = process.env.MODO_CUADRO || 'recortar';           // 'recortar' | 'bordes'
const PACK = process.env.STICKER_PACK || 'Stickers con sonido';
const AUTOR = process.env.STICKER_AUTOR || 'Bot';
const SESION_DIR = process.env.SESION_DIR || './sesion_bot';          // apúntalo a un disco persistente
const TMP = process.env.TMP_DIR || '/tmp';
const PORT = process.env.PORT || 3000;
const URL_PUBLICA = process.env.RENDER_EXTERNAL_URL || process.env.URL_PUBLICA || '';

const logger = pino({ level: 'silent' });
const EXIF = construirExif({ pack: PACK, autor: AUTOR });

// ---------- Servidor web + keep-alive (evita que Render duerma el servicio) ----------
const app = express();
let estado = 'iniciando';
app.get('/', (_req, res) => res.send('Bot de stickers activo'));
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

// Cola: un video a la vez (ffmpeg es pesado en el plan gratuito de Render)
const cola = [];
let ocupado = false;
function encolar(tarea) {
  cola.push(tarea);
  bombear();
}
async function bombear() {
  if (ocupado) return;
  const t = cola.shift();
  if (!t) return;
  ocupado = true;
  try { await t(); } catch (e) { console.error('Error en tarea:', e); }
  ocupado = false;
  bombear();
}

// ---------- Envío del sticker con sonido ----------
// Formato real de WhatsApp: audioStickerMessage (134) > stickerMessage > audioMessage (26).
async function enviarStickerSonoro(sock, jid, webp, lado, ogg, segundosAudio) {
  const subida = { upload: sock.waUploadToServer, logger };

  const { stickerMessage } = await prepareWAMessageMedia({ sticker: webp }, subida);
  stickerMessage.isAnimated = true;
  stickerMessage.width = lado;
  stickerMessage.height = lado;

  const { audioMessage } = await prepareWAMessageMedia({ audio: ogg }, subida);
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
    await sock.sendMessage(jid, { text: 'Envía un video corto con /sa o responde /sa a un video.' }, { quoted: msg });
    return;
  }

  const id = Date.now();
  const entrada = path.join(TMP, `in_${id}.mp4`);
  const salidaWebp = path.join(TMP, `out_${id}.webp`);
  const salidaOgg = path.join(TMP, `audio_${id}.ogg`);

  try {
    const inicio = Date.now();
    const fuente = videoDirecto || videoCitado;
    const buffer = await descargar(fuente, 'video');
    fs.writeFileSync(entrada, buffer);

    const { tieneAudio, duracion } = await sondear(entrada);
    const segundos = Math.min(DURACION_MAX, duracion || DURACION_MAX);
    console.log(`Video ${buffer.length} B, ${duracion}s, audio=${tieneAudio}`);

    const [{ webp, lado }, ogg] = await Promise.all([
      videoAWebp(entrada, salidaWebp, { segundos, maxBytes: MAX_STICKER_BYTES, exif: EXIF, modo: MODO_CUADRO }),
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
  } catch (e) {
    console.error('Error procesando mensaje:', e);
    try { await sock.sendMessage(jid, { text: 'No pude convertir el video.' }, { quoted: msg }); } catch {}
  } finally {
    borrar(entrada, salidaWebp, salidaOgg, `${salidaOgg}.paso1.ogg`);
  }
}

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
  const { state, saveCreds } = await useMultiFileAuthState(SESION_DIR);
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
      else if (texto.startsWith('/sa')) encolar(() => manejarSticker(sock, msg, contenido));
    }
  });
}

iniciarBot().catch((e) => {
  console.error('Error fatal al iniciar:', e);
  process.exit(1);
});
