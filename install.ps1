# 直播自动录制 · Windows 一键安装
#
# 用途：在"什么环境都没有"的 Windows 10/11 上完成全部安装。
#
# 用法（在 PowerShell 里执行）：
#   irm https://raw.githubusercontent.com/lastshrek/live-auto-recorder/master/install.ps1 | iex
#
# 它做四件事：
#   1. 检查 Node.js，没有就自动下载 MSI 并静默安装
#   2. 下载项目代码（zip，不需要 git）
#   3. 运行项目内的逻辑安装（npm run install:win）
#   4. 打印启动方式
#
# 为什么用 PowerShell 而不是 .bat：
#   .bat 处理 HTTP 下载、解压、错误处理都很别扭，且中文编码容易出问题。
#   PowerShell 5.1 是 Win7 起就自带的，能力足够。
#
# 兼容性目标：Windows PowerShell 5.1（不是 PowerShell 7），
# 因此不使用 ?? / ?. / -Parallel 等 PS7 语法。

$ErrorActionPreference = 'Stop'

# ---------- 显示 ----------

function Write-Step($n, $total, $msg) {
    Write-Host ""
    Write-Host "[$n/$total] $msg" -ForegroundColor Cyan
}
function Write-Ok($msg)   { Write-Host "  OK  $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "  !   $msg" -ForegroundColor Yellow }
function Write-Info($msg) { Write-Host "      $msg" -ForegroundColor Gray }
function Fail($msg, $hint) {
    Write-Host ""
    Write-Host "[失败] $msg" -ForegroundColor Red
    if ($hint) { Write-Host ""; Write-Host $hint -ForegroundColor Yellow }
    exit 1
}

# ---------- 环境 ----------

# 本脚本只面向 Windows。在其它平台提前退出并说明原因，
# 避免出现 Join-Path 收到 null 路径这类难以理解的报错。
if (-not $env:USERPROFILE) {
    Write-Host ""
    Write-Host "[提示] 本脚本用于 Windows 安装。" -ForegroundColor Yellow
    Write-Host "      当前平台缺少 USERPROFILE 环境变量，请在 Windows 上运行。" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "      如果你用的是 macOS 或 Linux，请用另一种方式：" -ForegroundColor Gray
    Write-Host "        git clone <项目地址> && cd live-auto-recorder && npm install && npm start" -ForegroundColor Gray
    exit 1
}

# PowerShell 5.1 默认可能用 TLS 1.0，访问 GitHub / nodejs.org 会失败
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
} catch {
    Write-Warn "无法设置 TLS 1.2，下载可能失败"
}

$TOTAL = 4
$REPO_ZIP   = 'https://github.com/lastshrek/live-auto-recorder/archive/refs/heads/master.zip'
$NODE_VER   = '22.23.4'
$NODE_MSI   = "node-v$NODE_VER-x64.msi"
$NODE_URLS  = @(
    "https://npmmirror.com/mirrors/node/v$NODE_VER/$NODE_MSI",
    "https://nodejs.org/dist/v$NODE_VER/$NODE_MSI"
)
# 安装位置可通过环境变量覆盖；默认放在用户目录，避免 C:\Program Files 的写入权限问题
$INSTALL_DIR = if ($env:LR_INSTALL_DIR) {
    $env:LR_INSTALL_DIR
} else {
    Join-Path $env:USERPROFILE 'live-auto-recorder'
}
$TEMP_DIR    = Join-Path $env:TEMP ("lr-install-" + [Guid]::NewGuid().ToString('N').Substring(0,8))

Write-Host ""
Write-Host "=== 直播自动录制 · Windows 一键安装 ===" -ForegroundColor White
Write-Info "系统: $([Environment]::OSVersion.VersionString)"
Write-Info "目标目录: $INSTALL_DIR"

New-Item -ItemType Directory -Force -Path $TEMP_DIR | Out-Null

