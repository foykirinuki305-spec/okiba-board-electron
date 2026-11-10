# CI integration test: positionIcons THROUGH the warm helper
# (scripts/shell-helper.ps1) against the REAL Explorer desktop.
#
# Why this exists (v2.2.1, Job 1): v2.2 moved desktop icon
# positioning into the warm helper, but CI kept exercising only
# the COLD script (tools/desktop-position-test.ps1) — the helper
# path was stub-tested only, and it was the helper path that
# misplaced icons on the user's real PC. This test closes that
# gap: the same standard as the cold test, driven through a live
# helper process via the app's own client (lib/shellhelper.js,
# tools/helper-position-driver.js).
#
#   1. Create a uniquely named dummy file on the runner Desktop
#      and wait until its icon is readable via the COLD script's
#      -GetPosition mode (an independent, known-good read path).
#   2. Ask the HELPER (driver -> shellhelper.js -> live
#      shell-helper.ps1) to position it at screen (420, 260).
#      The desktop listview's client origin is (0,0) on the
#      runner's single primary display, so the client-coords
#      read-back target is the same point; the helper performs
#      the ScreenToClient conversion itself, exactly as in the
#      real drag-out flow where main passes screen coordinates.
#   3. Read the position back via the cold script and ASSERT it
#      is within one icon spacing of the target.
#
# Exit codes: 0 = PASS or documented SKIP, 1 = FAIL (a failing
# helper path FAILS THE BUILD — that is the point of this test).
# Diagnostics go to helper-position-diagnostics.txt.

$ErrorActionPreference = 'Continue'

$workspace = $env:GITHUB_WORKSPACE
if (-not $workspace) { $workspace = (Get-Location).Path }
$diagPath = Join-Path $workspace 'helper-position-diagnostics.txt'
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
  Write-Host "## SKIP: helper-position integration test did NOT run."
  Write-Host "## Reason: $reason"
  Write-Host '## Documented no-desktop skip (same conditions as the'
  Write-Host '## cold-script desktop-position test).'
  Write-Host '############################################################'
  Diag "RESULT: SKIP - $reason"
  Flush-Diag
  exit 0
}
function Fail($reason) {
  Write-Host ''
  Write-Host '############################################################'
  Write-Host "## FAIL (helper path): $reason"
  Write-Host '############################################################'
  Diag "RESULT: FAIL - $reason"
  Flush-Diag
  exit 1
}

$coldScript = Join-Path $PSScriptRoot '..\scripts\position-desktop-icons.ps1'
$driver = Join-Path $PSScriptRoot 'helper-position-driver.js'
if (-not (Test-Path $coldScript)) { Fail "cold script not found: $coldScript" }
if (-not (Test-Path $driver)) { Fail "helper driver not found: $driver" }
Diag "cold read-back script: $coldScript"
Diag "helper driver: $driver"

function Invoke-ColdGetPosition([string]$name) {
  $lines = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $coldScript -GetPosition 0 0 $name
  $jsonLine = $lines | Where-Object { $_ -match '^\s*\{' } | Select-Object -Last 1
  if (-not $jsonLine) { Diag "cold -GetPosition $name -> no JSON output"; return $null }
  try {
    $obj = $jsonLine | ConvertFrom-Json
    Diag "cold -GetPosition $name -> $jsonLine"
    return $obj
  } catch {
    Diag "cold -GetPosition $name -> unparseable: $jsonLine"
    return $null
  }
}

function Invoke-HelperPosition([string]$name, [int]$x, [int]$y) {
  $lines = & node $driver $name $x $y
  $jsonLine = $lines | Where-Object { $_ -match '^\s*\{' } | Select-Object -Last 1
  if (-not $jsonLine) { Diag "helper positionIcons [$name @ $x,$y] -> no JSON output: $($lines -join ' | ')"; return $null }
  try {
    $obj = $jsonLine | ConvertFrom-Json
    Diag "helper positionIcons [$name @ $x,$y] -> $jsonLine"
    return $obj
  } catch {
    Diag "helper positionIcons [$name @ $x,$y] -> unparseable: $jsonLine"
    return $null
  }
}

$script:styleCleared = $false
$script:lvHwnd = [IntPtr]::Zero
$script:origStyle = 0

$desktop = [Environment]::GetFolderPath('Desktop')
Diag "shell desktop folder: $desktop"
$name = 'OkibaHelperTest-' + [guid]::NewGuid().ToString('N').Substring(0, 10) + '.txt'
$dummy = Join-Path $desktop $name
Diag "dummy file: $dummy"

