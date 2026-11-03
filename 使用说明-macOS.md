# macOS 使用说明

本仓库原本只带 Windows 的 `启动直播录制.bat`。这里补充 macOS 的启动方式。

## 启动

双击 **`启动直播录制.command`**。

首次双击若提示「无法打开，因为无法验证开发者」，在该文件上 **右键 → 打开 → 打开** 即可。

也可以在终端启动：

```bash
cd ~/Documents/Github/live-auto-recorder
./启动直播录制.command
```

启动后出现仪表盘窗口。**关闭窗口不会停止录制**（最小化到菜单栏托盘继续跑）；真正退出要点菜单栏托盘图标 → 退出。

## 依赖已装好

`node_modules/` 已装好，包含：

- Electron 45.0.0（Electron 运行时，约 115MB）
- ffmpeg-static（内置 arm64 版 ffmpeg 6.0，含 libx264 / libass，转封装可用）

不需要再执行 `npm install`。若日后删除了 `node_modules`，重装命令：

```bash
cd ~/Documents/Github/live-auto-recorder
npm install --registry=https://registry.npmmirror.com/
```

注意：Electron 的二进制下载走 `@electron/get`，它**不读** `HTTP_PROXY` 环境变量。如果处在必须代理的网络里，需要额外指定镜像：

```bash
ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" npm install
```

若仍失败，可手动下载对应平台的 zip 解压到 `node_modules/electron/dist/`，并把可执行文件相对路径写入 `node_modules/electron/path.txt`（macOS 为 `Electron.app/Contents/MacOS/Electron`）。

## 网络与代理（重要）

程序用 **ffmpeg 拉流**。ffmpeg **只认 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量，不读取 macOS 系统代理设置**。

因此如果：

- 你的网络必须挂代理才能访问抖音，或
- 终端里存在失效的代理环境变量（例如指向一个已关闭的本地端口，ffmpeg 会直接拿到 `502 Bad Gateway` 并退出，日志里表现为 `ffmpeg 退出 code=1`、反复「重启新分片续录」）

就会一开播就录不出文件。启动脚本按以下顺序决定代理，**无需手工配置**：

1. 环境变量 `LIVE_RECORDER_PROXY`
2. 自动读取 macOS 系统设置里已启用的 HTTP/HTTPS 代理（`scutil --proxy`）
3. 都没有则直连（同时清空从终端继承来的失效代理）

启动时终端会打印实际使用的代理，例如 `使用代理：http://127.0.0.1:7897`。

如需临时指定：

```bash
LIVE_RECORDER_PROXY=http://127.0.0.1:7897 ./启动直播录制.command
```

排查用命令（把 URL 换成实际直播流地址）：

```bash
./node_modules/ffmpeg-static/ffmpeg -hide_banner -rw_timeout 8000000 -i "https://live.douyin.com/" -f null -
```

- 报 `502 Bad Gateway` → 代理变量有问题
- 报 `Failed to resolve hostname` → DNS/网络不通
- 报 `Invalid data found` → 网络正常（该地址本身不是媒体流，属预期）

## 基本用法

1. 点 **「+ 添加监控」**，粘贴直播间链接（如 `https://live.douyin.com/123456789012`）或纯房间号，可填备注名。
2. 列表里状态显示 `离线 / 直播中 / ● 录制中`，录制中会实时显示时长与文件大小。
3. 主播开播后自动开始录制，下播后自动产出一个文件：`纯享版.mp4`。
4. **「设置」**可调轮询间隔（默认 3 秒）、最大并发、磁盘水位、分段策略、输出目录等。

录像默认保存在仓库下的 `recordings/主播名_房间号/`，可用界面右上角「录像目录」直接打开。

处理完成后文件会重命名为 `日期_主播名_起录时间_直播标题_纯享版.mp4`。

**关闭窗口 = 隐藏到菜单栏托盘**，录制继续。要重新打开界面：点菜单栏的托盘图标，或在 Dock 里点本应用。真正退出请用托盘菜单 → 退出。

## 常见问题

**界面一片空白 / 一直白屏**
Electron 的沙箱在某些受限权限环境下初始化失败。启动脚本已带 `--no-sandbox` 规避。

**窗口跑到别的显示器上找不到**
启动时若窗口位置不在任何屏幕内，会自动移回主屏居中。

**界面显示「录制中」但 `recordings/` 里没有视频文件，日志反复出现 `ffmpeg 退出 code=1`**
拉流失败，按上面的代理章节排查。注意界面上的「录制中」只表示该场次状态，文件为 0 字节说明 ffmpeg 没能从流地址读到数据。

**任务卡在「需检查 / 未完成」**
多为拉流失败导致分片为空。点「重试」，或先按上面的代理章节排查网络。

**想改配置又不想开界面**
直接编辑 `config.json`（保存后 10 秒内热重载，无需重启）。示例：

```json
{
  "watchlist": [
    { "rid": "123456789012", "name": "示例主播" }
  ],
  "settings": {
    "pollIntervalSec": 3,
    "maxConcurrentRecordings": 6,
    "minFreeGB": 5,
    "autoPartMerge": true
  }
}
```

录像只产出一个 MP4，不做额外转码，磁盘占用约为原画大小。

**macOS 上某些功能不可用**
仓库的「开机自启 / 独立守护 / 进程挂起」依赖 Windows 的计划任务与 `ntsuspend`，在 macOS 上不生效，其余录制、后处理功能正常。