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

const MAX_STICKER_BYTES = 500 * 1024;
const CALIDADES = [50, 35, 20];

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('Bot de stickers activo');
});

app.listen(PORT, () => {
  console.log(`Servidor web escuchando en puerto ${PORT}`);
});

// ---------- Utilidades de conversión ----------

async function convertirVideoASticker(entrada, salidaWebp, calidad) {
  await execFileAsync('ffmpeg', [
    '-y',
    '-i', entrada,
    '-t', '6',
    '-vf',
    'fps=15,scale=512:512:force_original_aspect_ratio=decrease,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000',
    '-vcodec', 'libwebp',
    '-lossless', '0',
    '-compression_level', '6',
    '-q:v', String(calidad),
    '-loop', '0',
    '-preset', 'default',
    '-an',
    '-vsync', '0',
    salidaWebp
  ]);
}

// Devuelve true si se pudo extraer audio; false si el video no tiene pista de audio.
async function extraerAudio(entrada, salidaOgg) {
  try {
    await execFileAsync('ffmpeg', [
      '-y',
      '-i', entrada,
      '-t', '6',
      '-vn',
      '-ac', '1',
      '-c:a', 'libopus',
      '-b:a', '24k',
      '-f', 'ogg',
      salidaOgg
    ]);
    return fs.existsSync(salidaOgg) && fs.statSync(salidaOgg).size > 0;
  } catch {
    return false;
  }
}

// Agrega un chunk RIFF 'AUDI' al final del WebP y corrige el tamaño de la cabecera RIFF.
function inyectarAudioEnWebp(webp, audio) {
  if (
    webp.length < 12 ||
    webp.toString('ascii', 0, 4) !== 'RIFF' ||
    webp.toString('ascii', 8, 12) !== 'WEBP'
  ) {
    throw new Error('El archivo no es un WebP RIFF valido');
  }

  const partes = [webp];

  // Los chunks RIFF deben empezar en posicion par.
  if (webp.length % 2 === 1) partes.push(Buffer.alloc(1));

  const cabeceraChunk = Buffer.alloc(8);
  cabeceraChunk.write('AUDI', 0, 4, 'ascii');
  cabeceraChunk.writeUInt32LE(audio.length, 4);

  partes.push(cabeceraChunk, audio);

  // Padding si el tamaño del audio es impar (no se cuenta en el tamaño del chunk).
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

      // 1) Audio (opcional: si el video no tiene audio, se envia sin audio)
      const tieneAudio = await extraerAudio(entrada, salidaAudio);
      const audioBuffer = tieneAudio ? fs.readFileSync(salidaAudio) : null;

      // 2) Sticker WebP, bajando calidad si pasa del limite de tamaño
      let stickerFinal = null;
      for (const calidad of CALIDADES) {
        await convertirVideoASticker(entrada, salidaWebp, calidad);
        const webp = fs.readFileSync(salidaWebp);
        stickerFinal = audioBuffer ? inyectarAudioEnWebp(webp, audioBuffer) : webp;
        if (stickerFinal.length <= MAX_STICKER_BYTES) break;
        console.log(`Sticker de ${stickerFinal.length} bytes con calidad ${calidad}, reintentando...`);
      }

      await sock.sendMessage(msg.key.remoteJid, { sticker: stickerFinal }, { quoted: msg });
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
