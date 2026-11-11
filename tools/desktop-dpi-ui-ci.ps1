$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted'){throw 'Hosted Windows only; never user desktop'}
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;using System.Collections.Generic;using System.Runtime.InteropServices;
public static class DpiUiProbe{
 public delegate bool Callback(IntPtr h,IntPtr dc,IntPtr r,IntPtr d);
 [DllImport("user32.dll")]static extern bool EnumDisplayMonitors(IntPtr dc,IntPtr clip,Callback cb,IntPtr data);
 [DllImport("shcore.dll")]static extern int GetScaleFactorForMonitor(IntPtr h,out int scale);
 [DllImport("user32.dll")]static extern bool SetProcessDpiAwarenessContext(IntPtr c);
 public static void Aware(){SetProcessDpiAwarenessContext(new IntPtr(-4));}
 public static int[][] Read(){var rows=new List<int[]>();Callback cb=(h,dc,r,d)=>{int s;int hr=GetScaleFactorForMonitor(h,out s);rows.Add(new int[]{s,hr});return true;};EnumDisplayMonitors(IntPtr.Zero,IntPtr.Zero,cb,IntPtr.Zero);return rows.ToArray();}
}
'@
[DpiUiProbe]::Aware()
$report=@{status='blocked';scope='Hosted Settings UI only; no icon mutation; mixed-monitor not proven';before=@([DpiUiProbe]::Read());changed=$false;restored=$false}
$combo=$null;$original=$null;$settings=$null;$resolutionOriginal=$null;$resolutionChanged=$false;$nativeStarted=$false;$nativeVerified=$false
function Elements([int]$processId){$c=New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ProcessIdProperty,$processId);return [Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Descendants,$c)}
function Expand($c){$p=$null;if($c.TryGetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern,[ref]$p)){$p.Expand();Start-Sleep -Milliseconds 400}}
function Options([int]$processId){return @(Elements $processId|Where-Object{$_.Current.ControlType -eq [Windows.Automation.ControlType]::ListItem})}
function ResolutionCombo {
 $a=@(Elements $settings.Id|Where-Object{$_.Current.AutomationId -eq 'SystemSettings_Display_Resolution_ComboBox'});if($a.Count -ne 1){throw 'resolution-combo-not-unique'};return $a[0]
}
function ConfirmResolution {
 $deadline=[DateTime]::UtcNow.AddSeconds(8)
 do{$b=@(Elements $settings.Id|Where-Object{$_.Current.ControlType -eq [Windows.Automation.ControlType]::Button -and $_.Current.Name -eq 'Keep changes'});if($b.Count -eq 1){$b[0].GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke();return};Start-Sleep -Milliseconds 200}while([DateTime]::UtcNow -lt $deadline)
 Start-Sleep -Seconds 15;throw 'resolution-confirmation-unavailable-auto-revert-waited'
}
function Read-DesktopEvidence {
 $capture=@{}
 # Read-only production helper: stdin closes immediately after the snapshot request.
 $helper=$script:metricsHelper;$p=New-Object Diagnostics.Process;$p.StartInfo.FileName='powershell.exe';$p.StartInfo.Arguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$helper+'"';$p.StartInfo.UseShellExecute=$false;$p.StartInfo.CreateNoWindow=$true;$p.StartInfo.RedirectStandardInput=$true;$p.StartInfo.RedirectStandardOutput=$true;$p.StartInfo.RedirectStandardError=$true
 try{$null=$p.Start();$out=$p.StandardOutput.ReadToEndAsync();$err=$p.StandardError.ReadToEndAsync();$p.StandardInput.WriteLine('{"id":1,"cmd":"desktopSnapshot"}');$p.StandardInput.Close();if(-not $p.WaitForExit(20000)){$p.Kill();if(-not $p.WaitForExit(5000)){throw 'readonly-helper-stop-unconfirmed'};throw 'readonly-helper-timeout'};$capture.output=$out.GetAwaiter().GetResult();$capture.error=$err.GetAwaiter().GetResult();$rows=@($capture.output -split '\r?\n'|Where-Object{$_}|ForEach-Object{$_|ConvertFrom-Json});$answer=@($rows|Where-Object{$_.id -eq 1});if($answer.Count -ne 1 -or -not $answer[0].result.ok){throw 'desktop-snapshot-unavailable'};$capture.snapshot=$answer[0].result}catch{$report.lastSnapshotFailure=$capture;throw}finally{$p.Dispose()}
 return $capture
}
try{
 $script:metricsHelper=(& node (Join-Path $PSScriptRoot 'desktop-dpi-metrics-copy-ci.js'));if($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $script:metricsHelper)){throw 'metrics-copy-failed'}
 $report.spacingDiagnosticSchema=@('currentHRESULT','currentX','currentY','defaultHRESULT','defaultX','defaultY')
 $report.beforeEvidence=Read-DesktopEvidence
 Start-Process explorer.exe -ArgumentList 'ms-settings:display' -WindowStyle Hidden|Out-Null
 $until=[DateTime]::UtcNow.AddSeconds(25)
 do{$settings=Get-Process SystemSettings -ErrorAction SilentlyContinue|Select-Object -First 1;if($settings){break};Start-Sleep -Milliseconds 250}while([DateTime]::UtcNow -lt $until)
 if(-not $settings){throw 'settings-ui-unavailable'}
 do{$combos=@(Elements $settings.Id|Where-Object{$_.Current.ControlType -eq [Windows.Automation.ControlType]::ComboBox});if($combos.Count){break};Start-Sleep -Milliseconds 300}while([DateTime]::UtcNow -lt $until)
 $report.combos=@($combos|ForEach-Object{@{name=$_.Current.Name;id=$_.Current.AutomationId}})
 $candidates=@($combos|Where-Object{($_.Current.Name+' '+$_.Current.AutomationId) -match '(?i)scale|scaling|dpi|拡大|縮小'})
 if($candidates.Count -ne 1){throw 'scale-combo-not-unambiguous'};$combo=$candidates[0]
 $selection=$combo.GetCurrentPattern([Windows.Automation.SelectionPattern]::Pattern).Current.GetSelection();if($selection.Count -ne 1){throw 'original-scale-unknown'};$original=$selection[0].Current.Name;$report.original=$original
 Expand $combo;$options=@(Options $settings.Id);$report.options=@($options|ForEach-Object{$_.Current.Name})
 $target=@($options|Where-Object{$_.Current.Name -match '^150\s*%($|\s|\()'})
 if($target.Count -eq 0){
  $combo.GetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern).Collapse()
  $rc=ResolutionCombo;$rs=$rc.GetCurrentPattern([Windows.Automation.SelectionPattern]::Pattern).Current.GetSelection();if($rs.Count -ne 1){throw 'original-resolution-unknown'};$resolutionOriginal=$rs[0].Current.Name;$report.originalResolution=$resolutionOriginal
  Expand $rc;$ro=@(Options $settings.Id);$report.resolutionOptions=@($ro|ForEach-Object{$_.Current.Name})
  $rt=@($ro|Where-Object{$_.Current.Name -match '^1920\s*[^0-9\s]\s*1080($|\s|\()'});if($rt.Count -ne 1){throw '1920x1080-resolution-unavailable-or-ambiguous'}
  $resolutionChanged=$true;$report.resolutionChanged=$true;$rt[0].GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern).Select()
  $report.resolutionBeforeConfirm=Read-DesktopEvidence;if(-not @($report.resolutionBeforeConfirm.snapshot.areas|Where-Object{($_.right-$_.left) -eq 1920}).Count){throw '1920-resolution-before-confirm-unverified'}
  ConfirmResolution;$report.resolutionAfterConfirm=Read-DesktopEvidence;if(-not @($report.resolutionAfterConfirm.snapshot.areas|Where-Object{($_.right-$_.left) -eq 1920}).Count){throw '1920-resolution-after-confirm-unverified'}
  $cs=@(Elements $settings.Id|Where-Object{$_.Current.AutomationId -eq 'SystemSettings_Display_Scaling_ItemSizeOverride_ComboBox'});if($cs.Count -ne 1){throw 'scale-combo-reacquire-failed'};$combo=$cs[0];Expand $combo;$options=@(Options $settings.Id);$report.optionsAfterResolution=@($options|ForEach-Object{$_.Current.Name})
 $target=@($options|Where-Object{$_.Current.Name -match '^150\s*%($|\s|\()'})
 }
 if($target.Count -ne 1){throw '150-option-unavailable-or-ambiguous'}
 $report.changed=$true;$target[0].GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern).Select()
 $deadline=[DateTime]::UtcNow.AddSeconds(15)
 do{$actual=@([DpiUiProbe]::Read());if(@($actual|Where-Object{$_[0] -eq 150 -and $_[1] -eq 0}).Count){break};Start-Sleep -Milliseconds 300}while([DateTime]::UtcNow -lt $deadline)
 $report.actual=$actual;if(-not @($actual|Where-Object{$_[0] -eq 150 -and $_[1] -eq 0}).Count){throw 'native-scale-not-150'}
 $report.changedEvidence=Read-DesktopEvidence;if(-not @($report.changedEvidence.snapshot.areas|Where-Object{$_.scale -eq 150}).Count){throw 'desktop-snapshot-scale-not-verified'}
 $report.status='actual-150-percent-verified'
 $report.status='actual-150-spacing-readonly-verified'

}catch{$report.reason=$_.Exception.Message;$report.error=[string]$_}finally{
 $skipRestore=($nativeStarted -and -not $nativeVerified);if($skipRestore){$report.restoreSkippedDueToUnresolvedLease=$true;$report.status='native-unresolved-no-settings-mutation'}
 if(-not $skipRestore -and $report.changed -and $combo -and $original){try{Expand $combo;$matches=@(Options $settings.Id|Where-Object{$_.Current.Name -ceq $original});if($matches.Count -ne 1){throw 'restore-option-not-unique'};$matches[0].GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern).Select();Start-Sleep -Seconds 2;$report.after=@([DpiUiProbe]::Read());$report.restored=(($report.after|ConvertTo-Json -Compress) -ceq ($report.before|ConvertTo-Json -Compress));if(-not $report.restored){$report.status='restore-unverified'}}catch{$report.restoreError=$_.Exception.Message;$report.status='restore-unverified'}}
 if(-not $skipRestore -and $resolutionChanged){try{$rc=ResolutionCombo;$rs=$rc.GetCurrentPattern([Windows.Automation.SelectionPattern]::Pattern).Current.GetSelection();if($rs.Count -ne 1){throw 'resolution-restore-state-unknown'};if($rs[0].Current.Name -cne $resolutionOriginal){Expand $rc;$rr=@(Options $settings.Id|Where-Object{$_.Current.Name -ceq $resolutionOriginal});if($rr.Count -ne 1){throw 'resolution-restore-option-not-unique'};$rr[0].GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern).Select();ConfirmResolution};$report.resolutionRestoreSelected=$true}catch{$report.resolutionRestoreError=$_.Exception.Message;$report.status='restore-unverified'}}
 if(-not $skipRestore){try{$report.afterEvidence=Read-DesktopEvidence;$report.geometryRestored=(($report.beforeEvidence.snapshot.areas|ConvertTo-Json -Depth 8 -Compress) -ceq ($report.afterEvidence.snapshot.areas|ConvertTo-Json -Depth 8 -Compress));if($resolutionChanged -and -not $report.geometryRestored){$report.status='restore-unverified'};$beforeIcons=@($report.beforeEvidence.snapshot.icons);$afterIcons=@($report.afterEvidence.snapshot.icons);$report.oldIconDifferences=@($beforeIcons|Where-Object{$old=$_;-not @($afterIcons|Where-Object{$_.identity -ceq $old.identity -and $_.x -eq $old.x -and $_.y -eq $old.y}).Count}|ForEach-Object{@{identity=$_.identity;label=$_.label;x=$_.x;y=$_.y}});$report.oldIconsUnchanged=($report.oldIconDifferences.Count -eq 0);if(-not $report.oldIconsUnchanged){$report.status='layout-restoration-unverified'}}catch{$report.snapshotFinalError=$_.Exception.Message;if($report.changed){$report.status='layout-restoration-unverified'}}}
 $report|ConvertTo-Json -Depth 20|Set-Content -LiteralPath (Join-Path (Split-Path $PSScriptRoot -Parent) 'desktop-dpi-ui-ci.json') -Encoding utf8
 $report|ConvertTo-Json -Depth 20|Write-Host
}
