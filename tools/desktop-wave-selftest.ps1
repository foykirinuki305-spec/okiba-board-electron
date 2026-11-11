# Pure production-function tests. No helper startup, native calls or Desktop access.
$ErrorActionPreference='Stop'
$repo=if($PSScriptRoot){Split-Path $PSScriptRoot}else{(Get-Location).Path}
$errors=$null;$tokens=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $repo 'scripts\shell-helper.ps1'),[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Helper syntax errors'}
foreach($name in @('Strict-Overlap','Strict-Near','Get-StrictFreeWave')){
 $fn=@($ast.FindAll({param($a) $a -is [Management.Automation.Language.FunctionDefinitionAst] -and $a.Name -eq $name},$true))
 if($fn.Count -ne 1){throw ('Missing unique pure function '+$name)}
 . ([scriptblock]::Create($fn[0].Extent.Text))
}
$script:checks=0
function AssertTrue($v,$message){if(-not $v){throw $message};$script:checks++;Write-Host ('ok - '+$message)}
function Point([int]$x,[int]$y=0){return @{x=$x;y=$y}}
$grid=@{sx=100;sy=100};$buffer=Point 900
$state=@{new=@{0=(Point 0);1=(Point 100);2=(Point 200)}}
$targets=@((Point 400),(Point 500),(Point 600))
$wave=Get-StrictFreeWave $state $targets @(0,1,2) $buffer $grid
AssertTrue ($wave.ok -and $wave.items.Count -eq 3) 'three independent free targets form one batch'
$targets=@((Point 100),(Point 0),(Point 600))
$wave=Get-StrictFreeWave $state $targets @(0,1,2) $buffer $grid
AssertTrue ($wave.ok -and $wave.items.Count -eq 1 -and $wave.items[0].index -eq 2) 'unblocked member moves before cyclic pair'
$state.new[2]=Point 600
$wave=Get-StrictFreeWave $state $targets @(0,1) $buffer $grid
AssertTrue ($wave.ok -and $wave.items.Count -eq 1 -and (Strict-Near $wave.items[0].destination $buffer)) 'cycle uses exactly one reserved buffer'
$state.new[0]=Point 900
$wave=Get-StrictFreeWave $state $targets @(0,1) $buffer $grid
AssertTrue ($wave.ok -and $wave.items.Count -eq 1 -and $wave.items[0].index -eq 1) 'cycle frees the next item without overlap'
$state.new[1]=Point 0
$wave=Get-StrictFreeWave $state $targets @(0) $buffer $grid
AssertTrue ($wave.ok -and $wave.items.Count -eq 1 -and $wave.items[0].index -eq 0 -and $wave.items[0].destination.x -eq 100) 'buffered member returns to its exact target'
$state=@{new=@{0=(Point 0);1=(Point 100);2=(Point 900)}}
$wave=Get-StrictFreeWave $state @((Point 100),(Point 0),(Point 900)) @(0,1) $buffer $grid
AssertTrue (-not $wave.ok -and $wave.reason -eq 'buffer-occupied') 'occupied buffer refuses cyclic move'
$state=@{new=@{0=(Point 0);1=(Point 100)}}
$wave=Get-StrictFreeWave $state @((Point 100),(Point 300)) @(0,1) $buffer $grid
AssertTrue ($wave.ok -and $wave.items.Count -eq 1 -and $wave.items[0].index -eq 1) 'chain dependency is not assumed atomic'
$state=@{new=@{0=(Point 0);1=(Point 120)}}
$wave=Get-StrictFreeWave $state @((Point 200),(Point 0)) @(0,1) $buffer @{sx=150;sy=150}
AssertTrue ($wave.ok -and $wave.items.Count -eq 1 -and $wave.items[0].destination.x -eq 900) 'larger monitor cell overlap is respected'
Write-Host ('desktop free-wave pure tests: '+$checks+' passed')
