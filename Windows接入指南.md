# Windows 接入指南

## 一句话安装（电脑上什么都没有也能用）

把下面这句话整段复制给你的 AI 智能体：

```
帮我安装这个项目：打开 PowerShell 执行
irm https://raw.githubusercontent.com/lastshrek/live-auto-recorder/master/install.ps1 | iex
它会自动装好 Node.js 和项目本身，装完告诉我怎么启动。
```

**不需要预先安装任何东西。** 这条命令会自动完成：

| 步骤 | 做什么 |
|---|---|
| 1 | 检查 Node.js，没有就自动下载官方 MSI 并静默安装 |
| 2 | 下载项目代码（zip，**不需要 git**） |
| 3 | 安装依赖（自动走国内镜像，约 300MB） |
| 4 | 自检并打印启动方式 |

全程约 5–10 分钟，取决于网速。装完后脚本会问你要不要立刻启动。

### 如果智能体不能执行命令

那就在自己电脑上操作，同样一句话：

1. 按 `Win + X`，选「Windows PowerShell」或「终端」
2. 粘贴下面这行，回车：

```powershell
irm https://raw.githubusercontent.com/lastshrek/live-auto-recorder/master/install.ps1 | iex
```

### 这个脚本为什么能在"零环境"上跑

Windows 10/11 自带：PowerShell 5.1、msiexec（装 MSI）、.NET WebClient（下载）、
Expand-Archive（解压）。脚本只用这些，不依赖 git、Python 或任何第三方工具。

装好后项目会放在 `%USERPROFILE%\live-auto-recorder`。

### 安装位置可以改

默认 `%USERPROFILE%\live-auto-recorder`。想换位置就先手动下脚本再执行：

```powershell
# 改这两行里的路径即可
$env:LR_INSTALL_DIR = "D:\live-auto-recorder"
irm https://raw.githubusercontent.com/lastshrek/live-auto-recorder/master/install.ps1 | iex
```

---

## 0. 一句话概述

抖音直播自动监控 + 原画录制工具。添加主播后，开播自动录制，下播自动转封装、
校验、合并、按需拆分成上传分段；可选本地生成字幕（离线，不上传音频）。

**它不破解 DRM，不下载历史视频，只录正在直播的公开内容。**

---

## 1. 环境要求

| 项目 | 要求 | 检查命令 |
|---|---|---|
| Windows | 10 / 11（64 位） | `ver` |
| Node.js | **22.12 或更高** | `node -v` |
| 磁盘可用 | ≥ 20 GB | — |
| Python | 3.9+（**仅字幕功能需要，推荐 3.12**） | `python --version` |

**Node 版本是硬性要求。** `electron@45` 声明 `engines: >= 22.12.0`，低于此版本
`npm install` 会直接报错退出。

**Python 是可选的。** 不装也能完整录制，只是「转字幕」按钮会提示环境未安装。

### 安装 Node.js（若未安装）

```powershell
winget install OpenJS.NodeJS.LTS
```

或从 https://nodejs.org/ 下载 LTS 版本。**安装后需重开终端**才能识别 `node` 命令。

### 安装 Python（若需要字幕）

```powershell
winget install Python.Python.3.12
```

关键：安装时**必须勾选 "Add Python to PATH"**，否则脚本找不到解释器。

---

## 2. 安装步骤（智能体按序执行）

### 2.1 获取代码

```powershell
git clone https://github.com/lastshrek/live-auto-recorder.git
cd live-auto-recorder
```

无 git 时可下载 ZIP 解压，效果相同。

### 2.2 配置 npm 镜像（国内网络必做）

`npm install` 需要从 GitHub Release 下载 Electron 与 ffmpeg，**国内直连会失败**。

```powershell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
npm config set registry https://registry.npmmirror.com
```

### 2.3 一键安装（推荐）

```powershell
npm run install:win
```

这一条命令覆盖了 2.2 到 2.4 的全部内容，并且带验证。下面是手动方式的说明，
供排查问题时参考。

### 2.3.1 手动安装依赖

```powershell
npm install
```

预期耗时 2–5 分钟，下载约 300 MB。

**验收标准**：命令成功退出，且以下三项存在

```powershell
Test-Path node_modules\electron\dist\electron.exe   # 应为 True
Test-Path node_modules\ffmpeg-static\ffmpeg.exe      # 应为 True
```

若 `ffmpeg.exe` 缺失，见「故障排查 → ffmpeg 下载失败」。

### 2.4 启动

```powershell
npm start
```

或双击目录下的 `启动直播录制.bat`。

**验收标准**：出现标题为「直播自动录制」的窗口，右下角托盘出现红色圆点图标。

### 2.5 字幕功能（可选）

