'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');

const NCM_MAGIC = Buffer.from('CTENFDAM', 'ascii');
const CORE_KEY = Buffer.from('687a4852416d736f356b496e62617857', 'hex');
const META_KEY = Buffer.from('2331346c6a6b5f215c5d2630553c2728', 'hex');
const MAX_KEY_BYTES = 1024 * 1024;
const MAX_META_BYTES = 8 * 1024 * 1024;
const MAX_COVER_BYTES = 32 * 1024 * 1024;

class NcmError extends Error {
  constructor(message, code = 'INVALID_NCM') {
    super(message);
    this.name = 'NcmError';
    this.code = code;
  }
}

function decryptAesEcb(data, key) {
  try {
    const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
    decipher.setAutoPadding(true);
    return Buffer.concat([decipher.update(data), decipher.final()]);
  } catch (error) {
    throw new NcmError('文件密钥无法解密，可能不是受支持的 NCM 版本。', 'DECRYPT_FAILED');
  }
}

function xorBuffer(data, value) {
  const result = Buffer.allocUnsafe(data.length);
  for (let index = 0; index < data.length; index += 1) {
    result[index] = data[index] ^ value;
  }
  return result;
}

function buildKeyPattern(key) {
  if (!key.length) {
    throw new NcmError('NCM 音频密钥为空。', 'DECRYPT_FAILED');
  }

  const box = Uint8Array.from({ length: 256 }, (_, index) => index);
  let j = 0;
  for (let index = 0; index < 256; index += 1) {
    j = (j + box[index] + key[index % key.length]) & 0xff;
    [box[index], box[j]] = [box[j], box[index]];
  }

  const pattern = Buffer.allocUnsafe(256);
  for (let index = 0; index < 256; index += 1) {
    pattern[index] = box[(box[index] + box[(index + box[index]) & 0xff]) & 0xff];
  }
  return pattern;
}

function xorAudio(data, pattern, startPosition = 0) {
  const result = Buffer.allocUnsafe(data.length);
  for (let index = 0; index < data.length; index += 1) {
    result[index] = data[index] ^ pattern[(startPosition + index + 1) & 0xff];
  }
  return result;
}

function parseMetadata(encryptedMetadata) {
  if (!encryptedMetadata.length) return {};

  try {
    const decoded = xorBuffer(encryptedMetadata, 0x63);
    const prefix = Buffer.from("163 key(Don't modify):", 'ascii');
    const base64Payload = decoded.subarray(prefix.length).toString('ascii');
    const plaintext = decryptAesEcb(Buffer.from(base64Payload, 'base64'), META_KEY);
    const jsonText = plaintext.toString('utf8').replace(/^music:/, '');
    return JSON.parse(jsonText);
  } catch (error) {
    return {};
  }
}

function detectAudioFormat(data, metadata = {}) {
  if (data.length >= 4 && data.subarray(0, 4).equals(Buffer.from('fLaC'))) return 'flac';
  if (data.length >= 3 && data.subarray(0, 3).equals(Buffer.from('ID3'))) return 'mp3';
  if (data.length >= 2 && data[0] === 0xff && (data[1] & 0xe0) === 0xe0) return 'mp3';
  if (data.length >= 4 && data.subarray(0, 4).equals(Buffer.from('OggS'))) return 'ogg';
  if (data.length >= 12 && data.subarray(4, 8).equals(Buffer.from('ftyp'))) return 'm4a';
  if (data.length >= 4 && data.subarray(0, 4).equals(Buffer.from('RIFF'))) return 'wav';

  const declared = String(metadata.format || '').toLowerCase();
  return ['mp3', 'flac', 'ogg', 'm4a', 'wav'].includes(declared) ? declared : 'unknown';
}

async function readExact(handle, position, length, label) {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new NcmError(`${label}长度无效。`);
  }
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) throw new NcmError(`文件不完整：无法读取${label}。`);
  return buffer;
}

