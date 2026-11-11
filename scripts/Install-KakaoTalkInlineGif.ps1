[CmdletBinding()]
param(
    [string]$PackageRoot = '',
    [string]$NodePath = '',
    [string]$DependencyRoot = '',
    [switch]$CheckOnly,
    [switch]$NoStart,
    [switch]$NoStartup
)
$ErrorActionPreference = 'Stop'
if (-not $PackageRoot) { $PackageRoot = Join-Path $PSScriptRoot 'package' }
if (-not $NodePath) { $NodePath = Join-Path $PackageRoot 'bin\node.exe' }
if (-not $DependencyRoot) { $DependencyRoot = Join-Path $PackageRoot 'node_modules' }
$PackageRoot = [IO.Path]::GetFullPath($PackageRoot)
$NodePath = [IO.Path]::GetFullPath($NodePath)
$DependencyRoot = [IO.Path]::GetFullPath($DependencyRoot)
$localRoot = [IO.Path]::GetFullPath($env:LOCALAPPDATA).TrimEnd('\')
$installRoot = [IO.Path]::GetFullPath((Join-Path $localRoot 'KakaoTalkInlineGif'))
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$utf8 = New-Object Text.UTF8Encoding($false)
. (Join-Path $PSScriptRoot 'StartupRegistration.ps1')

function Assert-InstallSibling([string]$Path, [string]$ExpectedName) {
    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    if (([IO.Path]::GetDirectoryName($full) -ine $localRoot) -or
        ([IO.Path]::GetFileName($full) -ine $ExpectedName)) {
        throw "Unexpected installation target: $full"
    }
    return $full
}
function Write-Json([string]$Path, $Value) {
    [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 20), $utf8)
}
function Get-OwnProcesses {
    @(Get-CimInstance Win32_Process | Where-Object {
        $_.ExecutablePath -and (
            $_.ExecutablePath -ieq (Join-Path $installRoot 'KakaoTalkInlineGif.exe') -or
            $_.ExecutablePath -ieq (Join-Path $installRoot 'bin\node.exe') -or
            $_.ExecutablePath -ieq (Join-Path $installRoot 'renderer\InlineGifRenderer.exe')
        )
    })
}
function Stop-ExistingHelper {
    $existingLauncher = Join-Path $installRoot 'KakaoTalkInlineGif.exe'
    if (Test-Path -LiteralPath $existingLauncher -PathType Leaf) {
        $stopProcess = Start-Process -FilePath $existingLauncher -ArgumentList '--stop' -WindowStyle Hidden -PassThru
        if (-not $stopProcess.WaitForExit(5000)) { throw 'The existing helper did not accept its stop request.' }
        if ($stopProcess.ExitCode -ne 0) { throw "Stop request failed ($($stopProcess.ExitCode))." }
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(12)
    while (@(Get-OwnProcesses).Count -gt 0 -and [DateTime]::UtcNow -lt $deadline) {
        Start-Sleep -Milliseconds 200
    }
    if (@(Get-OwnProcesses).Count -gt 0) { throw 'The existing helper is still closing. No application files were replaced.' }
    $hostState = Join-Path $installRoot 'runtime\host-state.json'
    if (Test-Path -LiteralPath $hostState -PathType Leaf) {
        $state = Get-Content -LiteralPath $hostState -Raw | ConvertFrom-Json
        if ($state.state -eq 'cleanup-pending') { throw 'The existing helper reports pending native cleanup. No application files were replaced.' }
    }
}

$required = @('host.mjs','KakaoTalkInlineGif.exe','renderer\InlineGifRenderer.exe',
    'agent\memory.js','agent\runtime.js','agent\native-abi.js','agent\source-resolver.js')
foreach ($relative in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $PackageRoot $relative) -PathType Leaf)) { throw "Missing package file: $relative" }
}
foreach ($file in @($NodePath,(Join-Path $DependencyRoot 'frida\build\src\frida.js'),(Join-Path $DependencyRoot 'frida\build\frida_binding.node'))) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing runtime dependency: $file" }
}
$installRoot = Assert-InstallSibling $installRoot 'KakaoTalkInlineGif'
$fridaInfo = Get-Content -LiteralPath (Join-Path $DependencyRoot 'frida\package.json') -Raw | ConvertFrom-Json
$plan = [ordered]@{ installRoot=$installRoot; packageRoot=$PackageRoot; node=$NodePath; dependencyRoot=$DependencyRoot;
    fridaVersion=$fridaInfo.version; startup=(-not $NoStartup); start=(-not $NoStart); supportedKakaoVersion='26.9.2.5342';
    supportedKakaoSha256='ec0f43b67cc7e81544464f649a5dfbd690776968014d34d7c554b7a9382a2290' }
if ($CheckOnly) { $plan | ConvertTo-Json; return }