```powershell
npm run transcribe:check    # 先体检
npm run transcribe:setup    # 再安装（下载约 850 MB）
```

**验收标准**：`transcribe:check` 输出「环境就绪，可以直接转写。」

---

## 3. 首次使用

1. 主界面顶部输入框粘贴直播间链接或房间号，例如
   `https://live.douyin.com/123456789012` 或 `123456789012`
2. 点「添加监控」
3. 主播开播时会自动开始录制，状态列显示 `● 录制中`

**关于登录：** 部分直播间需要登录态才能取流。若提示会话异常，点界面上的
「扫码登录」手动登录一次，登录态会被复用。

---

## 4. 功能全清单

### 4.1 监控与录制

| 功能 | 说明 |
|---|---|
| 多主播并发监控 | 默认每 3 秒轮询一轮，可调 |
| 并发录制上限 | 默认 6 路，超出排队 |
| 画质选择 | `highest` 原画 / `lowest` 最省空间 / 指定档位 |
| 断流续录 | 断流自动换新分片，重连后继续，最后合并回一个文件 |
| 分段录制 | 按分钟或按文件大小切分，`0` 表示整场不分段 |
| 磁盘水位保护 | 剩余低于阈值时不再开新录制 |
| 定时免打扰 | 设定时段内不启动后处理任务（录制不受影响） |

### 4.2 后处理（录制结束自动执行）

```
转封装 FLV→MP4 → 完整性校验 → 分片合并 → 超大文件拆分 → 统一命名
```

- **校验通过才动源文件**。校验失败一律保留原文件，并在界面/日志说明原因
- 超过 15.5 GB 的成片按关键帧拆成上传分段，原文件归档保留

### 4.3 崩溃恢复

- 断电、强杀、崩溃后重启，未完成任务自动接着做
- 可结束本应用遗留的 ffmpeg 进程（三条件精确匹配，不按进程名批量杀）

### 4.4 字幕（可选）

| 功能 | 说明 |
|---|---|
| 本地离线转写 | 音频不出本机，全程无网络请求 |
| 方言支持 | 支持 22 种中文方言 + 31 种语言，保留方言原词 |
| 输出格式 | `.srt` 字幕 + `.txt` 纯文本，与视频同目录 |
| 热词 | 自动从主播名推导；可手动指定提升专名准确率 |
| 触发方式 | 录完自动（需开启）/ 界面按钮手动 / 命令行批量 |

### 4.5 其他

| 功能 | 说明 |
|---|---|
| 托盘常驻 | 关窗不退出，继续后台录制 |
| 开机自启 | 可选 |
| 防止休眠 | 录制期间阻止系统睡眠，可选 |
| 系统通知 | 开播 / 录完 / 磁盘不足 / 会话异常 |
| Webhook | 事件推送，见 5.4 |
| 录像保留期 | 按天自动清理，`0` 表示永久 |
| 公司分组 | 可按公司/团队归类主播 |
| 主页批量导入 | 粘贴博主主页链接，自动导入其直播间 |

---

## 5. 配置说明

配置文件：项目根目录 `config.json`。也可在界面「设置」中修改，改动热重载生效（约 10 秒）。

### 5.1 常用设置

| 键 | 默认值 | 说明 |
|---|---|---|
| `pollIntervalSec` | `3` | 轮询间隔秒数，范围 1–10 |
| `maxConcurrentRecordings` | `6` | 同时录制路数，范围 1–20 |
| `minFreeGB` | `5` | 剩余空间低于此值不再开新录制 |
| `outputDir` | `recordings` | 录像保存目录。相对路径按安装目录解析，也可填绝对路径如 `D:\录像` |
| `quality` | `highest` | `highest` / `lowest` / `FULL_HD1` / `HD1` / `SD1` / `SD2` |
| `segment` | `0` | `0`=整场；`90`=90 分钟一段；`500MB`=按大小分段 |
| `minSizeMB` | `0` | 小于此值的录像跳过处理（0=不跳过） |
| `autoPartMerge` | `true` | 断流分片自动合并回一个文件 |
| `postConcurrency` | `2` | 后处理并发数，范围 1–4 |
| `keepDays` | `0` | 录像保留天数，0=永久 |
| `preventSleep` | `false` | 录制期间阻止系统休眠 |
| `autoStart` | `false` | 开机自启 |
| `autoTranscribe` | `false` | 录完自动转字幕 |
| `postQuietEnabled` | `false` | 启用后处理静音时段 |
| `postQuietStart` / `postQuietEnd` | `23:00` / `08:00` | 静音时段（可跨午夜） |
| `webhookUrl` | `""` | 事件推送地址，见 5.4 |

### 5.2 改保存位置

