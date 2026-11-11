$ErrorActionPreference='Stop'
$source=Get-Content (Join-Path $PSScriptRoot '../scripts/shell-helper.ps1') -Raw
$keyType=[regex]::Match($source,"(?s)Add-Type -TypeDefinition @'\r?\n(using System;\r?\nusing System.Text;.*?public static class OkibaSnapshotKey.*?)(?:\r?\n)'@")
if(-not $keyType.Success){throw 'production-key-class-not-found'}
Add-Type -TypeDefinition $keyType.Groups[1].Value
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

# Diagnostic fields preserve the deepest exception without changing retry policy.
$com=[Runtime.InteropServices.COMException]::new('opaque-shell-failure',-2147023728)
$middle=[Reflection.TargetInvocationException]::new('middle-wrapper',$com)
$outer=[Exception]::new('outer-wrapper',$middle)
$d=Get-ShellSnapshotFailure $outer
Assert-Case ($d.reason -ceq 'shell-snapshot-error' -and -not $d.ok) 'HRESULT diagnostics do not make COM retryable'
Assert-Case ($d.detail -ceq 'outer-wrapper') 'legacy outer detail preserved'
Assert-Case ($d.innerDetail -ceq 'opaque-shell-failure') 'deepest message retained'
Assert-Case ($d.errorType -ceq 'System.Runtime.InteropServices.COMException' -and $d.hresult -ceq '0x80070490') 'deepest HRESULT and type retained'
$j=$d|ConvertTo-Json -Compress|ConvertFrom-Json
Assert-Case ($j.hresult -ceq $d.hresult -and $j.innerDetail -ceq $d.innerDetail -and $j.errorType -ceq $d.errorType) 'diagnostics survive JSON wire'
$t=Get-ShellSnapshotFailure ([Reflection.TargetInvocationException]::new('wrapper',[InvalidOperationException]::new('item-count-changed')))
Assert-Case ($t.reason -ceq 'desktop-changing' -and $t.errorType -ceq 'System.InvalidOperationException' -and $t.innerDetail -ceq 'item-count-changed') 'known transient classification unchanged'
Write-Host ('desktop identity/diagnostics total: '+$n+' checks passed; no desktop calls')