# ---------- 自适应下载 ----------
# Windows 自带的 Invoke-WebRequest 在 PS5.1 上处理大文件极慢（进度条拖累），
# 用 .NET 的 WebClient 快得多；同时保留 fallback 以兼容受限环境。
function Download-File($urls, $dest, $label) {
    # 下载前先删掉同名残留：否则失败时旧文件会让下面的存在性判断误判成功
    if (Test-Path $dest) { Remove-Item $dest -Force -ErrorAction SilentlyContinue }
    foreach ($u in $urls) {
        try {
            Write-Info "尝试 $u"
            $sw = [Diagnostics.Stopwatch]::StartNew()
            $wc = New-Object System.Net.WebClient
            $wc.Headers.Add('User-Agent', 'Mozilla/5.0')
            $wc.DownloadFile($u, $dest)
            $wc.Dispose()
            $sw.Stop()
            # 只判断"文件存在且非空"。早先用 >1024 字节做阈值，
            # 会把 package.json 这类小文件误判为失败（实测 961 字节被拒）。
            if ((Test-Path $dest) -and ((Get-Item $dest).Length -gt 0)) {
                $size = (Get-Item $dest).Length
                $mb = [math]::Round($size / 1MB, 1)
                $sec = [math]::Round($sw.Elapsed.TotalSeconds, 1)
                if ($size -ge 1MB) {
                    Write-Ok "$label 已下载（$mb MB，$sec 秒）"
                } else {
                    Write-Ok "$label 已下载（$([math]::Round($size/1KB,1)) KB，$sec 秒）"
                }
                return $true
            }
            Write-Warn '下载完成但文件为空，换下一个源'
        } catch {
            Write-Warn "该源失败：$($_.Exception.Message)"
        }
    }
    return $false
}

# ---------- 1. 检查 / 安装 Node.js ----------

function Get-NodeVersion {
    # 每次现查，不缓存：刚装完 MSI 后同一进程内 PATH 可能还没刷新
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $cmd) { return $null }
    try {
        $v = & node -v 2>$null
        if ($v -match 'v(\d+)\.(\d+)') {
            return @{ Major = [int]$Matches[1]; Minor = [int]$Matches[2]; Raw = $v.Trim() }
        }
    } catch { }
    return $null
}

# 装完 MSI 后需要刷新 PATH，否则当前会话找不到 node
function Update-PathFromRegistry {
    $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $userPath    = [Environment]::GetEnvironmentVariable('Path', 'User')
    # 注意：不能写成 ($machinePath, $userPath -join ';')，
    # PowerShell 会把 -join 只作用到 $userPath，前面数组被转成 "System.Object[]"
    $parts = @()
    if ($machinePath) { $parts += $machinePath }
    if ($userPath)    { $parts += $userPath }
    if ($parts.Count -gt 0) { $env:Path = ($parts -join ';') }
}

Write-Step 1 $TOTAL '检查 Node.js'

