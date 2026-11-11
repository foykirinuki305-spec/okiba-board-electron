$ErrorActionPreference='Stop'
$source=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'packaged-mixed-preview-support-ci.ps1') -Raw
$part=($source -split '# BEGIN tested-preview-record-parser')[1] -split '# END tested-preview-record-parser'
Invoke-Expression $part[0]
$json='[{"path":"C:\\Temp\\one.txt"},{"path":"C:\\Temp\\two.txt"},{"path":"C:\\Temp\\three.txt"},{"path":"C:\\Temp\\four.txt"},{"path":"C:\\Temp\\five.txt"},{"path":"C:\\Temp\\six.txt"}]'
$records=Read-PreviewRecords $json
if($records.Count -ne 6 -or $records[0].path -cne 'C:\Temp\one.txt' -or $records[2].path -cne 'C:\Temp\three.txt'){throw 'valid array parse failed'}
foreach($bad in @('[]','{}','null','[{"path":"a"}]','[[{"path":"a"},{"path":"b"},{"path":"c"}]]','[{"path":1},{"path":"b"},{"path":"c"}]')){
 $failed=$false;try{$null=Read-PreviewRecords $bad}catch{$failed=$true};if(-not $failed){throw ('accepted invalid array: '+$bad)}
}
Write-Output ('preview JSON parse 7 PASS PowerShell '+$PSVersionTable.PSVersion)
