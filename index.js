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
