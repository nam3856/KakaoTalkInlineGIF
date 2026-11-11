# Shared by the installer and its isolated registry regression test.
function Set-KakaoTalkInlineGifStartup {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][string]$RegistryPath,
        [Parameter(Mandatory=$true)][string]$RegistryNativePath,
        [Parameter(Mandatory=$true)][string]$LauncherPath,
        [Parameter(Mandatory=$true)][string]$BackupDirectory
    )
    $ErrorActionPreference = 'Stop'
    if (-not $RegistryPath.StartsWith('HKCU:\',[StringComparison]::OrdinalIgnoreCase) -or
        $RegistryNativePath -ine ('HKCU\' + $RegistryPath.Substring(6))) {
        throw 'Startup registration must address the same explicit HKCU key in both path forms.'
    }
    $existed = Test-Path -LiteralPath $RegistryPath
    $backup = $null
    if ($existed) {
        if (-not (Test-Path -LiteralPath $BackupDirectory -PathType Container)) {
            New-Item -ItemType Directory -Path $BackupDirectory -ErrorAction Stop | Out-Null
        }
        $backup = Join-Path $BackupDirectory ('startup-before-install-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss-fff') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8) + '.reg')
        & "$env:windir\System32\reg.exe" export $RegistryNativePath $backup | Out-Null
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $backup -PathType Leaf)) {
            throw 'Could not back up the existing startup registry key; startup registration was not changed.'
        }
    } else {
        # Registry New-Item -Force replaces the entire existing key. Never use it.
        # If another process creates this key after Test-Path, fail instead of replacing it.
        New-Item -Path $RegistryPath -ErrorAction Stop | Out-Null
    }
    New-ItemProperty -LiteralPath $RegistryPath -Name 'KakaoTalkInlineGif' -Value ('"' + $LauncherPath + '"') -PropertyType String -Force -ErrorAction Stop | Out-Null
    return [ordered]@{keyExisted=$existed;backup=$backup;valueName='KakaoTalkInlineGif'}
}