Stop-ExistingHelper
$enabled = $true
$existingControl = Join-Path $installRoot 'control.json'
if (Test-Path -LiteralPath $existingControl -PathType Leaf) {
    $prior = Get-Content -LiteralPath $existingControl -Raw | ConvertFrom-Json
    if ($null -ne $prior.enabled) {
        if ($prior.enabled -isnot [bool]) { throw 'Existing enabled preference is invalid.' }
        $enabled = $prior.enabled
    }
}
$stageName = 'KakaoTalkInlineGif.staging-' + [Guid]::NewGuid().ToString('N')
$stage = Assert-InstallSibling (Join-Path $localRoot $stageName) $stageName
New-Item -ItemType Directory -Path $stage -ErrorAction Stop | Out-Null
foreach ($folder in @('agent','renderer','bin','runtime','cache','licenses')) { New-Item -ItemType Directory -Path (Join-Path $stage $folder) | Out-Null }
foreach ($relative in $required) { Copy-Item -LiteralPath (Join-Path $PackageRoot $relative) -Destination (Join-Path $stage $relative) }
Copy-Item -LiteralPath $NodePath -Destination (Join-Path $stage 'bin\node.exe')
$nodeLicense = Join-Path ([IO.Path]::GetDirectoryName($NodePath)) 'LICENSE'
if (Test-Path -LiteralPath $nodeLicense -PathType Leaf) { Copy-Item -LiteralPath $nodeLicense -Destination (Join-Path $stage 'licenses\NODE-LICENSE.txt') }
Copy-Item -LiteralPath $DependencyRoot -Destination (Join-Path $stage 'node_modules') -Recurse
$packageLicenses = Join-Path $PackageRoot 'licenses'
if (Test-Path -LiteralPath $packageLicenses -PathType Container) {
    Get-ChildItem -LiteralPath $packageLicenses -File | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $stage 'licenses') -Force }
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Disable-KakaoTalkInlineGif.ps1') -Destination $stage
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Disable-KakaoTalkInlineGif.cmd') -Destination $stage
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Get-KakaoTalkInlineGifValidation.ps1') -Destination $stage
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'README.ko.md') -Destination $stage

# Test manifests and runtime logs are intentionally never copied.
$cacheSource = Join-Path $PackageRoot 'cache'
if (Test-Path -LiteralPath (Join-Path $installRoot 'cache\index.json') -PathType Leaf) { $cacheSource = Join-Path $installRoot 'cache' }
if (Test-Path -LiteralPath (Join-Path $cacheSource 'index.json') -PathType Leaf) {
    $index = Get-Content -LiteralPath (Join-Path $cacheSource 'index.json') -Raw | ConvertFrom-Json
    $kept = [ordered]@{}
    foreach ($entry in $index.assets.PSObject.Properties) {
        $name = [string]$entry.Value.file
        if ($name -notmatch '^[a-f0-9]{64}\.gif$') { continue }
        $source = Join-Path $cacheSource $name
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { continue }
        if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant() -ne $name.Substring(0,64)) { throw 'A cached GIF failed its content hash check.' }
        $destination = Join-Path $stage "cache\$name"
        if (-not (Test-Path -LiteralPath $destination)) { Copy-Item -LiteralPath $source -Destination $destination }
        $kept[$entry.Name] = $entry.Value
    }
    Write-Json (Join-Path $stage 'cache\index.json') ([ordered]@{schemaVersion=1;assets=$kept})
} else { Write-Json (Join-Path $stage 'cache\index.json') ([ordered]@{schemaVersion=1;assets=[ordered]@{}}) }
Write-Json (Join-Path $stage 'control.json') ([ordered]@{schemaVersion=1;enabled=$enabled;shutdown=$false})
$checksums = [ordered]@{}
foreach ($relative in ($required + @('bin\node.exe','node_modules\frida\build\frida_binding.node'))) {
    $checksums[$relative] = (Get-FileHash -LiteralPath (Join-Path $stage $relative) -Algorithm SHA256).Hash.ToLowerInvariant()
}
Write-Json (Join-Path $stage 'installation.json') ([ordered]@{schemaVersion=1;installedUtc=[DateTime]::UtcNow.ToString('o');plan=$plan;sha256=$checksums})
$backup = $null
if (Test-Path -LiteralPath $installRoot) {
    $backupName = 'KakaoTalkInlineGif.backup-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8)
    $backup = Assert-InstallSibling (Join-Path $localRoot $backupName) $backupName
    Move-Item -LiteralPath $installRoot -Destination $backup
}
try { Move-Item -LiteralPath $stage -Destination $installRoot }
catch {
    if ($backup -and -not (Test-Path -LiteralPath $installRoot)) { Move-Item -LiteralPath $backup -Destination $installRoot }
    throw
}
$startupRegistration = $null
if (-not $NoStartup) {
    $startupRegistration = Set-KakaoTalkInlineGifStartup -RegistryPath $runKey -RegistryNativePath 'HKCU\Software\Microsoft\Windows\CurrentVersion\Run' -LauncherPath (Join-Path $installRoot 'KakaoTalkInlineGif.exe') -BackupDirectory (Join-Path $installRoot 'runtime')
}
if (-not $NoStart) {
    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = Join-Path $installRoot 'KakaoTalkInlineGif.exe'
    $startInfo.WorkingDirectory = $installRoot
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    [void]$startInfo.EnvironmentVariables.Remove('INLINEGIF_FRIDA')
    [void]$startInfo.EnvironmentVariables.Remove('INLINEGIF_TEST_TITLE')
    [void][Diagnostics.Process]::Start($startInfo)
}
[ordered]@{installed=$true;installRoot=$installRoot;backup=$backup;startup=(-not $NoStartup);startupRegistration=$startupRegistration;started=(-not $NoStart)} | ConvertTo-Json
