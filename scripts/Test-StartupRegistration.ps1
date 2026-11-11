[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'StartupRegistration.ps1')
$testName = 'KakaoTalkInlineGif-RegistryTest-' + [Guid]::NewGuid().ToString('N')
$testKey = 'HKCU:\Software\' + $testName
$testNative = 'HKCU\Software\' + $testName
$expectedResolved = 'HKEY_CURRENT_USER\Software\' + $testName
$backupDirectory = Join-Path $PSScriptRoot 'registry-regression-backups'
$reportPath = Join-Path $PSScriptRoot 'startup-regression-test-results.json'
$passed = @()
try {
    if (Test-Path -LiteralPath $testKey) { throw 'The unique temporary registry key unexpectedly exists.' }
    $first = Set-KakaoTalkInlineGifStartup -RegistryPath $testKey -RegistryNativePath $testNative -LauncherPath 'C:\SyntheticTest\old\KakaoTalkInlineGif.exe' -BackupDirectory $backupDirectory
    if ($first.keyExisted -or $first.backup) { throw 'Fresh-key branch did not report creation correctly.' }
    $passed += 'new temporary startup key is created without Force'
    New-ItemProperty -LiteralPath $testKey -Name 'SentinelStartup' -Value 'preserve-this-existing-startup' -PropertyType String | Out-Null
    New-ItemProperty -LiteralPath $testKey -Name 'SentinelDword' -Value 123456 -PropertyType DWord | Out-Null
    $second = Set-KakaoTalkInlineGifStartup -RegistryPath $testKey -RegistryNativePath $testNative -LauncherPath 'C:\SyntheticTest\new\KakaoTalkInlineGif.exe' -BackupDirectory $backupDirectory
    $values = Get-ItemProperty -LiteralPath $testKey
    if ($values.SentinelStartup -cne 'preserve-this-existing-startup' -or $values.SentinelDword -ne 123456) { throw 'Registration changed an unrelated startup sentinel.' }
    $passed += 'existing string and DWORD startup sentinels survive registration'
    if ($values.KakaoTalkInlineGif -cne '"C:\SyntheticTest\new\KakaoTalkInlineGif.exe"') { throw 'Registration did not update only its named value.' }
    $passed += 'only KakaoTalkInlineGif value is replaced'
    if (-not $second.keyExisted -or -not (Test-Path -LiteralPath $second.backup -PathType Leaf)) { throw 'Existing-key registration did not produce a backup.' }
    $backupText = Get-Content -LiteralPath $second.backup -Raw
    if (-not $backupText.Contains('"SentinelStartup"="preserve-this-existing-startup"') -or
        -not $backupText.Contains('"SentinelDword"=dword:0001e240') -or
        -not $backupText.Contains('SyntheticTest\\old\\KakaoTalkInlineGif.exe')) { throw 'The registry backup does not contain the complete pre-change state.' }
    $passed += 'reg export captures unrelated values and previous helper value before mutation'
    $blockedBackup = Join-Path $PSScriptRoot 'registry-regression-backup-blocker.txt'
    [IO.File]::WriteAllText($blockedBackup,'Synthetic regression fixture: a file cannot be used as a backup directory.')
    $backupRejected = $false
    try { Set-KakaoTalkInlineGifStartup -RegistryPath $testKey -RegistryNativePath $testNative -LauncherPath 'C:\SyntheticTest\must-not-register.exe' -BackupDirectory $blockedBackup | Out-Null }
    catch { $backupRejected = $true }
    $afterBackupFailure = Get-ItemProperty -LiteralPath $testKey
    if (-not $backupRejected -or $afterBackupFailure.SentinelStartup -cne 'preserve-this-existing-startup' -or
        $afterBackupFailure.SentinelDword -ne 123456 -or $afterBackupFailure.KakaoTalkInlineGif -cne '"C:\SyntheticTest\new\KakaoTalkInlineGif.exe"') { throw 'A backup failure did not prevent all registry mutation.' }
    $passed += 'backup failure blocks registration before any existing value changes'
    $rejected = $false
    try { Set-KakaoTalkInlineGifStartup -RegistryPath $testKey -RegistryNativePath 'HKCU\Software\MismatchedPath' -LauncherPath 'C:\SyntheticTest\wrong.exe' -BackupDirectory $backupDirectory | Out-Null }
    catch { $rejected = $true }
    if (-not $rejected -or (Get-ItemProperty -LiteralPath $testKey).KakaoTalkInlineGif -cne '"C:\SyntheticTest\new\KakaoTalkInlineGif.exe"') { throw 'Mismatched registry path was not rejected before mutation.' }
    $passed += 'mismatched provider/native registry paths are rejected without mutation'
    [IO.File]::WriteAllText($reportPath,([ordered]@{success=$true;total=$passed.Count;scope='Isolated HKCU Software temporary task key only; live Run key was not read or changed';passed=$passed} | ConvertTo-Json -Depth 5),(New-Object Text.UTF8Encoding($false)))
} catch {
    [IO.File]::WriteAllText($reportPath,([ordered]@{success=$false;passed=$passed;error=$_.Exception.Message} | ConvertTo-Json -Depth 5),(New-Object Text.UTF8Encoding($false)))
    throw
} finally {
    if (Test-Path -LiteralPath $testKey) {
        $resolved = Get-Item -LiteralPath $testKey
        if ($resolved.Name -cne $expectedResolved -or $testName -notmatch '^KakaoTalkInlineGif-RegistryTest-[a-f0-9]{32}$') { throw 'Temporary registry cleanup target failed its identity check.' }
        if (@(Get-ChildItem -LiteralPath $testKey).Count -ne 0) { throw 'Unexpected subkey found; no recursive deletion was attempted.' }
        foreach ($value in @('SentinelStartup','SentinelDword','KakaoTalkInlineGif')) { Remove-ItemProperty -LiteralPath $testKey -Name $value -ErrorAction SilentlyContinue }
        Remove-Item -LiteralPath $testKey -ErrorAction Stop
    }
}
Get-Content -LiteralPath $reportPath -Raw