async function inspectNcm(filePath) {
  const handle = await fsp.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    if (stat.size < 32) throw new NcmError('文件过小，不是有效的 NCM 文件。');

    const header = await readExact(handle, 0, 8, '文件头');
    if (!header.equals(NCM_MAGIC)) {
      throw new NcmError('文件头不匹配：请选择有效的 .ncm 文件。', 'BAD_MAGIC');
    }

    let offset = 10;
    const keyLengthBuffer = await readExact(handle, offset, 4, '密钥长度');
    const keyLength = keyLengthBuffer.readUInt32LE(0);
    offset += 4;
    if (keyLength <= 0 || keyLength > MAX_KEY_BYTES) throw new NcmError('NCM 密钥区长度异常。');

    const encryptedKey = await readExact(handle, offset, keyLength, '密钥数据');
    offset += keyLength;
    const decryptedKey = decryptAesEcb(xorBuffer(encryptedKey, 0x64), CORE_KEY);
    const audioKey = decryptedKey.subarray(17);
    const pattern = buildKeyPattern(audioKey);

    const metadataLengthBuffer = await readExact(handle, offset, 4, '元数据长度');
    const metadataLength = metadataLengthBuffer.readUInt32LE(0);
    offset += 4;
    if (metadataLength > MAX_META_BYTES) throw new NcmError('NCM 元数据区长度异常。');

    const encryptedMetadata = await readExact(handle, offset, metadataLength, '元数据');
    offset += metadataLength;
    const metadata = parseMetadata(encryptedMetadata);

    const sectionHeader = await readExact(handle, offset, 13, '封面区');
    const coverSpace = sectionHeader.readUInt32LE(5);
    const coverSize = sectionHeader.readUInt32LE(9);
    if (coverSize > MAX_COVER_BYTES) throw new NcmError('NCM 封面数据过大。');

    const coverStart = offset + 13;
    const candidates = [...new Set([coverStart + coverSpace, coverStart + coverSize])]
      .filter((candidate) => candidate >= coverStart && candidate < stat.size);

    let selected;
    for (const candidate of candidates) {
      const encryptedHead = await readExact(handle, candidate, Math.min(32, stat.size - candidate), '音频数据');
      const clearHead = xorAudio(encryptedHead, pattern, 0);
      const format = detectAudioFormat(clearHead);
      if (format !== 'unknown') {
        selected = { audioOffset: candidate, nativeFormat: format };
        break;
      }
    }

    if (!selected && candidates.length) {
      const preferred = coverSpace >= coverSize ? coverStart + coverSpace : coverStart + coverSize;
      const encryptedHead = await readExact(handle, preferred, Math.min(32, stat.size - preferred), '音频数据');
      const clearHead = xorAudio(encryptedHead, pattern, 0);
      selected = {
        audioOffset: preferred,
        nativeFormat: detectAudioFormat(clearHead, metadata),
      };
    }

    if (!selected || selected.nativeFormat === 'unknown') {
      throw new NcmError('无法识别解密后的音频格式。', 'UNSUPPORTED_AUDIO');
    }

    const safeCoverSize = Math.min(coverSize, Math.max(0, stat.size - coverStart));
    const cover = safeCoverSize ? await readExact(handle, coverStart, safeCoverSize, '封面图片') : Buffer.alloc(0);

    return {
      metadata,
      pattern,
      cover,
      audioOffset: selected.audioOffset,
      audioSize: stat.size - selected.audioOffset,
      nativeFormat: selected.nativeFormat,
    };
  } finally {
    await handle.close();
  }
}

class AudioDecryptTransform extends Transform {
  constructor(pattern) {
    super();
    this.pattern = pattern;
    this.position = 0;
  }

  _transform(chunk, encoding, callback) {
    try {
      const output = xorAudio(chunk, this.pattern, this.position);
      this.position += chunk.length;
      callback(null, output);
    } catch (error) {
      callback(error);
    }
  }
}

async function decryptNcmToFile(inputPath, outputPath) {
  const inspected = await inspectNcm(inputPath);
  await pipeline(
    fs.createReadStream(inputPath, { start: inspected.audioOffset }),
    new AudioDecryptTransform(inspected.pattern),
    fs.createWriteStream(outputPath, { flags: 'wx' }),
  );
  return inspected;
}

