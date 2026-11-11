$ErrorActionPreference='Stop'
$source=Get-Content (Join-Path $PSScriptRoot '../scripts/shell-helper.ps1') -Raw
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors)
$names=@('Strict-IconKey','Strict-GeometryKey','Strict-IconsKey','Get-StrictTransactionState')
foreach($name in $names){$f=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true);Invoke-Expression $f.Extent.Text}
$n=0
function Assert-Case([bool]$condition,[string]$label){if(-not $condition){throw $label};$script:n++;Write-Host ('ok - '+$label)}
function Snap($icons){return @{ok=$true;icons=@($icons);areas=@();origin=@{x=0;y=0};sx=100;sy=100;viewDpi=96;explorerPid=1;explorerStarted='1';listviewHwnd=1;autoArrange=$false;snap=$true}}
$a=Snap @(@{identity='a';label='same';x=0;y=0},@{identity='b';label='same';x=100;y=0})
$b=Snap @(@{identity='b';label='same';x=0;y=0},@{identity='a';label='same';x=100;y=0})
$r=Get-StrictTransactionState $a $b @()
Assert-Case (-not $r.ok -and $r.reason -eq 'existing-icon-changed') 'same-label identity swap rejected'
$b=Snap @(@{identity='a';label='renamed';x=0;y=0},@{identity='b';label='same';x=100;y=0})
Assert-Case ((Get-StrictTransactionState $a $b @()).ok) 'label is diagnostic not identity'
$b=Snap @(@{identity='a';label='same';x=0;y=0},@{identity='a';label='same';x=100;y=0})
Assert-Case (-not (Get-StrictTransactionState $a $b @()).ok) 'duplicate identity rejected'
$b=Snap @(@{label='same';x=0;y=0},@{identity='b';label='same';x=100;y=0})
Assert-Case (-not (Get-StrictTransactionState $a $b @()).ok) 'missing identity rejected'
$target=@{path='C:\fixture\expected.txt';name='same'}
$b=Snap @($a.icons+@{identity='c';label='same';path='C:\fixture\other.txt';x=200;y=0})
Assert-Case (-not (Get-StrictTransactionState $a $b @($target)).ok) 'same-name wrong target path rejected'
$b=Snap @($a.icons+@{identity='c';label='different';path='c:\fixture\EXPECTED.txt';x=200;y=0})
$r=Get-StrictTransactionState $a $b @($target)
Assert-Case ($r.ok -and $r.new[0].identity -eq 'c') 'target uses canonical path not label'
Assert-Case ((Strict-IconsKey $a) -cne (Strict-IconsKey (Snap @(@{identity='b';label='same';x=0;y=0},@{identity='a';label='same';x=100;y=0})))) 'stable snapshot identity swap changes key'
Write-Host ('desktop identity selftest: '+$n+' checks passed')
