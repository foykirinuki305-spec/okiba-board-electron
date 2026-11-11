$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_OS -cne 'Windows' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted'){throw 'hosted only'}
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OkibaTerminalWindowCI {
 [StructLayout(LayoutKind.Sequential)] public struct Point { public int x,y; }
 [StructLayout(LayoutKind.Sequential)] public struct Rect { public int left,top,right,bottom; }
 [StructLayout(LayoutKind.Sequential)] public struct Placement { public int length,flags,showCmd; public Point min,max; public Rect normal; }
 [DllImport("user32.dll")] static extern bool GetWindowPlacement(IntPtr h,ref Placement p);
 [DllImport("user32.dll")] static extern bool SetWindowPlacement(IntPtr h,ref Placement p);
 [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h,int command);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 public static Placement Read(IntPtr h){var p=new Placement();p.length=Marshal.SizeOf(typeof(Placement));if(!GetWindowPlacement(h,ref p))throw new Exception("placement read failed");return p;}
 public static void Restore(IntPtr h,Placement p){if(!SetWindowPlacement(h,ref p))throw new Exception("placement restore failed");}
}
'@
function Assert-TerminalOwner($s){
 $s.owner.Refresh()
 [uint32]$nativePID=0;[void][OkibaTerminalWindowCI]::GetWindowThreadProcessId([IntPtr]$s.hwnd,[ref]$nativePID)
 if($s.owner.HasExited -or $s.owner.StartTime.ToUniversalTime().Ticks.ToString() -cne $s.birth -or $nativePID -ne $s.pid -or $s.element.Current.NativeWindowHandle -ne $s.hwnd -or $s.element.Current.ClassName -cne 'CASCADIA_HOSTING_WINDOW_CLASS'){throw 'terminal identity changed'}
}
function Wait-TerminalPlacement($s,$restore){
 $timer=[Diagnostics.Stopwatch]::StartNew();$samples=@()
 do{
  Assert-TerminalOwner $s
  $actual=[OkibaTerminalWindowCI]::Read([IntPtr]$s.hwnd);$samples+=@{ms=$timer.ElapsedMilliseconds;placement=$actual}
  $s.evidence.actual=$actual;$s.evidence.samples=$samples
  if(-not $restore -and $actual.showCmd -eq 2){return}
  if($restore -and $actual.showCmd -eq $s.original.showCmd -and ($actual.normal|ConvertTo-Json -Compress) -ceq ($s.original.normal|ConvertTo-Json -Compress)){return}
  Start-Sleep -Milliseconds 50
 }while($timer.ElapsedMilliseconds -lt 2000)
 throw 'terminal placement unverified'
}
function Resume-RunnerTerminal($s){
 if(-not $s){return}
 Assert-TerminalOwner $s
 [OkibaTerminalWindowCI]::Restore([IntPtr]$s.hwnd,$s.original)
 Wait-TerminalPlacement $s $true
 $s.evidence.restored=$true
}
function Suspend-RunnerTerminal {
 $script:RunnerTerminalEvidence=@{restored=$false}
 $condition=New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ClassNameProperty,'CASCADIA_HOSTING_WINDOW_CLASS')
 $windows=@([Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children,$condition))
 if($windows.Count -ne 1){throw 'expected exactly one runner Terminal'}
 $element=$windows[0];$owner=[Diagnostics.Process]::GetProcessById($element.Current.ProcessId);$null=$owner.Handle
 $packages=@(Get-AppxPackage -Name Microsoft.WindowsTerminal)
 $expected=@($packages|ForEach-Object {Join-Path $_.InstallLocation 'WindowsTerminal.exe'})
 if($expected.Count -ne 1 -or $owner.MainModule.FileName -ine $expected[0]){$owner.Dispose();throw 'runner Terminal package executable mismatch'}
 $s=@{owner=$owner;element=$element;pid=$owner.Id;birth=$owner.StartTime.ToUniversalTime().Ticks.ToString();hwnd=$element.Current.NativeWindowHandle}
 $s.original=[OkibaTerminalWindowCI]::Read([IntPtr]$s.hwnd)
 $s.evidence=@{pid=$s.pid;birth=$s.birth;hwnd=$s.hwnd;exe=$expected[0];class='CASCADIA_HOSTING_WINDOW_CLASS';original=$s.original;restored=$false}
 $script:RunnerTerminalEvidence=$s.evidence
 try{
  Assert-TerminalOwner $s
  [void][OkibaTerminalWindowCI]::ShowWindowAsync([IntPtr]$s.hwnd,6)
  Wait-TerminalPlacement $s $false
 }catch{
  $failure=$_;$s.evidence.error=[string]$failure
  try{Resume-RunnerTerminal $s}catch{$s.evidence.restoreError=[string]$_}
  $owner.Dispose();throw $failure
 }
 return $s
}
