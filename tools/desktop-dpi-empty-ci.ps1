$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted'){throw 'hosted only'}
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root=Split-Path $PSScriptRoot -Parent;$fixture=Join-Path $PSScriptRoot 'desktop-dpi-empty-fixture-ci.js';$uiAttempted=$false;$originalRecycle=$null;$safeRestore=$true
function FindNamed($name,$type){return @([Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition)|Where-Object{$_.Current.Name -eq $name -and $_.Current.ControlType -eq $type})}
function OpenIcons {
 Start-Process explorer.exe -ArgumentList 'ms-settings:themes' -WindowStyle Hidden;Start-Sleep -Seconds 3
 $links=@(FindNamed 'Desktop icon settings' ([Windows.Automation.ControlType]::Hyperlink));if($links.Count -ne 1){$links=@(FindNamed 'Desktop icon settings' ([Windows.Automation.ControlType]::Button))};if($links.Count -ne 1){throw 'desktop-icons-link-unknown'};$links[0].GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke();Start-Sleep -Milliseconds 500
 $boxes=@(FindNamed 'Recycle Bin' ([Windows.Automation.ControlType]::CheckBox));if($boxes.Count -ne 1){throw 'recycle-checkbox-unknown'};return $boxes[0]
}
function ApplyIcons($box,$wanted){$p=$box.GetCurrentPattern([Windows.Automation.TogglePattern]::Pattern);if([int]$p.Current.ToggleState -ne $wanted){$p.Toggle()};if([int]$p.Current.ToggleState -ne $wanted){throw 'recycle-toggle-unverified'};$parent=[Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($box);while($parent -and $parent.Current.ControlType -ne [Windows.Automation.ControlType]::Window){$parent=[Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($parent)};if(-not $parent){throw 'icon-dialog-unknown'};$buttons=@($parent.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition)|Where-Object{$_.Current.Name -eq 'OK' -and $_.Current.ControlType -eq [Windows.Automation.ControlType]::Button});if($buttons.Count -ne 1){throw 'icon-dialog-ok-unknown'};$buttons[0].GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke();Start-Sleep -Milliseconds 700}
try{
 & node $fixture hide;if($LASTEXITCODE -ne 0){throw 'fixture-hide-failed'}
 $box=OpenIcons;$originalRecycle=[int]$box.GetCurrentPattern([Windows.Automation.TogglePattern]::Pattern).Current.ToggleState;if($originalRecycle -notin @(0,1)){throw 'recycle-initial-state-unknown'};$uiAttempted=$true;@{phase='before-ui-hide';originalRecycle=$originalRecycle}|ConvertTo-Json|Set-Content (Join-Path $root 'dpi-empty-ui.json');ApplyIcons $box 0
 & node $fixture empty;if($LASTEXITCODE -ne 0){throw 'fixture-not-empty'}
 $source=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'desktop-dpi-ui-ci.ps1'))
 $hook=@'
 $native=New-Object Diagnostics.Process;$native.StartInfo.FileName='node.exe';$native.StartInfo.Arguments='"'+(Join-Path $PSScriptRoot 'unknown-grid-success-ci.js')+'" "'+[Environment]::GetFolderPath('Desktop')+'"';$native.StartInfo.UseShellExecute=$false;$native.StartInfo.CreateNoWindow=$true;$native.StartInfo.WorkingDirectory=Split-Path $PSScriptRoot -Parent;$native.StartInfo.EnvironmentVariables['OKIBA_UNKNOWN_EXPECTED_SCALE']='150';$native.StartInfo.EnvironmentVariables['OKIBA_UNKNOWN_CASES']='success,no-fit'
 try{$null=$native.Start();$nativeStarted=$true;if(-not $native.WaitForExit(240000)){throw 'native-timeout-unresolved'};$n=Get-Content (Join-Path $native.StartInfo.WorkingDirectory 'unknown-grid-success-ci.json') -Raw|ConvertFrom-Json;$report.nativeEvidence=$n;$nativeVerified=($native.ExitCode -eq 0 -and $n.passed -and $n.cleanupVerified -and -not $n.cleanupError -and $n.actualScale -eq 150 -and (($n.cases -join ',') -ceq 'success,no-fit'));if(-not $nativeVerified){throw 'native-cleanup-unverified'};$report.status='single-150-empty-native-verified'}finally{$native.Dispose()}
'@
 $anchor=" `$report.status='actual-150-spacing-readonly-verified'";if(-not $source.Contains($anchor)){throw 'dpi-hook-anchor-missing'};$source=$source.Replace($anchor,$hook);$source=$source.Replace('$PSScriptRoot',("'"+$PSScriptRoot.Replace("'","''")+"'"));$safeRestore=$false;& ([scriptblock]::Create($source))
 $r=Get-Content (Join-Path $root 'desktop-dpi-ui-ci.json') -Raw|ConvertFrom-Json;if($r.restoreSkippedDueToUnresolvedLease){$safeRestore=$false;throw 'lease-unresolved-no-fixture-restoration'};$safeRestore=$true;if($r.status -ne 'single-150-empty-native-verified'){throw ('native-proof-failed:'+ $r.reason)}
}catch{$failureReason=$_.Exception.Message;throw}finally{
 if($safeRestore){
  $failures=@();try{& node $fixture restore;if($LASTEXITCODE -ne 0){throw 'attribute-restore-failed'}}catch{$failures+=$_.Exception.Message}
  if($uiAttempted){try{$box=OpenIcons;ApplyIcons $box $originalRecycle;@{phase='ui-restored';originalRecycle=$originalRecycle}|ConvertTo-Json|Set-Content (Join-Path $root 'dpi-empty-ui.json')}catch{$failures+=$_.Exception.Message}}
  try{& node $fixture verify;if($LASTEXITCODE -ne 0){throw 'fixture-final-difference'}}catch{$failures+=$_.Exception.Message}
  @{scope='single150 empty only; initial fixture positions not protection proof';failures=$failures;fixtureRestored=($failures.Count -eq 0)}|ConvertTo-Json -Depth 8|Set-Content (Join-Path $root 'dpi-empty-restore.json');if($failures.Count){throw ($failures -join ';')}
 }else{@{restoreSkippedDueToUnresolvedLease=$true;reason=$failureReason;state='native-or-invoked-script-termination-unverified'}|ConvertTo-Json|Set-Content (Join-Path $root 'dpi-empty-restore.json')}
}
