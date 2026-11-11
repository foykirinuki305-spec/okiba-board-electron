# Native Process streams only, no Desktop/Shell/user material API.
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.Encoding]::UTF8
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$node=(Get-Command node.exe).Source
$p=New-Object Diagnostics.Process;$p.StartInfo.FileName=$node;$p.StartInfo.Arguments='"'+(Join-Path (Get-Location) 'tools/unknown-grid-json-probe-ci.js')+'"';$p.StartInfo.UseShellExecute=$false;$p.StartInfo.CreateNoWindow=$true;$p.StartInfo.RedirectStandardInput=$true;$p.StartInfo.RedirectStandardOutput=$true;$p.StartInfo.RedirectStandardError=$true;$p.StartInfo.StandardOutputEncoding=[Text.Encoding]::UTF8
# Use codepoints so Windows PowerShell's source-file encoding cannot affect this fixture.
$japanese=([string][char]0x65e5)+[char]0x672c+[char]0x8a9e
$payload=@{path=('C:\fixtures\'+$japanese+'.mp4');value=$japanese}|ConvertTo-Json -Compress
try{
 if(-not $p.Start()){throw 'probe-start'};$output=$p.StandardOutput.ReadToEndAsync();$err=$p.StandardError.ReadToEndAsync();$p.StandardInput.Write($payload);$p.StandardInput.Close();if(-not $p.WaitForExit(5000)){$p.Kill();$null=$p.WaitForExit(5000);throw 'probe-timeout'};$wire=$output.GetAwaiter().GetResult();$r=$wire|ConvertFrom-Json
 if($p.ExitCode -ne 0 -or -not $r.ok -or $r.parsed.value -cne $japanese -or $r.parsed.path -cne ('C:\fixtures\'+$japanese+'.mp4')){throw ('probe-roundtrip:'+ $wire)}
 if([int][char]$wire[0] -ne 123){throw 'output-bom-or-nonjson'}
 Write-Output ('PASS native no-Desktop JSON roundtrip; PS='+$PSVersionTable.PSVersion+' stdinFirstBytes='+$r.firstBytes+' stdoutFirstCodePoint='+[int][char]$wire[0])
}finally{$p.Dispose()}
