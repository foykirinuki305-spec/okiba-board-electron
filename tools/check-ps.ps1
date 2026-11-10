# CI helper: prove one bundled PowerShell script parses and every
# embedded Add-Type C# block compiles. Run once per file, each time
# in a fresh pwsh process (scripts/shell-helper.ps1 intentionally
# re-declares the same interop types as the cold-spawn scripts, so
# compiling two files in one session would collide).
param([Parameter(Mandatory = $true)][string]$File)
$ErrorActionPreference = 'Stop'
$tokens = $null; $errs = $null
[void][System.Management.Automation.Language.Parser]::ParseFile(
  (Resolve-Path $File).Path, [ref]$tokens, [ref]$errs)
if ($errs -and $errs.Count) {
  $errs | ForEach-Object { Write-Host "$File syntax error: $($_.Message)" }
  exit 1
}
$src = Get-Content -Raw $File
$blocks = [regex]::Matches($src, "(?s)Add-Type -TypeDefinition @'\r?\n(.*?)\r?\n'@")
foreach ($b in $blocks) {
  try {
    Add-Type -TypeDefinition $b.Groups[1].Value -ErrorAction Stop
  } catch {
    Write-Host "$File : C# compile failed: $($_.Exception.Message)"
    exit 1
  }
}
Write-Host "$File : parse OK, $($blocks.Count) embedded C# block(s) compile"
