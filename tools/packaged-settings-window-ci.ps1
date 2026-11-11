param([switch]$Probe)
$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_OS -cne 'Windows' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted'){throw 'hosted only'}
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$script:OwnedSettingsEvidence=@{}
function Wait-OwnedSettingsState($state,$expected){
 $timer=[Diagnostics.Stopwatch]::StartNew();$observations=@()
 do{
  $state.owner.Refresh()
  if($state.owner.HasExited -or $state.owner.StartTime.ToUniversalTime().Ticks.ToString() -cne $state.birth -or $state.element.Current.ProcessId -ne $state.pid -or $state.element.Current.NativeWindowHandle -ne $state.hwnd){throw 'settings-window-identity-changed'}
  $actual=$state.pattern.Current.WindowVisualState
  $observations+=@{elapsedMs=$timer.ElapsedMilliseconds;actual=[int]$actual}
  $script:OwnedSettingsEvidence.actual=[int]$actual
  $script:OwnedSettingsEvidence.observations=$observations
  if($actual -eq $expected){return}
  Start-Sleep -Milliseconds 50
 }while($timer.ElapsedMilliseconds -lt 2000)
 throw ('settings-visual-state-unverified:expected='+[int]$expected+' actual='+[int]$actual)
}
function Suspend-OwnedSettings($settings,$descendant){
 $script:OwnedSettingsEvidence=@{phase='identify';ancestors=@();restored=$false}
 $settings.Refresh();$null=$settings.Handle
 if($settings.MainModule.FileName -ine (Join-Path $env:SystemRoot 'ImmersiveControlPanel\SystemSettings.exe') -or $descendant.Current.ProcessId -ne $settings.Id){throw 'settings-descendant-owner-mismatch'}
 $ancestors=@();$current=$descendant;$pattern=$null;$selected=$null
 for($depth=0;$depth -lt 30 -and $current;$depth++){
  if([Windows.Automation.Automation]::Compare($current,[Windows.Automation.AutomationElement]::RootElement)){break}
  $pidValue=$current.Current.ProcessId;$hwnd=$current.Current.NativeWindowHandle;$candidate=$null
  $supported=$current.TryGetCurrentPattern([Windows.Automation.WindowPattern]::Pattern,[ref]$candidate)
  $ancestors+=@{depth=$depth;pid=$pidValue;hwnd=$hwnd;type=$current.Current.ControlType.ProgrammaticName;windowPattern=$supported}
  $script:OwnedSettingsEvidence.ancestors=$ancestors
  if($supported -and $hwnd -ne 0){
   $owner=[Diagnostics.Process]::GetProcessById($pidValue);$null=$owner.Handle
   $allowed=($owner.Id -eq $settings.Id -and $owner.StartTime -eq $settings.StartTime) -or ($owner.MainModule.FileName -ieq (Join-Path $env:SystemRoot 'System32\ApplicationFrameHost.exe'))
   if(-not $allowed){$owner.Dispose();throw ('settings-window-owner-mismatch:'+($ancestors|ConvertTo-Json -Compress))}
   $pattern=$candidate;$selected=$current;break
  }
  $current=[Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($current)
 }
 if(-not $selected){throw ('owned-settings-supported-window-missing:'+($ancestors|ConvertTo-Json -Compress))}
 $old=$pattern.Current.WindowVisualState
 $state=@{pattern=$pattern;element=$selected;owner=$owner;hwnd=$hwnd;pid=$pidValue;birth=$owner.StartTime.ToUniversalTime().Ticks.ToString();original=$old;ancestors=$ancestors;restored=$false}
 $script:OwnedSettingsEvidence=@{pid=$pidValue;birth=$state.birth;hwnd=$hwnd;original=[int]$old;ancestors=$ancestors;phase='minimize';restored=$false}
 try{
  $pattern.SetWindowVisualState([Windows.Automation.WindowVisualState]::Minimized)
  Wait-OwnedSettingsState $state ([Windows.Automation.WindowVisualState]::Minimized)
  $script:OwnedSettingsEvidence.minimizeObservations=$script:OwnedSettingsEvidence.observations
 }catch{
  $failure=$_
  $script:OwnedSettingsEvidence.error=[string]$failure
  $script:OwnedSettingsEvidence.minimizeObservations=$script:OwnedSettingsEvidence.observations
  try{Resume-OwnedSettings $state}catch{$script:OwnedSettingsEvidence.restoreError=[string]$_}
  $failure.Exception.Data['settingsEvidence']=($script:OwnedSettingsEvidence|ConvertTo-Json -Depth 12 -Compress)
  $state.owner.Dispose()
  throw $failure
 }
 return $state
}
function Resume-OwnedSettings($state){
 if($state.owner.HasExited -or $state.element.Current.ProcessId -ne $state.pid -or $state.element.Current.NativeWindowHandle -ne $state.hwnd){throw 'settings-window-identity-changed'}
 $script:OwnedSettingsEvidence.phase='restore'
 $state.pattern.SetWindowVisualState($state.original)
 Wait-OwnedSettingsState $state $state.original
 $state.restored=$true
 $script:OwnedSettingsEvidence.restored=$true
}
if($Probe){
 $evidence=@{passed=$false};$state=$null
 try{
  Start-Process explorer.exe -ArgumentList 'ms-settings:display' -WindowStyle Hidden
  $until=[DateTime]::UtcNow.AddSeconds(30);$combo=$null
  do{$settings=Get-Process SystemSettings -ErrorAction SilentlyContinue|Select-Object -First 1
   if($settings){$condition=New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ProcessIdProperty,$settings.Id);$all=[Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Descendants,$condition);$combo=@($all|Where-Object {$_.Current.ControlType -eq [Windows.Automation.ControlType]::ComboBox})|Select-Object -First 1}
   if(-not $combo){Start-Sleep -Milliseconds 200}
  }while(-not $combo -and [DateTime]::UtcNow -lt $until)
  if(-not $combo){throw 'settings-probe-descendant-unavailable'}
  $state=Suspend-OwnedSettings $settings $combo;$evidence.ancestors=$state.ancestors;$evidence.owner=@{pid=$state.pid;birth=$state.birth;hwnd=$state.hwnd};Resume-OwnedSettings $state;$evidence.passed=$true
 }catch{$evidence.error=[string]$_;throw}finally{$evidence.settings=$script:OwnedSettingsEvidence;if($state){if(-not $state.restored){try{Resume-OwnedSettings $state}catch{$evidence.restoreError=[string]$_}};$evidence.restored=$state.restored;$state.owner.Dispose()};$evidence|ConvertTo-Json -Depth 8|Set-Content (Join-Path (Split-Path $PSScriptRoot -Parent) 'packaged-settings-probe.json')}
}