$node = Get-NodeVersion
if ($node -and ($node.Major -gt 22 -or ($node.Major -eq 22 -and $node.Minor -ge 12))) {
    Write-Ok "已安装 Node.js $($node.Raw)"
} else {
    if ($node) {
        Write-Warn "当前 Node.js $($node.Raw) 版本过低（需要 22.12+），将安装新版本"
    } else {
        Write-Info '未检测到 Node.js，开始自动安装'
    }

    $msi = Join-Path $TEMP_DIR $NODE_MSI
    if (-not (Download-File $NODE_URLS $msi "Node.js $NODE_VER")) {
        Fail 'Node.js 下载失败' @"
请手动安装 Node.js 后重新运行本脚本：
  1. 打开 https://nodejs.org/ 下载 LTS 版本（.msi）
  2. 安装时保持默认选项，确保勾选 "Add to PATH"
  3. 安装完成后关掉 PowerShell 重开，再运行本脚本
"@
    }

    Write-Info '正在安装（约 1-2 分钟，无窗口弹出属正常）…'
    # /qn = 静默，norestart = 不自动重启
    $p = Start-Process -FilePath 'msiexec.exe' `
        -ArgumentList "/i `"$msi`" /qn /norestart" `
        -Wait -PassThru
    if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) {
        # 3010 = 成功但需要重启，通常也能直接用
        Fail "Node.js 安装失败（msiexec 退出码 $($p.ExitCode)）" `
             '可尝试右键本脚本"以管理员身份运行"，或手动安装 Node.js'
    }
    Update-PathFromRegistry
    Start-Sleep -Seconds 2
    $node = Get-NodeVersion
    if (-not $node) {
        Fail 'Node.js 安装后仍无法识别' @"
MSI 装好了但当前会话取不到 node 命令。
请关闭 PowerShell 重新打开，再运行一次本脚本 —— 此时会直接跳过安装步骤。
"@
    }
    Write-Ok "Node.js 安装成功（$($node.Raw)）"
}

# ---------- 2. 下载项目 ----------

Write-Step 2 $TOTAL '下载项目代码'

if (Test-Path (Join-Path $INSTALL_DIR 'package.json')) {
    Write-Ok '项目目录已存在，复用现有代码'
} else {
    $zip = Join-Path $TEMP_DIR 'project.zip'
    if (-not (Download-File @($REPO_ZIP) $zip '项目代码')) {
        Fail '项目代码下载失败' @"
GitHub 在国内可能无法直连。可选方案：
  1. 挂代理后重试
  2. 用浏览器打开下面地址，下载 zip 解压到 $INSTALL_DIR
     $REPO_ZIP
"@
    }
    Write-Info '正在解压…'
    $extract = Join-Path $TEMP_DIR 'extract'
    Expand-Archive -Path $zip -DestinationPath $extract -Force
    # GitHub 的 zip 会多一层 live-auto-recorder-master 目录
    $inner = Get-ChildItem -Path $extract -Directory | Select-Object -First 1
    if (-not $inner) { Fail '解压后未找到项目目录' }
    New-Item -ItemType Directory -Force -Path (Split-Path $INSTALL_DIR) | Out-Null
    if (Test-Path $INSTALL_DIR) { Remove-Item $INSTALL_DIR -Recurse -Force }
    Move-Item -Path $inner.FullName -Destination $INSTALL_DIR
    Write-Ok '项目代码就绪'
}

# ---------- 3. 安装依赖 ----------

Write-Step 3 $TOTAL '安装项目依赖（约 300MB，2-5 分钟）'

Push-Location $INSTALL_DIR
try {
    # 项目内的 install:win 已包含版本校验、镜像配置、文件验证与自检
    & cmd /c "npm run install:win" 2>&1 | ForEach-Object { Write-Host "  $_" }
    if ($LASTEXITCODE -ne 0) {
        Fail "依赖安装失败（退出码 $LASTEXITCODE）" @"
可手动排查：
  cd "$INSTALL_DIR"
  npm install
常见原因：
  - 网络：挂代理后重试
  - 权限：不要把项目放在 C:\Program Files
"@
    }
    Write-Ok '依赖安装完成'
} finally {
    Pop-Location
}

# ---------- 4. 完成 ----------

Write-Step 4 $TOTAL '安装完成'

Write-Host ""
Write-Host "  安装位置：$INSTALL_DIR" -ForegroundColor White
Write-Host ""
Write-Host "  启动方式（任选其一）：" -ForegroundColor White
Write-Host "    1. 进入目录双击 启动直播录制.bat"
Write-Host "    2. 命令行执行："
Write-Host "         cd `"$INSTALL_DIR`"" -ForegroundColor Gray
Write-Host "         npm start" -ForegroundColor Gray
Write-Host ""
Write-Host "  首次启动若弹出防火墙提示，请选择「允许」（需要访问抖音接口）。" -ForegroundColor Yellow
Write-Host ""
Write-Host "  添加主播：粘贴直播间链接或房间号，例如" -ForegroundColor White
Write-Host "    https://live.douyin.com/123456789012" -ForegroundColor Gray
Write-Host ""
Write-Host "  字幕功能（可选）：" -ForegroundColor White
Write-Host "    需要先装 Python 3.12，然后运行 npm run transcribe:setup" -ForegroundColor Gray
Write-Host ""

# 清理临时文件
try { Remove-Item $TEMP_DIR -Recurse -Force -ErrorAction SilentlyContinue } catch { }

# 询问是否立刻启动
$ans = Read-Host "现在启动吗？(y/N)"
if ($ans -eq 'y' -or $ans -eq 'Y') {
    Push-Location $INSTALL_DIR
    try { & cmd /c "npm start" } finally { Pop-Location }
}