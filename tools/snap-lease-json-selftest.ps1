$ErrorActionPreference='Stop'
$t=$null;$e=$null;$a=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'snap-lease-common-ci.ps1'),[ref]$t,[ref]$e)
if($e){throw ($e|Out-String)}
$f=$a.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Save-LeaseJson'},$true)
Invoke-Expression $f.Extent.Text
$p=Join-Path ([IO.Path]::GetTempPath()) ('okiba-lease-json-pure-'+[guid]::NewGuid().ToString('N')+'.json')
try{
 foreach($phase in @('before-disable','armed','restored')){Save-LeaseJson $p @{phase=$phase};$j=[IO.File]::ReadAllText($p)|ConvertFrom-Json;if($j.phase -cne $phase){throw "wrong phase: $phase"}}
 'PASS lease journal create plus 2 atomic replacements'
}finally{if([IO.File]::Exists($p)){[IO.File]::Delete($p)}}
