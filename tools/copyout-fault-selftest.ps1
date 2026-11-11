$ErrorActionPreference='Stop'
$sourceCode=Get-Content (Join-Path $PSScriptRoot '../scripts/copyout-native.cs') -Raw
$root=Join-Path ([IO.Path]::GetTempPath()) ('okiba-copy-fault-'+[Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root)|Out-Null
try {
 $src=Join-Path $root 'source.bin';[IO.File]::WriteAllBytes($src,(New-Object byte[] 1048576));[IO.File]::SetAttributes($src,34)
 $beforeHash=(Get-FileHash -LiteralPath $src).Hash
 $n=0
 foreach($phase in @('before-publish','after-publish')) {
  $type='OkibaCopyFault'+$n;$code=$sourceCode.Replace('OkibaCopyOutFiles',$type)
  $marker=if($phase -eq 'before-publish'){'Absent(dest);Rename(dh,dest);'}else{'current=RecordOf(dh,dest);Hidden(dh,dest,current.identity,current.size,current.mtime,current.attributes,false);'}
  if(([regex]::Matches($code,[regex]::Escape($marker))).Count -ne 1){throw 'fault injection anchor'}
  $code=$code.Replace($marker,('if(DateTime.UtcNow.Ticks>0)throw new InvalidOperationException("injected-'+$phase+'");'+$marker))
  Add-Type -TypeDefinition $code
  $dest=Join-Path $root ('dest'+$n);[IO.Directory]::CreateDirectory($dest)|Out-Null
  $r=($type -as [type])::Copy($src,$dest)
  if($r.copied -or !$r.cleanupVerified -or $r.partialPath -or $r.reason -notlike ('injected-'+$phase+'*')){throw ($r|ConvertTo-Json -Compress)}
  if(@(Get-ChildItem -LiteralPath $dest -Force).Count -ne 0){throw 'own partial not removed'}
  if((Get-FileHash -LiteralPath $src).Hash -ne $beforeHash -or [int][IO.File]::GetAttributes($src) -ne 34){throw 'source changed'}
  $n++
 }
 'copyout fault: before/after publish failures preserve source and clean only owned handle PASS'
} finally {
 $resolved=[IO.Path]::GetFullPath($root);$parent=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
 if([IO.Path]::GetDirectoryName($resolved) -ne $parent -or [IO.Path]::GetFileName($resolved) -notlike 'okiba-copy-fault-*'){throw 'cleanup scope'}
 Remove-Item -LiteralPath $resolved -Recurse -Force
}
