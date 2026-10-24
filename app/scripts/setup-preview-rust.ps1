# Explicit developer setup only. Never invoked by the packaged application.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$rustBin = Join-Path $env:USERPROFILE '.cargo\bin'
$rustup = Join-Path $rustBin 'rustup.exe'
$work = Join-Path $env:TEMP ('motion-rust-setup-' + [guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $work | Out-Null
Write-Output "Setup evidence directory: $work"
if (-not (Test-Path -LiteralPath $rustup)) {
    $base = 'https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe'
    $installer = Join-Path $work 'rustup-init.exe'
    Invoke-WebRequest -UseBasicParsing -Uri $base -OutFile $installer -TimeoutSec 180
    $checksum = (Invoke-WebRequest -UseBasicParsing -Uri ($base + '.sha256') -TimeoutSec 60).Content
    if ($checksum -is [byte[]]) { $checksum = [Text.Encoding]::UTF8.GetString($checksum) }
    $expected = ([string]$checksum).Trim().Split(' ')[0].ToLowerInvariant()
    if ($expected -notmatch '^[a-f0-9]{64}$') { throw 'Invalid official rustup checksum response' }
    $actual = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -cne $expected) { throw 'Official rustup installer checksum mismatch; refusing execution' }
    Write-Output "Official rustup installer SHA256 verified: $actual"
    & $installer -y --profile minimal --default-host x86_64-pc-windows-msvc --default-toolchain stable --component rustfmt,clippy
    if ($LASTEXITCODE -ne 0) { throw "rustup installation failed: $LASTEXITCODE" }
} else {
    Write-Output 'Existing rustup found; preserving the installed toolchain configuration.'
}
$rustc = Join-Path $rustBin 'rustc.exe'
$cargo = Join-Path $rustBin 'cargo.exe'
& $rustc --version --verbose
if ($LASTEXITCODE -ne 0) { throw 'rustc verification failed' }
& $cargo --version
if ($LASTEXITCODE -ne 0) { throw 'cargo verification failed' }
& $rustup component list --installed
if ($LASTEXITCODE -ne 0) { throw 'rustup component verification failed' }
$source = Join-Path $work 'smoke.rs'
$exe = Join-Path $work 'smoke.exe'
# Exercise an actual Windows import and MSVC linking, not just compiler --version.
@'
#[link(name = "kernel32")]
unsafe extern "system" { fn GetCurrentProcessId() -> u32; }
fn main() {
    // SAFETY: GetCurrentProcessId takes no pointers and is available on supported Windows.
    let pid = unsafe { GetCurrentProcessId() };
    assert!(pid > 0);
    println!("Windows MSVC link/run passed; process {}", pid);
}
'@ | Set-Content -LiteralPath $source -Encoding UTF8
& $rustc --edition 2024 --target x86_64-pc-windows-msvc $source -o $exe
if ($LASTEXITCODE -ne 0) { throw 'Windows Rust smoke compile/link failed' }
& $exe
if ($LASTEXITCODE -ne 0) { throw 'Windows Rust smoke execution failed' }
Write-Output 'Rust setup and Windows compile/link/run validation completed.'
