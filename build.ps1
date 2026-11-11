[CmdletBinding()]
param(
    [string]$Version = '0.1.1',
    [switch]$BundleRuntime,
    [string]$NodeExecutable = '',
    [string]$DependencyRoot = '',
    [switch]$Zip
)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Build on Windows x64.' }
if ($Version -notmatch '^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$') { throw 'Invalid release version.' }
$repo = [IO.Path]::GetFullPath($PSScriptRoot)
$artifacts = [IO.Path]::GetFullPath((Join-Path $repo 'artifacts'))
$releaseName = "KakaoTalkInlineGIF-$Version-win-x64"
$release = [IO.Path]::GetFullPath((Join-Path $artifacts $releaseName))
$package = Join-Path $release 'package'
$compiler = Join-Path $env:windir 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) { throw 'The .NET Framework 4 compiler is required.' }
$compatibility = Get-Content -LiteralPath (Join-Path $repo 'src\compatibility.json') -Raw | ConvertFrom-Json
function Assert-ArtifactPath([string]$Value) {
    $full = [IO.Path]::GetFullPath($Value)
    if (-not $full.StartsWith($artifacts.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Build output escapes artifacts: $full"
    }
    return $full
}
New-Item -ItemType Directory -Path $artifacts -Force | Out-Null
if (Test-Path -LiteralPath $release) {
    $checkedRelease = Assert-ArtifactPath $release
    Remove-Item -LiteralPath $checkedRelease -Recurse -Force
}
foreach ($folder in @($release,$package,(Join-Path $package 'agent'),(Join-Path $package 'renderer'),(Join-Path $package 'licenses'))) {
    New-Item -ItemType Directory -Path $folder -Force | Out-Null
}
$renderer = Join-Path $repo 'src\renderer'
& $compiler /nologo /codepage:65001 /optimize+ /target:winexe /platform:anycpu "/out:$(Join-Path $package 'renderer\InlineGifRenderer.exe')" "/win32manifest:$(Join-Path $renderer 'renderer.manifest')" /reference:System.Drawing.dll /reference:System.Windows.Forms.dll /reference:System.Web.Extensions.dll (Join-Path $renderer 'InlineGifRenderer.cs') (Join-Path $renderer 'SelfTests.cs')
if ($LASTEXITCODE -ne 0) { throw 'Renderer compilation failed.' }
if (-not (Test-Path -LiteralPath (Join-Path $package 'renderer\InlineGifRenderer.exe') -PathType Leaf)) { throw 'Compiler returned without creating the renderer.' }
$launcher = Join-Path $repo 'src\launcher'
& $compiler /nologo /codepage:65001 /optimize+ /target:winexe /platform:anycpu "/out:$(Join-Path $package 'KakaoTalkInlineGif.exe')" "/win32manifest:$(Join-Path $launcher 'launcher.manifest')" /reference:System.Drawing.dll /reference:System.Windows.Forms.dll /reference:System.Web.Extensions.dll (Join-Path $launcher 'LauncherCore.cs') (Join-Path $launcher 'KakaoTalkInlineGif.cs')
if ($LASTEXITCODE -ne 0) { throw 'Launcher compilation failed.' }
if (-not (Test-Path -LiteralPath (Join-Path $package 'KakaoTalkInlineGif.exe') -PathType Leaf)) { throw 'Compiler returned without creating the launcher.' }
Copy-Item -LiteralPath (Join-Path $repo 'src\host\host.mjs') -Destination $package
foreach ($name in @('memory.js','native-abi.js','source-resolver.js','runtime.js')) {
    Copy-Item -LiteralPath (Join-Path $repo "src\agent\$name") -Destination (Join-Path $package 'agent')
}
foreach ($name in @('Install-KakaoTalkInlineGif.ps1','Install-KakaoTalkInlineGif.cmd','Disable-KakaoTalkInlineGif.ps1','Disable-KakaoTalkInlineGif.cmd','Get-KakaoTalkInlineGifValidation.ps1','StartupRegistration.ps1','Test-StartupRegistration.ps1','README.ko.md')) {
    Copy-Item -LiteralPath (Join-Path $repo "scripts\$name") -Destination $release
}
foreach ($name in @('README.md','LICENSE','THIRD_PARTY_NOTICES.md')) {
    Copy-Item -LiteralPath (Join-Path $repo $name) -Destination $release
}
Copy-Item -LiteralPath (Join-Path $repo 'LICENSE') -Destination (Join-Path $package 'licenses\PROJECT-LICENSE.txt')
Get-ChildItem -LiteralPath (Join-Path $repo 'licenses') -File | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $package 'licenses') }
[IO.File]::WriteAllText((Join-Path $package 'control.json'), '{"schemaVersion":1,"enabled":true,"shutdown":false}', (New-Object Text.UTF8Encoding($false)))
if ($BundleRuntime) {
    if (-not $NodeExecutable) {
        $tools = Join-Path $artifacts 'tools'
        New-Item -ItemType Directory -Path $tools -Force | Out-Null
        $archive = Join-Path $tools "node-v$($compatibility.nodeVersion)-win-x64.zip"
        if (-not (Test-Path -LiteralPath $archive)) {
            Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/download/release/v$($compatibility.nodeVersion)/node-v$($compatibility.nodeVersion)-win-x64.zip" -OutFile $archive
        }
        if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $compatibility.nodeArchiveSha256) { throw 'Official Node archive checksum mismatch.' }
        $NodeExecutable = Join-Path $tools "node-v$($compatibility.nodeVersion)-win-x64\node.exe"
        if (-not (Test-Path -LiteralPath $NodeExecutable)) { Expand-Archive -LiteralPath $archive -DestinationPath $tools -Force }
    }
    $NodeExecutable = [IO.Path]::GetFullPath($NodeExecutable)
    if ((Get-FileHash -LiteralPath $NodeExecutable -Algorithm SHA256).Hash.ToLowerInvariant() -ne $compatibility.nodeExeSha256) { throw 'The pinned official Node executable checksum does not match.' }
    if ((& $NodeExecutable -p "process.version+' '+process.arch") -ne "v$($compatibility.nodeVersion) x64") { throw 'Unsupported Node runtime.' }
    New-Item -ItemType Directory -Path (Join-Path $package 'bin') | Out-Null
    Copy-Item -LiteralPath $NodeExecutable -Destination (Join-Path $package 'bin\node.exe')
    $nodeLicense = Join-Path ([IO.Path]::GetDirectoryName($NodeExecutable)) 'LICENSE'
    if (-not (Test-Path -LiteralPath $nodeLicense)) { throw 'The official Node LICENSE is required for bundling.' }
    Copy-Item -LiteralPath $nodeLicense -Destination (Join-Path $package 'bin\LICENSE')
    Copy-Item -LiteralPath $nodeLicense -Destination (Join-Path $package 'licenses\NODE-LICENSE.txt')
    Copy-Item -LiteralPath (Join-Path $repo 'package.json'),(Join-Path $repo 'package-lock.json') -Destination $package
    if ($DependencyRoot) {
        $DependencyRoot = [IO.Path]::GetFullPath($DependencyRoot)
        $moduleNames = @(& $NodeExecutable -e 'const fs=require("node:fs");const lock=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));for(const key of Object.keys(lock.packages)){if(key.startsWith("node_modules/")&&!key.includes("/node_modules/"))console.log(key.slice(13));}' (Join-Path $repo 'package-lock.json'))
        if ($LASTEXITCODE -ne 0 -or $moduleNames.Count -eq 0 -or $moduleNames -notcontains 'frida') { throw 'Could not read the dependency allowlist.' }
        foreach ($name in $moduleNames) {
            if ($name -notmatch '^(?:@[A-Za-z0-9_.-]+/)?[A-Za-z0-9_.-]+$') { throw "Unexpected dependency path: $name" }
            $source = Join-Path $DependencyRoot $name
            if (-not (Test-Path -LiteralPath $source -PathType Container)) { throw "Missing dependency: $name" }
            if ((Get-Item -LiteralPath $source).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Dependency symlinks are not bundled: $name" }
            $destination = Join-Path $package "node_modules\$name"
            New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($destination)) -Force | Out-Null
            Copy-Item -LiteralPath $source -Destination $destination -Recurse
        }
    } else {
        $npm = Join-Path ([IO.Path]::GetDirectoryName($NodeExecutable)) 'npm.cmd'
        if (-not (Test-Path -LiteralPath $npm)) { throw 'npm.cmd is required to fetch pinned dependencies, or supply -DependencyRoot.' }
        $priorPath = $env:PATH; $priorCa = $env:NODE_USE_SYSTEM_CA
        try {
            $env:PATH = ([IO.Path]::GetDirectoryName($NodeExecutable)) + ';' + $env:PATH
            $env:NODE_USE_SYSTEM_CA = '1'
            & $npm ci --omit=dev --no-audit --no-fund --prefix $package
            if ($LASTEXITCODE -ne 0) { throw 'Pinned Frida dependency installation failed.' }
        } finally { $env:PATH = $priorPath; $env:NODE_USE_SYSTEM_CA = $priorCa }
    }
    $verification = & (Join-Path $package 'bin\node.exe') (Join-Path $repo 'scripts\verify-runtime.mjs') $package
    if ($LASTEXITCODE -ne 0) { throw 'Bundled Frida runtime verification failed.' }
    if (-not $verification) { throw 'Runtime returned without a verification marker.' }
    $verified = ($verification -join "`n") | ConvertFrom-Json
    if ($verified.node -ne 'v24.22.2' -or $verified.frida -ne '17.23.2' -or $verified.localDevice -ne $true -or $verified.attached -ne $false) { throw 'Invalid runtime verification marker.' }
    $verification | Write-Output
}
if ($Zip -and -not $BundleRuntime) { throw '-Zip requires -BundleRuntime so the download is self contained.' }
$files = [ordered]@{}
Get-ChildItem -LiteralPath $release -Recurse -File | Sort-Object FullName | ForEach-Object {
    $relative = $_.FullName.Substring($release.Length + 1).Replace('\','/')
    $files[$relative] = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
}
$manifest = [ordered]@{ schemaVersion=1; application='KakaoTalkInlineGIF'; version=$Version; platform='win-x64'; supportedKakao=$compatibility; bundledRuntime=[bool]$BundleRuntime; files=$files }
[IO.File]::WriteAllText((Join-Path $release 'release-manifest.json'), ($manifest | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding($false)))
if ($Zip) {
    $archivePath = Assert-ArtifactPath (Join-Path $artifacts "$releaseName.zip")
    if (Test-Path -LiteralPath $archivePath) { Remove-Item -LiteralPath $archivePath -Force }
    Compress-Archive -LiteralPath $release -DestinationPath $archivePath -CompressionLevel Optimal
    $sum = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText((Join-Path $artifacts 'SHA256SUMS.txt'), "$sum  $releaseName.zip`n", (New-Object Text.UTF8Encoding($false)))
}
[ordered]@{ releaseRoot=$release; bundledRuntime=[bool]$BundleRuntime; archive=if($Zip){$archivePath}else{$null} } | ConvertTo-Json
