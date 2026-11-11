[CmdletBinding()]
param(
    [string]$AppRoot = '',
    [string]$ReportPath = ''
)
$ErrorActionPreference = 'Stop'
if (-not $AppRoot) { $AppRoot = Join-Path $env:LOCALAPPDATA 'KakaoTalkInlineGif' }
if (-not $ReportPath) { $ReportPath = Join-Path $PSScriptRoot 'validation-latest.json' }
$AppRoot = [IO.Path]::GetFullPath($AppRoot)
$ReportPath = [IO.Path]::GetFullPath($ReportPath)

function Read-LocalJson([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    try { return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json) } catch { return $null }
}
function Select-Fields($Record, [string[]]$Names) {
    $selected = [ordered]@{}
    if ($null -ne $Record) {
        foreach ($name in $Names) {
            if ($null -ne $Record.PSObject.Properties[$name]) { $selected[$name] = $Record.$name }
        }
    }
    return $selected
}
function File-AgeMs([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    return [Math]::Max(0,[Math]::Round(([DateTime]::UtcNow - (Get-Item -LiteralPath $Path).LastWriteTimeUtc).TotalMilliseconds))
}

$hostPath = Join-Path $AppRoot 'runtime\host-state.json'
$hostState = Read-LocalJson $hostPath
$launcherState = Read-LocalJson (Join-Path $AppRoot 'runtime\launcher-state.json')
$hostSafe = Select-Fields $hostState @('state','pid','enabled','tracked','paintCount','sourceErrors','cachedAssets','clean')
$hostSafe['statusAgeMs'] = File-AgeMs $hostPath
if ($hostState -and $hostState.resolver) {
    $hostSafe['resolver'] = Select-Fields $hostState.resolver @('running','stopping','nativeDepth','pumping','active','queuedMetadata','uncertainResources','completed','failures','skippedNonUi','canUnload')
}
$renderers = @()
$runtimeRoot = Join-Path $AppRoot 'runtime'
if (Test-Path -LiteralPath $runtimeRoot -PathType Container) {
    foreach ($file in @(Get-ChildItem -LiteralPath $runtimeRoot -Filter 'renderer-*.json' -File)) {
        $state = Read-LocalJson $file.FullName
        if ($null -eq $state) { continue }
        $safe = Select-Fields $state @('processId','enabled','stopped','loadedItems','ownerFocused','frameAdvanceTotal','framesRenderedTotal','freezeOnBlur','renderingEnabled','manifestStale','manifestLeaseMs','manifestAgeMs')
        $safe['statusAgeMs'] = File-AgeMs $file.FullName
        $safe['errorCount'] = @($state.errors).Count
        $safe['visibleItems'] = @($state.items | Where-Object { $_.visible }).Count
        $safe['playingItems'] = @($state.items | Where-Object { $_.playing }).Count
        $renderers += $safe
    }
}
$cacheRoot = Join-Path $AppRoot 'cache'
$cache = [ordered]@{gifFiles=0;totalGifBytes=0}
if (Test-Path -LiteralPath $cacheRoot -PathType Container) {
    $gifs = @(Get-ChildItem -LiteralPath $cacheRoot -Filter '*.gif' -File)
    $cache.gifFiles = $gifs.Count
    $cache.totalGifBytes = ($gifs | Measure-Object -Property Length -Sum).Sum
    if ($null -eq $cache.totalGifBytes) { $cache.totalGifBytes = 0 }
}
$launcherPath = Join-Path $AppRoot 'KakaoTalkInlineGif.exe'
$ownPaths = @($launcherPath,(Join-Path $AppRoot 'bin\node.exe'),(Join-Path $AppRoot 'renderer\InlineGifRenderer.exe'))
$processes = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $ownPaths -icontains $_.ExecutablePath } |
    Select-Object ProcessId,Name)
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$autostart = $false
try {
    $value = (Get-ItemProperty -LiteralPath $runKey -Name 'KakaoTalkInlineGif' -ErrorAction Stop).KakaoTalkInlineGif
    $autostart = $value -ieq ('"' + $launcherPath + '"')
} catch { }
$sha = [ordered]@{}
foreach ($relative in @('host.mjs','KakaoTalkInlineGif.exe','renderer\InlineGifRenderer.exe','agent\memory.js','agent\runtime.js','agent\native-abi.js','agent\source-resolver.js')) {
    $file = Join-Path $AppRoot $relative
    if (Test-Path -LiteralPath $file -PathType Leaf) { $sha[$relative] = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() }
}
$sourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$tests = [ordered]@{}
foreach ($relative in @('resolver\synthetic-test-results.json','renderer\self-test-results.json','renderer\transport-self-test-results.json','renderer\launcher\launcher-self-test-results.json')) {
    $test = Read-LocalJson (Join-Path $sourceRoot $relative)
    $summary = Select-Fields $test @('success','total','failed','scope')
    if ($test -and ($test.passed -is [int] -or $test.passed -is [long])) { $summary['passed'] = $test.passed }
    $tests[$relative] = $summary
}
$report = [ordered]@{schemaVersion=1;collectedUtc=[DateTime]::UtcNow.ToString('o');installed=(Test-Path -LiteralPath $launcherPath -PathType Leaf);
    scope='Read-only redacted snapshot: excludes chat titles, chat/message IDs, media keys, file contents and log text';
    autostartMatches=$autostart;helperProcesses=$processes;host=$hostSafe;launcher=(Select-Fields $launcherState @('launcherPid','childPid','enabled','state'));
    renderers=$renderers;cache=$cache;sha256=$sha;localTests=$tests}
$reportDirectory = [IO.Path]::GetDirectoryName($ReportPath)
if (-not (Test-Path -LiteralPath $reportDirectory -PathType Container)) { New-Item -ItemType Directory -Path $reportDirectory -Force | Out-Null }
[IO.File]::WriteAllText($ReportPath,($report | ConvertTo-Json -Depth 12),(New-Object Text.UTF8Encoding($false)))
Write-Output $ReportPath