界面「设置 → 保存路径」可直接改，右边「浏览…」弹出系统选目录对话框。
输入框下方实时显示该目录是否可用和剩余空间，**保存前就验证，不必等开录才发现存不进去**。

| 情况 | 行为 |
|---|---|
| 目录不存在 | 自动创建（含多级） |
| 目录不可写 | 保存时直接拒绝，并说明原因（权限 / 只读 / 空间不足） |
| 正在录制时改 | **不允许**。输入框与「浏览…」置灰，提示等录制结束 |
| 改后看旧录像 | 照常能看，历史记录里存了每场所属目录 |
| 改回原路径 | 旧录像立刻回来 |

> 放在 `C:\Program Files` 下会因写入需要提权而失败，程序会在保存时明确拦下。
> 建议放在 `D:\录像` 这类普通目录。

### 5.3 主播项字段

`config.json` 的 `watchlist` 数组，每项支持：

| 字段 | 说明 |
|---|---|
| `rid` | 房间号（6–13 位数字），必填 |
| `secUid` | 主页导入时使用 |
| `name` / `nickname` | 备注名 / 真实昵称 |
| `companyId` | 所属公司分组 |
| `titleFilter` | 只录标题包含该关键词的场次 |
| `hours` | 值守时段，如 `20:00-23:00` |
| `maxSec` | 单场最长录制秒数，0=不限 |
| `monitorPaused` | 暂停该主播的监控 |

### 5.4 Webhook

开启后在 `webhookUrl` 填入公网地址，事件以 JSON POST 推送。

**支持的事件**：`live`（开播）、`record-done`（录完）、`record-error`、
`diskfull`（磁盘不足）、`session-bad`（会话异常）、`post`、`transcribe`、
`paused`、`resumed`、`history`。

⚠️ **地址限制**：仅接受公网 http/https。`localhost`、`127.x`、`10.x`、
`192.168.x`、`172.16–31.x`、`*.local`、`*.internal` 会被拒绝。这是防止
SSRF 的安全设计，不是 bug。本地调试请用公网隧道。

---

## 6. 产物说明

### 目录结构

```
recordings/
  主播名_房间号/
    2026-11-04_主播名_20-15-33_直播标题_纯享版.mp4
    2026-11-04_主播名_20-15-33_直播标题_纯享版.srt   ← 如启用字幕
    2026-11-04_主播名_20-15-33_直播标题_纯享版.txt
```

同一房间复用同一目录，主播改名不会分裂。

### 命名规则

`日期_主播名_起录时间_直播标题_纯享版.mp4`

- 日期时间取**起录时刻**（上海时间）
- 非法字符替换，过长截短，同名自动加序号，**绝不覆盖已有文件**
- 跨午夜两条规则：
  1. **起录在 06:00 之前** → 日期加「凌晨」
  2. **跨午夜且结束在 09:00 之前** → 归到结束日并加「凌晨」

---

## 7. 命令行速查

```powershell
npm start                                  # 启动
npm test                                   # 跑测试
npm run dist:win                           # 打 Windows 安装包（产物在 dist/）

npm run transcribe:check                   # 字幕环境体检
npm run transcribe:setup                   # 安装字幕环境
npm run transcribe -- "录像.mp4"            # 转单个文件
npm run transcribe -- recordings\主播名 --all   # 转整个目录（递归）
npm run transcribe -- "录像.mp4" --hotwords "商品名,人名"
```

转写参数：

| 参数 | 说明 |
|---|---|
| `--all` | 递归处理子目录 |
| `--hotwords "词1,词2"` | 手动指定热词（默认自动从主播名推导） |
| `--no-auto-hotwords` | 关闭自动热词 |
| `--threads N` | 线程数，默认 CPU 核数减一 |
| `--max-speech N` | 单段最长秒数，默认 15 |
| `--no-srt` / `--no-txt` | 只要一种输出 |
| `--keep-audio` | 保留临时音频，便于排查 |

---

## 8. 故障排查

### 一键安装：提示「在此系统上禁止运行脚本」

PowerShell 默认的执行策略会拦截脚本。用这行命令绕过（只影响当前进程）：

```powershell
powershell -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/lastshrek/live-auto-recorder/master/install.ps1 | iex"
```

若提示「无法识别 irm」，说明 PowerShell 版本过旧，改用完整写法：

```powershell
powershell -ExecutionPolicy Bypass -Command "Invoke-RestMethod https://raw.githubusercontent.com/lastshrek/live-auto-recorder/master/install.ps1 | Invoke-Expression"
```

### 一键安装：卡在「正在安装 Node.js」

`msiexec` 静默安装偶尔会被系统策略或安全软件拦截，表现为长时间无反应。

处理办法：**手动装 Node.js 后重跑同一条命令**。脚本是幂等的，检测到已装好会跳过这一步。