function normalizeArtists(artistValue) {
  if (!Array.isArray(artistValue)) return String(artistValue || '');
  return artistValue
    .map((artist) => (Array.isArray(artist) ? artist[0] : artist))
    .filter(Boolean)
    .map(String)
    .join(' / ');
}

function metadataArgs(metadata) {
  const entries = [
    ['title', metadata.musicName || metadata.title],
    ['artist', normalizeArtists(metadata.artist || metadata.artists)],
    ['album', metadata.album],
    ['track', metadata.trackNumber],
  ];
  return entries.flatMap(([key, value]) => {
    const cleanValue = String(value || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 1000);
    return cleanValue ? ['-metadata', `${key}=${cleanValue}`] : [];
  });
}

function coverExtension(cover) {
  if (cover.length >= 8 && cover.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return '.png';
  if (cover.length >= 3 && cover.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) return '.jpg';
  return '.img';
}

function runFfmpeg(ffmpegPath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-8000);
    });
    child.on('error', (error) => reject(new NcmError(`无法启动 FFmpeg：${error.message}`, 'FFMPEG_FAILED')));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new NcmError(`音频转码失败：${stderr.trim() || `FFmpeg 退出码 ${code}`}`, 'FFMPEG_FAILED'));
    });
  });
}

function cleanOutputBaseName(value, fallback = 'converted') {
  const clean = String(value || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  return (clean || fallback).slice(0, 160);
}

function suggestedOutputName(metadata, fallbackName) {
  const fallbackBase = path.basename(fallbackName || 'converted', path.extname(fallbackName || ''));
  const title = metadata.musicName || metadata.title;
  const artist = normalizeArtists(metadata.artist || metadata.artists);
  const combined = title ? (artist ? `${artist} - ${title}` : title) : fallbackBase;
  return `${cleanOutputBaseName(combined, fallbackBase)}.mp3`;
}

async function convertNcmToMp3(inputPath, outputPath, options = {}) {
  const ffmpegPath = options.ffmpegPath;
  if (!ffmpegPath) throw new NcmError('未找到本地 FFmpeg。', 'FFMPEG_MISSING');

  const workDirectory = path.dirname(outputPath);
  const nativePath = path.join(workDirectory, 'decrypted.audio');
  const inspected = await decryptNcmToFile(inputPath, nativePath);
  let coverPath;

  if (inspected.cover.length) {
    coverPath = path.join(workDirectory, `cover${coverExtension(inspected.cover)}`);
    await fsp.writeFile(coverPath, inspected.cover, { flag: 'wx' });
  }

  const bitrate = ['192k', '256k', '320k'].includes(options.bitrate) ? options.bitrate : '320k';
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', nativePath];
  if (coverPath) args.push('-i', coverPath, '-map', '0:a:0', '-map', '1:v:0');
  else args.push('-map', '0:a:0', '-vn');

  if (inspected.nativeFormat === 'mp3') args.push('-c:a', 'copy');
  else args.push('-c:a', 'libmp3lame', '-b:a', bitrate);

  if (coverPath) {
    args.push(
      '-c:v', 'mjpeg',
      '-disposition:v:0', 'attached_pic',
      '-metadata:s:v', 'title=Album cover',
      '-metadata:s:v', 'comment=Cover (front)',
    );
  }
  args.push('-id3v2_version', '3', ...metadataArgs(inspected.metadata), outputPath);

  await runFfmpeg(ffmpegPath, args);
  return {
    metadata: inspected.metadata,
    nativeFormat: inspected.nativeFormat,
    outputName: suggestedOutputName(inspected.metadata, options.originalName),
  };
}

module.exports = {
  CORE_KEY,
  META_KEY,
  NCM_MAGIC,
  NcmError,
  buildKeyPattern,
  convertNcmToMp3,
  decryptNcmToFile,
  detectAudioFormat,
  inspectNcm,
  suggestedOutputName,
  xorAudio,
  xorBuffer,
};
