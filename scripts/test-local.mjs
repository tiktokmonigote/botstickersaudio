// Prueba local sin WhatsApp: ffmpeg -> WebP+EXIF, Opus, y codificación protobuf del sticker sonoro.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { generateWAMessageFromContent, proto } from '@whiskeysockets/baileys';
import { construirExif } from '../src/exif.js';
import { sondear, videoAWebp, videoAOpus } from '../src/media.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stk-'));
const mp4 = path.join(dir, 'in.mp4');

execFileSync('ffmpeg', ['-nostdin','-loglevel','error','-y',
  '-f','lavfi','-i','testsrc2=s=640x360:r=30:d=6',
  '-f','lavfi','-i','sine=frequency=440:duration=6',
  '-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest', mp4]);

const info = await sondear(mp4);
console.log('sondeo:', info);

const { webp, lado } = await videoAWebp(mp4, path.join(dir,'o.webp'), { segundos: 6, maxBytes: 1_000_000, exif: construirExif({ pack:'P', autor:'A' }) });
console.log('RIFF ok:', webp.toString('ascii',0,4), webp.toString('ascii',8,12), 'declarado', webp.readUInt32LE(4)+8, 'real', webp.length);
const tipos = []; let p = 12;
while (p + 8 <= webp.length) { const id = webp.toString('ascii',p,p+4); const t = webp.readUInt32LE(p+4); if(!tipos.includes(id)) tipos.push(id); p += 8 + t + (t%2); }
console.log('chunks:', tipos.join(','), '| bytes sobrantes:', webp.length - p);

const ogg = await videoAOpus(mp4, path.join(dir,'a.ogg'), { segundos: 5.9 });
fs.writeFileSync(path.join(dir,'check.ogg'), ogg);
console.log('opus:', execFileSync('ffprobe',['-v','error','-show_entries','stream=codec_name,channels,bit_rate:format=duration','-of','compact',path.join(dir,'check.ogg')]).toString().trim());

const msg = generateWAMessageFromContent('584120000000@s.whatsapp.net', {
  audioStickerMessage: { message: { stickerMessage: {
    mimetype:'image/webp', isAnimated:true, width:lado, height:lado, fileLength: webp.length,
    audioMessage: { mimetype:'audio/ogg; codecs=opus', seconds:6, ptt:false }
  } } }
}, { userJid: '584120000001:1@s.whatsapp.net' });
const bytes = proto.Message.encode(msg.message).finish();
const dec = proto.Message.decode(bytes);
const st = dec.audioStickerMessage?.message?.stickerMessage;
console.log('contenido tras relay:', Object.keys(msg.message).join(','));
console.log('decode: sticker', st?.mimetype, st?.width+'x'+st?.height, '| audio', st?.audioMessage?.mimetype, st?.audioMessage?.seconds);
console.log('campo 134 en wire:', bytes.includes(Buffer.from([0xb2, 0x08])) );
if (!st?.audioMessage) { console.error('FALLO'); process.exit(1); }
console.log('TODO OK');
fs.rmSync(dir, { recursive: true, force: true });
