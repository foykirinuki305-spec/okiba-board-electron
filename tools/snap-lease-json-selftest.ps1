$ErrorActionPreference='Stop'
$t=$null;$e=$null;$a=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'snap-lease-common-ci.ps1'),[ref]$t,[ref]$e)
if($e){throw ($e|Out-String)}
 $defs=@();foreach($name in @('Invoke-LeaseFileExchange','Read-LeaseJson','Save-LeaseJson')){$f=$a.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true);$defs+=$f.Extent.Text;Invoke-Expression $f.Extent.Text}
$p=Join-Path ([IO.Path]::GetTempPath()) ('okiba-lease-json-pure-'+[guid]::NewGuid().ToString('N')+'.json')
try{
 foreach($phase in @('before-disable','armed','restored')){Save-LeaseJson $p @{phase=$phase};$j=[IO.File]::ReadAllText($p)|ConvertFrom-Json;if($j.phase -cne $phase){throw "wrong phase: $phase"}}
 $job=Start-Job -ArgumentList $p,($defs -join "`n") -ScriptBlock {param($file,$definitions)$ErrorActionPreference='Stop';Invoke-Expression $definitions;for($i=0;$i -lt 300;$i++){Save-LeaseJson $file @{phase='concurrent';n=$i;payload=('x'*4096)}}}
 for($i=0;$i -lt 600;$i++){$j=Read-LeaseJson $p;if(-not $j.phase){throw 'partial JSON'};Start-Sleep -Milliseconds 2}
 $job|Wait-Job -Timeout 30|Out-Null;if($job.State -ne 'Completed'){throw ('writer state '+$job.State)};$job|Receive-Job -ErrorAction Stop|Out-Null;$job|Remove-Job
 $j=Read-LeaseJson $p;if($j.n -ne 299){throw 'writer incomplete'}
 [IO.File]::WriteAllText($p,'not JSON');$failed=$false;try{$null=Read-LeaseJson $p}catch{$failed=$true};if(-not $failed){throw 'invalid JSON swallowed'}
 [IO.File]::Delete($p);$failed=$false;try{$null=Read-LeaseJson $p}catch{$failed=$true};if(-not $failed){throw 'permanent missing file swallowed'}
 'PASS create + 2 replace + 300 concurrent writes / 600 reads + invalid JSON / permanent missing fail-closed'
}finally{if($job){$job|Stop-Job -ErrorAction SilentlyContinue;$job|Remove-Job -Force -ErrorAction SilentlyContinue};if([IO.File]::Exists($p)){[IO.File]::Delete($p)}}
