[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$installRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'KakaoTalkInlineGif'))
$launcher = Join-Path $installRoot 'KakaoTalkInlineGif.exe'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
if (Test-Path -LiteralPath $launcher -PathType Leaf) {
    $stop = Start-Process -FilePath $launcher -ArgumentList '--stop' -WindowStyle Hidden -PassThru
    if (-not $stop.WaitForExit(5000)) { throw 'The helper did not accept its stop request.' }
    if ($stop.ExitCode -ne 0) { throw "Stop request failed ($($stop.ExitCode))." }
}
if (Test-Path -LiteralPath $runKey) {
    Remove-ItemProperty -LiteralPath $runKey -Name 'KakaoTalkInlineGif' -ErrorAction SilentlyContinue
}
$deadline = [DateTime]::UtcNow.AddSeconds(12)
do {
    $own = @(Get-CimInstance Win32_Process | Where-Object {
        $_.ExecutablePath -and (
            $_.ExecutablePath -ieq $launcher -or
            $_.ExecutablePath -ieq (Join-Path $installRoot 'bin\node.exe') -or
            $_.ExecutablePath -ieq (Join-Path $installRoot 'renderer\InlineGifRenderer.exe')
        )
    })
    if ($own.Count -eq 0) { break }
    Start-Sleep -Milliseconds 200
} while ([DateTime]::UtcNow -lt $deadline)
if ($own.Count -gt 0) { throw 'Startup is disabled, but the helper is still closing. Files and KakaoTalk were retained.' }
$statePath = Join-Path $installRoot 'runtime\host-state.json'
if (Test-Path -LiteralPath $statePath -PathType Leaf) {
    $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    if ($state.state -eq 'cleanup-pending') { throw 'Startup is disabled. The helper reports pending cleanup; inspect runtime logs.' }
}
Write-Output 'KakaoTalk inline GIF playback is disabled. Program files and cached GIFs were retained.'
