'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const ffmpegPath = require('ffmpeg-static');
const { createSyntheticNcm } = require('../test/helpers');

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

async function main() {
  const outputDirectory = path.resolve(process.argv[2] || '.ui-fixtures');
  await fs.mkdir(outputDirectory, { recursive: true });
  for (const [index, format] of ['mp3', 'flac'].entries()) {
    const audioPath = path.join(outputDirectory, `source-${index + 1}.${format}`);
    const ncmPath = path.join(outputDirectory, `批量测试-${index + 1}.ncm`);
    const codecArgs = format === 'mp3' ? ['-c:a', 'libmp3lame', '-b:a', '128k'] : ['-c:a', 'flac'];
    await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=${440 + index * 220}:duration=0.4`, ...codecArgs, '-y', audioPath]);
    const audio = await fs.readFile(audioPath);
    await fs.writeFile(ncmPath, createSyntheticNcm(audio, format, {
      title: `批量测试歌曲 ${index + 1}`,
      artist: 'NCM Batch',
    }));
    await fs.rm(audioPath, { force: true });
    console.log(ncmPath);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
