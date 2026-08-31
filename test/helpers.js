'use strict';

const crypto = require('node:crypto');
const {
  CORE_KEY,
  META_KEY,
  NCM_MAGIC,
  buildKeyPattern,
  xorAudio,
  xorBuffer,
} = require('../src/ncm');

function encryptAesEcb(data, key) {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

function uint32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

function createSyntheticNcm(audio, format, options = {}) {
  const audioKey = Buffer.from('batch-converter-test-key');
  const keyPlaintext = Buffer.concat([Buffer.from('neteasecloudmusic'), audioKey]);
  const keyData = xorBuffer(encryptAesEcb(keyPlaintext, CORE_KEY), 0x64);
  const metadata = {
    musicName: options.title || '测试歌曲',
    artist: [[options.artist || '测试歌手', 1]],
    album: '测试专辑',
    format,
  };
  const metaPlaintext = Buffer.from(`music:${JSON.stringify(metadata)}`);
  const metaBase64 = encryptAesEcb(metaPlaintext, META_KEY).toString('base64');
  const metaData = xorBuffer(Buffer.from(`163 key(Don't modify):${metaBase64}`), 0x63);
  const cover = options.cover || Buffer.alloc(0);
  const coverSpace = options.coverSpace ?? cover.length;
  const coverPadding = Buffer.alloc(Math.max(0, coverSpace - cover.length));
  const pattern = buildKeyPattern(audioKey);
  const encryptedAudio = xorAudio(audio, pattern);

  return Buffer.concat([
    NCM_MAGIC,
    Buffer.alloc(2),
    uint32(keyData.length),
    keyData,
    uint32(metaData.length),
    metaData,
    Buffer.alloc(5),
    uint32(coverSpace),
    uint32(cover.length),
    cover,
    coverPadding,
    encryptedAudio,
  ]);
}

module.exports = { createSyntheticNcm };