```powershell
winget install OpenJS.NodeJS.LTS
```

装完**关掉 PowerShell 重开**再执行一次安装命令。若 `winget` 也没有，
到 https://nodejs.org/ 下载 LTS 的 `.msi` 手动安装，安装时保持默认选项。

### 一键安装：Node 装好了但仍提示版本过低

MSI 安装后当前会话的 PATH 不会立刻刷新。脚本会自动从注册表重新读取，
但极少数情况下仍取不到。此时**关闭 PowerShell 窗口重新打开**，再跑一次即可。

### 一键安装：下载项目代码失败

GitHub 在国内可能无法直连。两个办法：

1. 挂代理后重试
2. 用浏览器打开下面地址下载 zip，解压到 `%USERPROFILE%\live-auto-recorder`
   ```
   https://github.com/lastshrek/live-auto-recorder/archive/refs/heads/master.zip
   ```
   然后在该目录下执行 `npm run install:win`

### npm install 报 Electron 下载失败

```powershell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
npm install --force
```

### ffmpeg 下载失败

`node_modules\ffmpeg-static\ffmpeg.exe` 不存在，程序无法录制。

方案一（推荐）挂代理后重试 `npm install`。

方案二手动补：下载
`https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-win32-x64.gz`
解压得到 `ffmpeg.exe`，放到 `node_modules\ffmpeg-static\` 下。

### 双击 .bat 闪退

`启动直播录制.bat` 只是 `node_modules\electron\dist\electron.exe` 的快捷方式。
未执行 `npm install` 时该文件不存在，必然闪退。先跑 `npm install`。

### 提示「磁盘空间不足」但磁盘明明有空间

旧版本在空间查询失败时会返回 0，导致误报。当前版本已修复（查不到时跳过检查）。
先确认版本：`git log --oneline -1`，若为旧版本请 `git pull`。

### 录制目录无权限

**不要放在 `C:\Program Files`。** 那里写入需要管理员权限，会导致录像失败。
换到 `D:\live-auto-recorder` 这类普通目录。

### 转写环境装不上

1. 确认 Python 版本：`python --version`，建议 3.12
2. 换镜像重试：
   ```powershell
   $env:LR_PIP_INDEX="https://pypi.tuna.tsinghua.edu.cn/simple"
   npm run transcribe:setup
   ```
3. 运行 `npm run transcribe:check` 看具体缺什么

### 暂停后处理任务报错「缺少 ntsuspend」

`ntsuspend` 是可选依赖，国内网络常装不上。**不影响录制**，只失去
「暂停后处理任务」这一个能力。需要该功能时挂代理重装依赖。

### 应用启动后界面空白

多为 GPU 驱动兼容问题。Electron 支持通过启动参数关闭硬件加速，
用命令行启动并加参数即可（程序本身不读取该环境变量）：

```powershell
.\node_modules\electron\dist\electron.exe . --disable-gpu
```

---

## 9. 给智能体的执行清单

按顺序执行，每步验证通过再进下一步：

**优先走一键脚本**（它已包含版本检查、镜像配置、依赖安装与验证）：

```
[ ] 1. node -v                → >= 22.12，不满足则先装 Node
[ ] 2. git clone <仓库地址>
[ ] 3. npm run install:win    → 退出码 0，末尾显示「启动方式」
[ ] 4. npm start              → 出现「直播自动录制」窗口
[ ] 5.（可选）npm run transcribe:setup  → 需要字幕时
```

脚本内部的 5 个阶段（出问题时按此定位）：

```
[1/5] 检查 Node.js 版本      → 低于 22.12 会直接退出并给出升级命令
[2/5] 安装项目依赖            → 自动用国内镜像下 Electron 与 ffmpeg
[3/5] 验证关键文件            → electron.exe / ffmpeg.exe 必须存在
[4/5] 准备配置文件            → 检查录像目录可写
[5/5] 运行自检                → 字幕环境（可选）+ 主进程代码完整性
```

**任一步失败时的处理原则**：

- 不要凭猜测改参数，先看对应「故障排查」条目
- 不要跳过 `npm install` 直接运行（会闪退）
- 不要修改 `package.json` 里的版本号来「绕过」Node 版本检查，会引入不兼容
- 需要更多细节时读项目 `README.md`，它是完整技术文档

---

## 10. 能力边界

以下事情**不做**，避免误解：

- 不下载已结束的历史直播
- 不破解付费/加密直播
- 不绕过平台的登录与风控（需要登录时会提示手动扫码）
- 不做视频转码压缩（录制是 `-c copy` 直拷，画质无损）
- 转字幕不做逐字时间戳，精度到「句」

---

## 附：仓库地址

```
https://github.com/lastshrek/live-auto-recorder
```