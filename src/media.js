import { execFile } from 'child_process';
import fs from 'fs';
import { inyectarExif } from './exif.js';

// [lado px, calidad, fps]; de mayor a menor peso hasta entrar en el limite.
const ESCALERA = [
  [512, 45, 12],
  [448, 38, 10],
  [384, 32, 10],
  [320, 28, 8],
  [256, 24, 8]
];

// method/compression_level bajo = codificación mucho más rápida (el archivo pesa algo más).
const NIVEL_COMPRESION = String(process.env.NIVEL_COMPRESION ?? 1);

function correr(bin, args, timeout = 120_000) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${bin}: ${String(stderr || err.message).trim().split('\n').slice(-2).join(' | ')}`));
      else resolve(stdout);
    });
  });
}

export async function sondear(archivo) {
  const salida = await correr('ffprobe', [
    '-v', 'error',
    '-show_entries', 'stream=codec_type,width,height',
    '-show_entries', 'format=duration',
    '-of', 'json',
    archivo
  ]);
  const j = JSON.parse(salida);
  const v = (j.streams || []).find((s) => s.codec_type === 'video');
  return {
    tieneAudio: (j.streams || []).some((s) => s.codec_type === 'audio'),
    duracion: parseFloat(j.format?.duration || '0'),
    ladoMin: v?.width && v?.height ? Math.min(v.width, v.height) : 512
  };
}

// modo 'recortar' = cuadrado lleno; 'bordes' = conserva todo el cuadro con transparencia
export async function videoAWebp(entrada, salida, { segundos, maxBytes, exif, modo = 'recortar', ladoMin = 512 }) {
  // Nunca se agranda por encima de la resolución real del video (agrandar solo hace el proceso más lento).
  const tope = Math.max(256, Math.floor(Math.min(512, ladoMin) / 2) * 2);
  for (const [ladoEsc, calidad, fps] of ESCALERA) {
    const lado = Math.min(ladoEsc, tope);
    const filtro =
      modo === 'bordes'
        ? `fps=${fps},scale=${lado}:${lado}:flags=fast_bilinear:force_original_aspect_ratio=decrease,format=rgba,pad=${lado}:${lado}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`
        : `fps=${fps},scale=${lado}:${lado}:flags=fast_bilinear:force_original_aspect_ratio=increase,crop=${lado}:${lado}`;

    await correr('ffmpeg', [
      '-nostdin', '-loglevel', 'error', '-y',
      '-t', String(segundos),
      '-i', entrada,
      '-vf', filtro,
      '-c:v', 'libwebp_anim',
      '-lossless', '0',
      '-q:v', String(calidad),
      '-compression_level', NIVEL_COMPRESION,
      '-loop', '0',
      '-preset', 'default',
      '-an',
      salida
    ]);

    const webp = inyectarExif(fs.readFileSync(salida), exif, { ancho: lado, alto: lado });
    console.log(`WebP ${webp.length} bytes (${lado}px q=${calidad} fps=${fps})`);
    if (webp.length <= maxBytes) return { webp, lado };
  }
  throw new Error(`El sticker supera ${maxBytes} bytes incluso con la compresion maxima`);
}

// Opus mono 32 kbps en dos pasadas (estereo 64k -> mono 32k): evita "no se pudo reproducir el sonido".
export async function videoAOpus(entrada, salida, { segundos }) {
  const intermedio = `${salida}.paso1.ogg`;
  try {
    await correr('ffmpeg', [
      '-nostdin', '-loglevel', 'error', '-y',
      '-i', entrada, '-vn', '-t', String(segundos),
      '-c:a', 'libopus', '-b:a', '64k', intermedio
    ]);
    await correr('ffmpeg', [
      '-nostdin', '-loglevel', 'error', '-y',
      '-i', intermedio, '-ac', '1',
      '-c:a', 'libopus', '-b:a', '32k', salida
    ]);
    const buf = fs.readFileSync(salida);
    if (!buf.length) throw new Error('audio vacio');
    return buf;
  } finally {
    try { fs.unlinkSync(intermedio); } catch {}
  }
}
