$ErrorActionPreference='Stop'
$old=$env:OKIBA_MIXED_LEASE
try{
 $env:OKIBA_MIXED_LEASE='0';. (Join-Path $PSScriptRoot '../scripts/snap-lease.ps1')
 function Lease-Require($token){return @{kind='mixed-hidden-resident'}}
 $n=0
 foreach($call in @({Lease-Prepare @{scope=@{kind='mixed-hidden-resident'}}},{Lease-ValidateRecovery @{kind='mixed-hidden-resident'} @{}},{Lease-RevealPlace 'x'},{Lease-RestoreVerify 'x'},{Lease-Rollback 'x'},{Lease-Release 'x' 'visible'})){
  try{& $call;throw 'accepted disabled mixed'}catch{if($_.Exception.Message -cne 'mixed-lease-disabled'){throw};$n++}
 }
 $env:OKIBA_MIXED_LEASE='1';. (Join-Path $PSScriptRoot '../scripts/mixed-lease.ps1')
 $source=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'mixed-prehide-selftest.ps1') -Raw
 $source=$source.Replace("Invoke-Expression ([IO.File]::ReadAllText((Join-Path `$PSScriptRoot 'mixed-lease-native-ci.ps1')))",'')
 $source=$source.Replace("Join-Path `$PSScriptRoot 'mixed-lease-native-ci.ps1'","Join-Path `$PSScriptRoot '../scripts/mixed-lease.ps1'")
 $source=$source.Replace('function Lease-Rollback(','function Mixed-Rollback(').Replace('function Lease-Release(','function Mixed-Release(')
 $source=$source.Replace('$PSScriptRoot',("'"+$PSScriptRoot.Replace("'","''")+"'"))
 Invoke-Expression $source
 Write-Output ('formal mixed disabled dispatch '+$n+' PASS; formal prehide 6 PASS')
}finally{$env:OKIBA_MIXED_LEASE=$old}
