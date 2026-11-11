$ErrorActionPreference='Stop'
$source=Get-Content (Join-Path $PSScriptRoot '../scripts/shell-helper.ps1') -Raw
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors)
$names=@('Get-ShellSnapshotFailure','Strict-IconKey','Strict-GeometryKey','Strict-IconsKey','Get-StrictTransactionState')
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

foreach($message in @('item-count-changed','pidl-order-changed')){
  $inner=[InvalidOperationException]::new($message)
  $wrapped=[Reflection.TargetInvocationException]::new('invocation failed',$inner)
  Assert-Case ((Get-ShellSnapshotFailure $wrapped).reason -eq 'desktop-changing') ('exact transient '+$message)
}
foreach($message in @('duplicate-shell-identity','item-count-changed unexpectedly','ITEM-COUNT-CHANGED','access-denied')){
  Assert-Case ((Get-ShellSnapshotFailure ([InvalidOperationException]::new($message))).reason -eq 'shell-snapshot-error') ('non-transient remains fatal '+$message)
}
Assert-Case ((Get-ShellSnapshotFailure ([Runtime.InteropServices.COMException]::new('item-count-changed'))).reason -eq 'shell-snapshot-error') 'COM error never becomes transient'
$a=Snap @();$b=Snap @()
$a.areas=@(@{left=0;top=0;right=1000;bottom=1000;scale=100;monitorOrigin=[ordered]@{x=5;y=7}})
$b.areas=@(@{left=0;top=0;right=1000;bottom=1000;scale=100;monitorOrigin=[ordered]@{y=7;x=5}})
Assert-Case ((Strict-GeometryKey $a) -ceq (Strict-GeometryKey $b)) 'monitorOrigin property order irrelevant'
$b=($b|ConvertTo-Json -Depth 8|ConvertFrom-Json)
Assert-Case ((Strict-GeometryKey $a) -ceq (Strict-GeometryKey $b)) 'JSON roundtrip geometry stable'
$b.areas[0].monitorOrigin.x=6
Assert-Case ((Strict-GeometryKey $a) -cne (Strict-GeometryKey $b)) 'real monitor origin change detected'
Assert-Case (-not (Get-StrictTransactionState $a $b @()).ok) 'changed geometry transaction still rejected'
Write-Host ('desktop identity/stability total: '+$n+' checks passed; no desktop calls')
