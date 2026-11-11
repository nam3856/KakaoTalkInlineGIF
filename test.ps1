[CmdletBinding()]
param([string]$NodeExecutable = '', [switch]$RegistryTests)
$ErrorActionPreference = 'Stop'
$repo = $PSScriptRoot
$compiler = Join-Path $env:windir 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw 'The .NET Framework compiler is required.' }
if (-not $NodeExecutable) { $NodeExecutable = (Get-Command node -ErrorAction Stop).Source }
$tests = Join-Path $repo ('artifacts\tests-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tests -Force | Out-Null
function Assert-Result([string]$Path, [int]$Minimum) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Test process produced no fresh report: $Path" }
    $value = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    if ($value.success -ne $true -or $value.total -lt $Minimum) { throw "Failed or incomplete test report: $Path" }
    return $value
}
function Compile-Test([string]$Output, [string[]]$Sources, [string[]]$References) {
    $arguments = @('/nologo','/codepage:65001','/optimize+','/target:winexe',"/out:$Output") + $References + $Sources
    & $compiler @arguments
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $Output -PathType Leaf)) { throw "Test compiler failed to create $Output" }
}
$renderer = Join-Path $repo 'src\renderer'
Compile-Test (Join-Path $tests 'InlineGifRenderer.exe') @((Join-Path $renderer 'InlineGifRenderer.cs'),(Join-Path $renderer 'SelfTests.cs')) @('/reference:System.Drawing.dll','/reference:System.Windows.Forms.dll','/reference:System.Web.Extensions.dll')
$report = Join-Path $tests 'self-test-results.json'
$process = Start-Process -FilePath (Join-Path $tests 'InlineGifRenderer.exe') -ArgumentList @('--self-test','--report',('"'+$report+'"')) -WindowStyle Hidden -Wait -PassThru
if ($process.ExitCode -ne 0) { throw 'Renderer self-tests failed.' }
$rendererResult = Assert-Result $report 9
Compile-Test (Join-Path $tests 'TransportSelfTest.exe') @((Join-Path $renderer 'TransportSelfTest.cs')) @('/reference:System.Windows.Forms.dll','/reference:System.Web.Extensions.dll')
$process = Start-Process -FilePath (Join-Path $tests 'TransportSelfTest.exe') -WindowStyle Hidden -Wait -PassThru
if ($process.ExitCode -ne 0) { throw 'Renderer transport tests failed.' }
$transportResult = Assert-Result (Join-Path $tests 'transport-self-test-results.json') 10
$launcher = Join-Path $repo 'src\launcher'
Compile-Test (Join-Path $tests 'KakaoTalkInlineGif.exe') @((Join-Path $launcher 'LauncherCore.cs'),(Join-Path $launcher 'KakaoTalkInlineGif.cs')) @('/reference:System.Drawing.dll','/reference:System.Windows.Forms.dll','/reference:System.Web.Extensions.dll')
$mockPackage = Join-Path $tests 'selftest-package'
New-Item -ItemType Directory -Path (Join-Path $mockPackage 'bin'),(Join-Path $mockPackage 'runtime') -Force | Out-Null
Compile-Test (Join-Path $mockPackage 'bin\node.exe') @((Join-Path $launcher 'MockDaemon.cs')) @('/reference:System.Web.Extensions.dll')
Copy-Item -LiteralPath (Join-Path $tests 'KakaoTalkInlineGif.exe') -Destination $mockPackage
[IO.File]::WriteAllText((Join-Path $mockPackage 'host.mjs'), '// Synthetic mock fixture, never loaded by real Node.')
Compile-Test (Join-Path $tests 'LauncherTests.exe') @((Join-Path $launcher 'LauncherCore.cs'),(Join-Path $launcher 'LauncherTests.cs')) @('/reference:System.Web.Extensions.dll')
$process = Start-Process -FilePath (Join-Path $tests 'LauncherTests.exe') -WindowStyle Hidden -Wait -PassThru
if ($process.ExitCode -ne 0) { throw 'Launcher mock tests failed.' }
$launcherResult = Assert-Result (Join-Path $tests 'launcher-self-test-results.json') 7
$env:INLINEGIF_TEST_REPORT = Join-Path $tests 'resolver-results.json'
try {
    & $NodeExecutable (Join-Path $repo 'tests\test-resolver.cjs')
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $env:INLINEGIF_TEST_REPORT)) { throw 'Resolver tests did not produce a fresh success report.' }
    $resolverResult = Get-Content -LiteralPath $env:INLINEGIF_TEST_REPORT -Raw | ConvertFrom-Json
    if ($resolverResult.passed -lt 17) { throw 'Resolver test coverage is incomplete.' }
} finally { Remove-Item Env:INLINEGIF_TEST_REPORT -ErrorAction SilentlyContinue }
$priorHostReport = $env:INLINEGIF_HOST_TEST_REPORT
$env:INLINEGIF_HOST_TEST_REPORT = Join-Path $tests 'host-startup-results.json'
try {
    & $NodeExecutable (Join-Path $repo 'tests\test-host-startup.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Host readiness tests failed.' }
    $hostResult = Assert-Result $env:INLINEGIF_HOST_TEST_REPORT 12
    if ($hostResult.total -ne 12 -or @($hostResult.passed).Count -ne 12) { throw 'Host readiness test report does not contain all 12 checks.' }
} finally {
    if ($null -ne $priorHostReport) { $env:INLINEGIF_HOST_TEST_REPORT = $priorHostReport }
    else { Remove-Item Env:INLINEGIF_HOST_TEST_REPORT -ErrorAction SilentlyContinue }
}
if ($RegistryTests) { & (Join-Path $repo 'scripts\Test-StartupRegistration.ps1') }
$total = $rendererResult.total + $transportResult.total + $launcherResult.total + $resolverResult.passed + $hostResult.total
[ordered]@{ success=$true; total=$total; renderer=$rendererResult.total; transport=$transportResult.total; launcher=$launcherResult.total; resolver=$resolverResult.passed; hostStartup=$hostResult.total; registry=[bool]$RegistryTests; reports=$tests } | ConvertTo-Json
