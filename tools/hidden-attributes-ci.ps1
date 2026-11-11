param([ValidateSet('none','attributes')][string]$Mode='none')
# Only a disposable GitHub-hosted Windows runner may execute this test.
$ErrorActionPreference='Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
  throw 'Safe Desktop integration is restricted to GitHub-hosted Windows CI.'
}
$source=Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\scripts\shell-helper.ps1') -Raw
foreach($block in [regex]::Matches($source,"(?s)Add-Type -TypeDefinition @'\r?\n(.*?)\r?\n'@")) {
  Add-Type -TypeDefinition $block.Groups[1].Value
}
$original=[OkibaFolderView]::ReadState()
if($null -eq $original -or $original.Length -lt 2){throw 'Cannot read authoritative Shell FolderView state.'}
$exitCode=1
try {
  [OkibaFolderView]::SetFlagsForCI([uint32]5,[uint32]4)
  Start-Sleep -Milliseconds 300
  $actual=[OkibaFolderView]::ReadState()
  if($actual.Length -lt 2 -or ($actual[0] -band 5) -ne 4 -or $actual[1] -ne 0){throw 'Shell FolderView did not enter manual arrangement with snap-to-grid; raw ListView bits are insufficient.'}
  Write-Host ('Authoritative Shell state verified: flags='+$actual[0]+' autoArrange='+$actual[1])
  & node (Join-Path $PSScriptRoot 'hidden-attributes-ci.js') ([Environment]::GetFolderPath('Desktop')) $Mode
  $exitCode=$LASTEXITCODE
} finally {
  [OkibaFolderView]::SetFlagsForCI([uint32]5,[uint32]($original[0] -band 5))
  $restored=[OkibaFolderView]::ReadState()
  if(($restored[0] -band 5) -ne ($original[0] -band 5) -or $restored[1] -ne $original[1]){throw 'Original Shell FolderView state could not be restored.'}
}
exit $exitCode


