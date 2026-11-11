$ErrorActionPreference='Stop'
$e=$null;$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '../scripts/unknown-grid-lease.ps1'),[ref]$null,[ref]$e);if($e){throw $e}
$f=$ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Unknown-ValidatorBundle'},$true)[0]
Invoke-Expression $f.Extent.Text
function Test-Path {param($LiteralPath,$PathType) return $script:files.ContainsKey([IO.Path]::GetFullPath($LiteralPath))}
function Get-Content {param($LiteralPath,[switch]$Raw,$Encoding) return $script:manifest}
$root='C:\test-fixture\repo';$script:manifest='{"name":"okiba-board"}';$n=0
function Init($r,$bundle){$script:files=@{};foreach($f in @('desktop-unknown-grid-validator.js','desktop-unknown-grid-model.js','desktop-unknown-grid-json-wire.js')){$script:files[(Join-Path (Join-Path $r $bundle) $f)]=$true}}
function Reject($r){try{$null=Unknown-ValidatorBundle $r}catch{$script:n++;return};throw 'expected refusal'}
Init $root 'lib';$script:files[(Join-Path $root 'package.json')]=$true
if((Unknown-ValidatorBundle $root) -ne (Join-Path $root 'lib/desktop-unknown-grid-validator.js')){throw 'dev path'};$n++
$script:manifest='{"name":"other"}';Reject $root;$script:manifest='{"name":"okiba-board"}'
$script:files.Remove((Join-Path $root 'lib/desktop-unknown-grid-model.js'));Reject $root
$r='C:\test-fixture\resources';Init $r 'lib';$script:files[(Join-Path $r 'package.json')]=$true;Reject $r
$script:files[(Join-Path $r 'app.asar')]=$true;Reject $r
Init $r 'unknown-validator';$script:files[(Join-Path $r 'app.asar')]=$true
if((Unknown-ValidatorBundle $r) -ne (Join-Path $r 'unknown-validator/desktop-unknown-grid-validator.js')){throw 'packaged path'};$n++
Write-Output "bundle origin $n pure checks PASS; no filesystem or Desktop mutation"
