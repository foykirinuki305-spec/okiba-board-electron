# CI integration test: run scripts/position-desktop-icons.ps1
# against the REAL Explorer desktop of the windows-latest runner.
#
#   1. Create a uniquely named dummy file in the runner's Desktop
#      folder and wait until its icon is readable via the script's
#      own -GetPosition mode (this exercises the cross-process
#      LVITEM text read that was broken in v1.3.0).
#   2. Invoke the script to place the icon at client (420, 260).
#   3. Read the position back and ASSERT it is within one icon
#      spacing of the target (align-to-grid may snap it).
#
# Exit codes: 0 = PASS or documented SKIP, 1 = FAIL.
# A SKIP is only for "this session has no accessible desktop
# listview" (or auto-arrange ON): it prints a LOUD banner and full
# diagnostics either way. Diagnostics are written to
# desktop-position-diagnostics.txt in the workspace root and
# uploaded as a build artifact.

$ErrorActionPreference = 'Continue'

$workspace = $env:GITHUB_WORKSPACE
if (-not $workspace) { $workspace = (Get-Location).Path }
$diagPath = Join-Path $workspace 'desktop-position-diagnostics.txt'
$diag = New-Object System.Collections.Generic.List[string]
function Diag($m) {
  $line = "$(Get-Date -Format o) $m"
  $diag.Add($line)
  Write-Host $m
}
function Flush-Diag {
  try { $diag | Set-Content -Path $diagPath -Encoding UTF8 } catch {}
}
function Loud-Skip($reason) {
  Write-Host ''
  Write-Host '############################################################'
  Write-Host "## SKIP: desktop-position integration test did NOT run."
  Write-Host "## Reason: $reason"
  Write-Host '## This is the documented no-desktop skip: the hosted runner'
  Write-Host '## session exposes no populated Explorer desktop listview,'
  Write-Host '## so real-desktop positioning cannot be asserted here.'
  Write-Host '############################################################'
  Diag "RESULT: SKIP - $reason"
  Flush-Diag
  exit 0
}
function Fail($reason) {
  Write-Host ''
  Write-Host '############################################################'
  Write-Host "## FAIL: $reason"
  Write-Host '############################################################'
  Diag "RESULT: FAIL - $reason"
  Flush-Diag
  exit 1
}

$scriptPath = Join-Path $PSScriptRoot '..\scripts\position-desktop-icons.ps1'
if (-not (Test-Path $scriptPath)) { Fail "position script not found: $scriptPath" }
Diag "position script: $scriptPath"

function Invoke-PosScript([string[]]$a) {
  $lines = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $scriptPath @a
  $jsonLine = $lines | Where-Object { $_ -match '^\s*\{' } | Select-Object -Last 1
  if (-not $jsonLine) { Diag "script args [$($a -join ' ')] -> no JSON output"; return $null }
  try {
    $obj = $jsonLine | ConvertFrom-Json
    Diag "script args [$($a -join ' ')] -> $jsonLine"
    return $obj
  } catch {
    Diag "script args [$($a -join ' ')] -> unparseable: $jsonLine"
    return $null
  }
}

$script:styleCleared = $false
$script:lvHwnd = [IntPtr]::Zero
$script:origStyle = 0

$desktop = [Environment]::GetFolderPath('Desktop')
Diag "shell desktop folder: $desktop"
$name = 'OkibaPosTest-' + [guid]::NewGuid().ToString('N').Substring(0, 10) + '.txt'
$dummy = Join-Path $desktop $name
Diag "dummy file: $dummy"
. (Join-Path $PSScriptRoot 'desktop-fixture-guard.ps1')
$fixtureBaseline=Start-FixtureGuard

