param()

$ErrorActionPreference = "Stop"
$InstallerProject = $PSScriptRoot
$MainProject = Split-Path $InstallerProject -Parent

# 主项目版本号
$mainCargo = Join-Path $MainProject "src-tauri\Cargo.toml"
$version = (Select-String -Path $mainCargo -Pattern '^version\s*=\s*"(.+)"').Matches[0].Groups[1].Value
Write-Host "Main app version: $version" -ForegroundColor Cyan

$mainExe = Join-Path $MainProject "src-tauri\target\release\openmd.exe"
$mainSrc = Join-Path $MainProject "src-tauri\src"
$payloadZip = Join-Path $InstallerProject "src-tauri\payload.zip"

# Tauri plugin 在 package.json 里写 caret (\"^2.4.1\")会让 pnpm 把 npm 端
# 升到 2.5.0,而 Cargo.lock 不会自动跟升,major+minor 错位被 Tauri 2
# 的版本检查直接挡掉。脚本入口先同步一次主项目依赖,与 cargo 锁对齐。
Write-Host "`n=== [0/3] Sync npm dependencies ===" -ForegroundColor Cyan
Push-Location $MainProject
try {
    pnpm install --prefer-offline
    if ($LASTEXITCODE -ne 0) { throw "pnpm install failed" }
} finally {
    Pop-Location
}

# 主项目产物是否还能跟上源码?有变化就重编。
$needsMainBuild = $true
if (Test-Path $mainExe) {
    $latestSrcStamp = $null
    if (Test-Path $mainSrc) {
        $latestSrcStamp = (Get-ChildItem -Path $mainSrc -Recurse -Include "*.rs" -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1).LastWriteTime
    }
    $latestCargoStamp = (Get-ChildItem -Path $mainCargo -ErrorAction SilentlyContinue).LastWriteTime
    if ($latestSrcStamp -and $mainExe.LastWriteTime -lt $latestSrcStamp) {
        $needsMainBuild = $true
    } elseif ($latestCargoStamp -and $mainExe.LastWriteTime -lt $latestCargoStamp) {
        $needsMainBuild = $true
    } else {
        $needsMainBuild = $false
    }
}

if ($needsMainBuild) {
    Write-Host "`n=== [1/3] Build main openmd.exe ===" -ForegroundColor Cyan
    Push-Location $MainProject
    try {
        pnpm tauri build
        if ($LASTEXITCODE -ne 0) { throw "Main app build failed" }
    } finally {
        Pop-Location
    }
} else {
    Write-Host "`n=== [1/3] openmd.exe up to date, skipping ===" -ForegroundColor DarkGray
}

if (-not (Test-Path $mainExe)) {
    throw "openmd.exe still missing at $mainExe"
}

# payload.zip 必须紧跟主项目重建之后打 —— 它内嵌 openmd.exe 等,
# 早于主项目构建跑就拿不到当前代码,安装器里嵌入的就是旧版
# (这正是当前白框与窗口控制失效的根因)。
Write-Host "`n=== [2/3] Pack payload ===" -ForegroundColor Cyan
& (Join-Path $InstallerProject "pack-payload.ps1")
if ($LASTEXITCODE -ne 0) { throw "pack-payload.ps1 failed" }

if (-not (Test-Path $payloadZip)) {
    throw "payload.zip missing at $payloadZip"
}

# 第三步:用新的 payload.zip 构建 installer(installer.exe 通过
# include_bytes! 把 payload.zip 编进二进制)。
Write-Host "`n=== [3/3] Build installer ===" -ForegroundColor Cyan
Push-Location $InstallerProject
try {
    pnpm tauri build
    if ($LASTEXITCODE -ne 0) { throw "Installer build failed" }
} finally {
    Pop-Location
}

# 重命名
$builtExe = Join-Path $InstallerProject "src-tauri\target\release\OpenMD-installer.exe"
$outputName = "OpenMD_${version}_Windows_x86_64.exe"
$outputPath = Join-Path $InstallerProject $outputName

if (Test-Path $builtExe) {
    Copy-Item $builtExe $outputPath -Force
    $size = (Get-ChildItem $outputPath).Length
    Write-Host "`n=== SUCCESS ===" -ForegroundColor Green
    Write-Host "Output: $outputPath" -ForegroundColor Green
    Write-Host "Size: $('{0:N1}' -f ($size / 1MB)) MB" -ForegroundColor Green
} else {
    Write-Host "`n=== BUILD FAILED ===" -ForegroundColor Red
    exit 1
}
