# Pure string transformation only. No fixture/native/attribute operations.
$ErrorActionPreference='Stop'
$source=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'packaged-copyout-support-ci.ps1') -Raw
$match=[regex]::Match($source,'(?s)# BEGIN tested-copy-fixture-wire(.*?)# END tested-copy-fixture-wire')
if(-not $match.Success){throw 'wire function missing'}
. ([scriptblock]::Create($match.Groups[1].Value))
$name=([char]0x65e5).ToString()+[char]0x672c+[char]0x8a9e+[char]0xd83d+[char]0xde80
$value=@(@{path=('C:'+ [IO.Path]::DirectorySeparatorChar + $name+'.txt');label=$name;quote='"quoted"';line="a
b"},@{path='ASCII.txt';label='plain'})
$wire=Convert-CopyFixtureWire $value
if([regex]::IsMatch($wire,'[^\u0000-\u007f]')){throw 'wire not ASCII'}
$round=$wire|ConvertFrom-Json
if($round.Count -ne 2 -or $round[0].path -cne $value[0].path -or $round[0].label -cne $name -or $round[0].quote -cne $value[0].quote -or $round[0].line -cne $value[0].line -or $round[1].path -cne 'ASCII.txt'){throw 'wire roundtrip mismatch'}
if($wire -notmatch '\\ud83d\\ude80'){throw 'non-BMP surrogate pair not escaped'}
$single=Convert-CopyFixtureWire @(@{path=$name})
if(-not $single.StartsWith('[') -or @($single|ConvertFrom-Json).Count -ne 1){throw 'single record array lost'}
'PASS packaged copy support ASCII wire Japanese/non-BMP/quote/newline/single-array roundtrip; no native execution'