try {
  Set-Content -Path $dummy -Value 'okibaboard desktop position integration test' -Encoding ASCII

  # ---- 1. wait for the icon to become readable ----
  $found = $null
  $lastStatus = ''
  $lastCount = -1
  for ($i = 0; $i -lt 30; $i++) {
    $r = Invoke-PosScript @('-GetPosition', '0', '0', $name)
    if ($r) {
      $lastStatus = [string]$r.status
      if ($null -ne $r.count) { $lastCount = [int]$r.count }
      if ($r.status -eq 'ok') { $found = $r; break }
    }
    Start-Sleep -Seconds 1
  }
  if (-not $found) {
    if ($lastStatus -eq 'no-listview') {
      Loud-Skip 'position script reports no-listview in this session'
    }
    if ($lastStatus -eq 'no-item' -and $lastCount -le 0) {
      Loud-Skip 'desktop listview exists but stayed empty (0 items) for 30s; icons not accessible in this session'
    }
    Fail "dummy icon never readable after 30s (last status=$lastStatus, listview count=$lastCount) — item-text matching looks broken"
  }
  Diag "icon readable: initial position x=$($found.x) y=$($found.y), spacing sx=$($found.sx) sy=$($found.sy), count=$($found.count)"
  $sx = [int]$found.sx; $sy = [int]$found.sy
  if ($sx -le 0) { $sx = 100 }
  if ($sy -le 0) { $sy = 100 }

  # ---- 2. place the icon at client (420, 260) ----
  $targetX = 420; $targetY = 260
  $placed = Invoke-PosScript @('-ClientCoords', "$targetX", "$targetY", $name)
  if (-not $placed) { Fail 'position invocation produced no result' }
  if ($placed.status -eq 'autoarrange') {
    # Safety net: if a future runner image ships with desktop
    # auto-arrange ON, mirror the target environment (the user's
    # PC: auto-arrange OFF) by clearing LVS_AUTOARRANGE (0x0100 —
    # NOT 0x1000, which is LVS_OWNERDATA and was the v1.3.0 bug)
    # on the desktop listview for this test session only (restored
    # in the finally block) and retry. On the current runner image
    # the stock desktop style 0x56003A40 already has 0x0100 clear,
    # so this branch is not expected to run. The production script
    # is untouched either way.
    Diag 'auto-arrange reported ON in this runner session; clearing the LVS_AUTOARRANGE (0x0100) style bit on the desktop listview (test session only) to mirror the target environment and retrying'
    try {
      Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class OkibaTestWin {
  public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string win);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string win);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder buf, int max);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hwnd, int index);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr hwnd, int index, int value);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hwnd, int msg, IntPtr wp, IntPtr lp);
  static IntPtr FromDefView(IntPtr parent) {
    if (parent == IntPtr.Zero) return IntPtr.Zero;
    IntPtr dv = FindWindowEx(parent, IntPtr.Zero, "SHELLDLL_DefView", null);
    if (dv == IntPtr.Zero) return IntPtr.Zero;
    return FindWindowEx(dv, IntPtr.Zero, "SysListView32", null);
  }
  public static IntPtr FindPopulatedListView() {
    IntPtr best = IntPtr.Zero; int bestCount = -1;
    IntPtr lv = FromDefView(FindWindow("Progman", null));
    if (lv != IntPtr.Zero) { best = lv; bestCount = (int)SendMessage(lv, 0x1004, IntPtr.Zero, IntPtr.Zero); }
    EnumWindows((hwnd, lp) => {
      var sb = new StringBuilder(64);
      GetClassName(hwnd, sb, 64);
      if (sb.ToString() == "WorkerW") {
        IntPtr v = FromDefView(hwnd);
        if (v != IntPtr.Zero) {
          int c = (int)SendMessage(v, 0x1004, IntPtr.Zero, IntPtr.Zero);
          if (c > bestCount) { bestCount = c; best = v; }
        }
      }
      return true;
    }, IntPtr.Zero);
    return best;
  }
}
'@
      $script:lvHwnd = [OkibaTestWin]::FindPopulatedListView()
      if ($script:lvHwnd -ne [IntPtr]::Zero) {
        $script:origStyle = [OkibaTestWin]::GetWindowLong($script:lvHwnd, -16)
        Diag ("listview style before: 0x{0:X8} (AUTOARRANGE 0x0100 bit: {1}; OWNERDATA 0x1000 bit: {2})" -f $script:origStyle, (($script:origStyle -band 0x0100) -ne 0), (($script:origStyle -band 0x1000) -ne 0))
        [void][OkibaTestWin]::SetWindowLong($script:lvHwnd, -16, ($script:origStyle -band (-bnot 0x0100)))
        $script:styleCleared = $true
        Start-Sleep -Milliseconds 600
        $placed = Invoke-PosScript @('-ClientCoords', "$targetX", "$targetY", $name)
        if (-not $placed) { Fail 'position retry produced no result' }
      } else {
        Diag 'could not locate the desktop listview from the test script'
      }
    } catch {
      Diag "style-bit clearing failed: $($_.Exception.Message)"
    }
  }
  if ($placed.status -eq 'autoarrange') {
    Loud-Skip 'desktop auto-arrange is ON in this runner session and could not be cleared, positions cannot stick'
  }
  if ($placed.status -ne 'ok') {
    Fail "position invocation returned status=$($placed.status) detail=$($placed.detail)"
  }
  Diag "positioned: $($placed.positioned) icon(s)"

  # ---- 3. read back and assert within one icon spacing ----
  $back = $null
  for ($i = 0; $i -lt 10; $i++) {
    $back = Invoke-PosScript @('-GetPosition', '0', '0', $name)
    if ($back -and $back.status -eq 'ok') { break }
    Start-Sleep -Milliseconds 500
  }
  if (-not $back -or $back.status -ne 'ok') { Fail 'read-back after positioning failed' }
  $dx = [Math]::Abs([int]$back.x - $targetX)
  $dy = [Math]::Abs([int]$back.y - $targetY)
  Diag "read-back position: x=$($back.x) y=$($back.y) (target $targetX,$targetY; dx=$dx dy=$dy; tolerance sx=$sx sy=$sy)"
  if ($dx -gt $sx -or $dy -gt $sy) {
    Fail "icon landed at ($($back.x),$($back.y)), more than one icon spacing away from the target ($targetX,$targetY)"
  }

  Write-Host ''
  Write-Host "DESKTOP POSITION TEST PASSED: icon placed at ($($back.x),$($back.y)), target ($targetX,$targetY), tolerance ($sx,$sy)"
  Diag "RESULT: PASS - read-back ($($back.x),$($back.y)) within one spacing of ($targetX,$targetY)"
  Flush-Diag
  exit 0
} finally {
  if ($script:styleCleared -and $script:lvHwnd -and $script:lvHwnd -ne [IntPtr]::Zero) {
    try {
      [void][OkibaTestWin]::SetWindowLong($script:lvHwnd, -16, $script:origStyle)
      Diag 'restored the original desktop listview style'
    } catch {}
  }
  try {
    if([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($dummy)) -ine [IO.Path]::GetFullPath($desktop)){throw 'fixture cleanup path outside desktop'}
    if(Test-Path -LiteralPath $dummy){Remove-Item -LiteralPath $dummy -Force -ErrorAction Stop}
    Complete-FixtureGuard $fixtureBaseline ([string[]]@($dummy))
  } finally { Flush-Diag }
}
