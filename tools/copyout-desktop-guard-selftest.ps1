$ErrorActionPreference='Stop'
$code=Get-Content (Join-Path $PSScriptRoot '../scripts/copyout-native.cs') -Raw
Add-Type -TypeDefinition $code
$method=[OkibaCopyOutFiles].GetMethod('RejectDesktopDestination',[Reflection.BindingFlags]'NonPublic,Static')
if($null -eq $method){throw 'missing pure guard'}
$checks=0
function Test-Pure([string]$folder,[string]$user,[string]$common,[string]$expected){
 $reason=$null
 try{$method.Invoke($null,@($folder,$user,$common))|Out-Null}catch{$reason=$_.Exception.InnerException.InnerException.Message;if(!$reason){$reason=$_.Exception.InnerException.Message}}
 if($expected){if($reason -ne $expected){throw "unexpected rejection $reason expected $expected"}}elseif($reason){throw $reason}
 $script:checks++
}
$u='D:\Moved User Desktop';$c='E:\Moved Public Desktop'
Test-Pure $u $u $c 'copy-desktop-destination-refused'
Test-Pure ($u+'\') $u $c 'copy-desktop-destination-refused'
Test-Pure $u.ToUpperInvariant() $u $c 'copy-desktop-destination-refused'
Test-Pure 'D:\ordinary\..\Moved User Desktop' $u $c 'copy-desktop-destination-refused'
Test-Pure $c $u $c 'copy-desktop-destination-refused'
Test-Pure 'E:/Moved Public Desktop/' $u $c 'copy-desktop-destination-refused'
Test-Pure ($u+'\Exports') $u $c $null
Test-Pure 'C:\owned-test-folder' $u $c $null
Test-Pure 'C:\owned-test-folder' '' $c 'copy-desktop-location-unverified'
$body=$code.Substring($code.IndexOf('public static CopyResult Copy('))
$guard=$body.IndexOf('RejectDesktopDestination(folder,')
foreach($anchor in @('source=Full(source)','new Pins(','Open(source,','CreateFileW(')){
 if($guard -lt 0 -or $body.IndexOf($anchor) -lt $guard){throw ('guard ordering: '+$anchor)};$checks++
}
foreach($anchor in @('Environment.SpecialFolder.DesktopDirectory','Environment.SpecialFolder.CommonDesktopDirectory','Environment.SpecialFolderOption.DoNotVerify')){
 if(!$body.Contains($anchor)){throw ('missing OS known folder: '+$anchor)};$checks++
}
"copyout desktop guard: $checks pure/ordering checks PASS (Copy never called, no Desktop access)"

# Test-only copy of the class: replace only the two known-folder reads with owned TEMP.
# The production class contains no test hook. Never pass an actual Desktop path to Copy.
$root=Join-Path ([IO.Path]::GetTempPath()) ('okiba-copy-desktop-guard-'+[Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root)|Out-Null
try {
 $dest=Join-Path $root 'simulated-desktop';[IO.Directory]::CreateDirectory($dest)|Out-Null
 $source=Join-Path $root 'owned.bin';[IO.File]::WriteAllBytes($source,[byte[]](1,2,3,4));[IO.File]::SetAttributes($source,34)
 $hash=(Get-FileHash -LiteralPath $source).Hash
 $testCode=$code.Replace('OkibaCopyOutFiles','OkibaCopyDesktopOwnedTest')
 foreach($name in @('DesktopDirectory','CommonDesktopDirectory')){
  $needle='Environment.GetFolderPath(Environment.SpecialFolder.'+$name+',Environment.SpecialFolderOption.DoNotVerify)'
  if(([regex]::Matches($testCode,[regex]::Escape($needle))).Count -ne 1){throw 'test knownfolder replacement count'}
  $testCode=$testCode.Replace($needle,('@"'+$dest.Replace('"','""')+'"'))
 }
 Add-Type -TypeDefinition $testCode
 $result=[OkibaCopyDesktopOwnedTest]::Copy($source,$dest)
 if($result.reason -ne 'copy-desktop-destination-refused' -or $result.copied -or $result.partialPath -or !$result.cleanupVerified){throw ($result|ConvertTo-Json -Compress)}
 if(@(Get-ChildItem -LiteralPath $dest -Force).Count -ne 0 -or (Get-FileHash -LiteralPath $source).Hash -ne $hash -or [int][IO.File]::GetAttributes($source) -ne 34){throw 'owned fixture changed'}
 'copyout simulated-knownfolder rejection PASS (only owned TEMP, no real Desktop path)'
}finally{
 $absolute=[IO.Path]::GetFullPath($root)
 if([IO.Path]::GetDirectoryName($absolute) -ne [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') -or [IO.Path]::GetFileName($absolute) -notlike 'okiba-copy-desktop-guard-*'){throw 'cleanup scope'}
 Remove-Item -LiteralPath $absolute -Recurse -Force
}
