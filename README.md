# NCM Batch Converter

本地批量 NCM → MP3 Web App。文件只发送到本机 `127.0.0.1` 服务，不会上传到云端。

![Node.js](https://img.shields.io/badge/Node.js-20%2B-5FA04E?logo=nodedotjs&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-blue)

## 使用

1. 双击 `start.bat`。
2. 浏览器会自动打开 `http://127.0.0.1:3210`。
3. 拖入或批量选择 `.ncm` 文件。
4. 输出目录默认是项目内的 `output` 文件夹；点击路径可更改。
5. 点击“开始转换”，结果会由本地服务直接写入所选目录。

停止服务时，关闭命令行窗口或按 `Ctrl+C`。

## 特性

- 多文件拖放和批量选择
- 两个任务并行处理，逐项显示进度和错误
- NCM 内是 MP3 时无损复制音频流
- NCM 内是 FLAC/其他受 FFmpeg 支持的格式时，真正转码为 MP3
- 支持 192 / 256 / 320 kbps
- 本地服务直接保存到明确的输出目录，位置会持久化
- 尽可能保留歌名、歌手、专辑和封面
- 大文件采用流式读写，临时文件在响应完成后自动清理

## 开发

需要 Node.js 20+。

```powershell
npm install
npm test
npm start
```

## 项目结构

- `server.js`：本地 HTTP 服务、输出目录和 FFmpeg 调用
- `src/ncm.js`：NCM 解析、流式解密与元数据处理
- `public/`：批量转换界面
- `test/`：MP3 / FLAC 合成 NCM 自动化测试

## 致谢

NCM 文件格式与解密流程参考了开源项目 [taurusxin/ncmdump](https://github.com/taurusxin/ncmdump)。FFmpeg 由 [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) 提供。第三方组件分别遵循其自身许可证。

## 使用边界

请只转换本人合法下载、拥有使用权的音频文件，不要传播转换后的受版权保护内容。

## License

[MIT](LICENSE)