try {
  Set-Content -Path $dummy -Value 'okibaboard helper position integration test' -Encoding ASCII

  # ---- 1. wait for the icon to become readable (cold read path) ----
  $found = $null
  $lastStatus = ''
  $lastCount = -1
  for ($i = 0; $i -lt 30; $i++) {
    $r = Invoke-ColdGetPosition $name
    if ($r) {
      $lastStatus = [string]$r.status
      if ($null -ne $r.count) { $lastCount = [int]$r.count }
      if ($r.status -eq 'ok') { $found = $r; break }
    }
    Start-Sleep -Seconds 1
  }
  if (-not $found) {
    if ($lastStatus -eq 'no-listview') {
      Loud-Skip 'cold read-back reports no-listview in this session'
    }
    if ($lastStatus -eq 'no-item' -and $lastCount -le 0) {
      Loud-Skip 'desktop listview exists but stayed empty (0 items) for 30s; icons not accessible in this session'
    }
    Fail "dummy icon never readable after 30s (last status=$lastStatus, listview count=$lastCount)"
  }
  Diag "icon readable: initial position x=$($found.x) y=$($found.y), spacing sx=$($found.sx) sy=$($found.sy), count=$($found.count)"
  $sx = [int]$found.sx; $sy = [int]$found.sy
  if ($sx -le 0) { $sx = 100 }
  if ($sy -le 0) { $sy = 100 }

  # ---- 2. position it THROUGH THE HELPER at screen (420, 260) ----
  $targetX = 420; $targetY = 260
  $placed = Invoke-HelperPosition $name $targetX $targetY
  if (-not $placed) { Fail 'helper positionIcons produced no result' }
  if ($placed.status -eq 'autoarrange') {
    # Same safety net as the cold test: mirror the target
    # environment (user's PC: auto-arrange OFF) by clearing
    # LVS_AUTOARRANGE (0x0100) on the desktop listview for this
    # test session only (restored in finally) and retry.
    Diag 'helper reports auto-arrange ON in this runner session; clearing the LVS_AUTOARRANGE (0x0100) style bit (test session only) and retrying through the helper'
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
        Diag ("listview style before: 0x{0:X8} (AUTOARRANGE 0x0100 bit: {1})" -f $script:origStyle, (($script:origStyle -band 0x0100) -ne 0))
        [void][OkibaTestWin]::SetWindowLong($script:lvHwnd, -16, ($script:origStyle -band (-bnot 0x0100)))
        $script:styleCleared = $true
        Start-Sleep -Milliseconds 600
        $placed = Invoke-HelperPosition $name $targetX $targetY
        if (-not $placed) { Fail 'helper positionIcons retry produced no result' }
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
    Fail "helper positionIcons returned status=$($placed.status) detail=$($placed.detail)"
  }
  Diag "helper positioned: $($placed.positioned) icon(s)"

  # ---- 3. read back (cold path) and assert within one spacing ----
  $back = $null
  for ($i = 0; $i -lt 10; $i++) {
    $back = Invoke-ColdGetPosition $name
    if ($back -and $back.status -eq 'ok') { break }
    Start-Sleep -Milliseconds 500
  }
  if (-not $back -or $back.status -ne 'ok') { Fail 'read-back after helper positioning failed' }
  $dx = [Math]::Abs([int]$back.x - $targetX)
  $dy = [Math]::Abs([int]$back.y - $targetY)
  Diag "read-back position: x=$($back.x) y=$($back.y) (target $targetX,$targetY; dx=$dx dy=$dy; tolerance sx=$sx sy=$sy)"
  if ($dx -gt $sx -or $dy -gt $sy) {
    Fail "icon landed at ($($back.x),$($back.y)), more than one icon spacing away from the target ($targetX,$targetY) — HELPER PATH DIVERGES from the cold script"
  }

  Write-Host ''
  Write-Host "HELPER POSITION TEST PASSED: icon placed at ($($back.x),$($back.y)) via shell-helper.ps1, target ($targetX,$targetY), tolerance ($sx,$sy)"
  Diag "RESULT: PASS - helper read-back ($($back.x),$($back.y)) within one spacing of ($targetX,$targetY)"
  Flush-Diag
  exit 0
} finally {
  if ($script:styleCleared -and $script:lvHwnd -and $script:lvHwnd -ne [IntPtr]::Zero) {
    try {
      [void][OkibaTestWin]::SetWindowLong($script:lvHwnd, -16, $script:origStyle)
      Diag 'restored the original desktop listview style'
    } catch {}
  }
  try { Remove-Item $dummy -Force -ErrorAction SilentlyContinue } catch {}
  Flush-Diag
}
