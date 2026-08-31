'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const ffmpegPath = require('ffmpeg-static');
const { convertNcmToMp3, decryptNcmToFile, inspectNcm } = require('../src/ncm');
const { createSyntheticNcm } = require('./helpers');

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(stderr || `exit ${code}`)));
  });
}

test('decrypts a synthetic NCM without loading audio into memory', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ncm-unit-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const clearAudio = Buffer.concat([Buffer.from('ID3'), crypto.randomBytes(4096)]);
  const input = path.join(directory, 'input.ncm');
  const output = path.join(directory, 'output.mp3');
  await fs.writeFile(input, createSyntheticNcm(clearAudio, 'mp3', { coverSpace: 24 }));

  const inspected = await inspectNcm(input);
  assert.equal(inspected.nativeFormat, 'mp3');
  assert.equal(inspected.metadata.musicName, '测试歌曲');
  await decryptNcmToFile(input, output);
  assert.deepEqual(await fs.readFile(output), clearAudio);
});

test('rejects files with the wrong magic header', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ncm-invalid-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const input = path.join(directory, 'bad.ncm');
  await fs.writeFile(input, Buffer.alloc(64));
  await assert.rejects(() => inspectNcm(input), /文件头不匹配/);
});

for (const sourceFormat of ['mp3', 'flac']) {
  test(`creates a playable MP3 from synthetic ${sourceFormat.toUpperCase()} NCM`, { timeout: 30000 }, async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), `ncm-${sourceFormat}-`));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const sourceAudio = path.join(directory, `source.${sourceFormat}`);
    const inputNcm = path.join(directory, 'source.ncm');
    const outputMp3 = path.join(directory, 'output.mp3');

    const codecArgs = sourceFormat === 'mp3' ? ['-c:a', 'libmp3lame', '-b:a', '128k'] : ['-c:a', 'flac'];
    await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.2', ...codecArgs, '-y', sourceAudio]);
    const audio = await fs.readFile(sourceAudio);
    await fs.writeFile(inputNcm, createSyntheticNcm(audio, sourceFormat));

    const result = await convertNcmToMp3(inputNcm, outputMp3, {
      ffmpegPath,
      bitrate: '192k',
      originalName: 'source.ncm',
    });
    assert.equal(result.nativeFormat, sourceFormat);
    assert.match(result.outputName, /测试歌手 - 测试歌曲\.mp3$/);
    await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-i', outputMp3, '-f', 'null', '-']);
    assert.ok((await fs.stat(outputMp3)).size > 1000);
  });
}
