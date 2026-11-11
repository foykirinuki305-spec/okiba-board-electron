# v2.2.3 performance investigation

## Scope
- Preserve drop target pre-resolution, file moves, board v6 data, and cold fallback scripts.
- Add `intake ms` stage timings and `dragout ms appear/work` diagnostics.
- Reuse Explorer process memory within one request; retain 88-byte LVITEM and separate text buffer, minimal access rights, ScreenToClient and AUTOARRANGE 0x0100.
- Notify Explorer of actual newly present Desktop items (1-3 items); use one directory notification for larger batches.
- First placement is batched with 40ms verification. Mismatches use the proven individual 180ms retry path, up to three retries.

## Measurements on the user's Windows PC
Synthetic text files only; existing source files and board data not changed.

| New icons | Original warm helper | Revised warm helper |
|---|---:|---:|
| 1 | 1548 ms | 488 ms |
| 3 | 2607 ms | 907 ms |
| 10 | 5273 ms | 3504 ms |

All final measured placements succeeded. These are individual observed runs, not guaranteed latency. Explorer workload, grid occupancy and cold helper startup affect latency. Ten items may enter conservative per-item retries; do not claim every batch finishes in hundreds of milliseconds.

Add-Type already executes once at helper startup, not per request. Before notifications, appearance waiting dominated (1254-1836ms) while optimized set/readback took 44-59ms. A batch-only 40ms prototype failed a ten-item case; individual fallback restored 10/10 success.

Intake addLink-only measurements, four repetitions: one item 37-44ms, three 118-129ms. Attribute operations account for 36-43ms and 107-115ms respectively. This did not reproduce a multi-second intake delay; added end-to-end stage logging is necessary. Do not parallelize load/save calls against the same board: that can lose link records.

## Regression coverage
- Pure self-tests, optional timing parser compatibility.
- GUI dragout timing format and release-coordinate-specific pre-resolution wait.
- Warm helper real Desktop placement, independent cold readback, Unicode/spaces, repeat placement, and ten-item batch.
- Existing cold Desktop, PowerShell/C# compilation, GUI, portable and installer lifecycle CI checks remain required.

## Verification status (not release-ready yet)
- Independent cold readback passed single-icon and repeated three-icon cases on the multi-monitor user PC.
- The ten-icon independent test exposed a late grid displacement. Final all-item readback now prevents false `ok`, but a crowded real-desktop case still reports 9/10 `partial`. Release is blocked pending isolated CI validation and resolution/classification of this case.
- Tests on the user's actual Desktop are suspended. Earlier tests did not capture every existing icon's original position; no claim of whole-desktop position restoration can be made. Future live tests require before/after snapshots and must not overwrite the user's own changes. Prefer the isolated CI Desktop.
- The user PC was also encoding video in AviUtl, so speed measurements may include concurrent workload.
- Original helper was subsequently checked with the same independent ten-item readback and also failed (reported ok internally despite one position outside tolerance). This case is not new to v2.2.3; the revised helper reports the remaining mismatch rather than claiming success.
- All known test dummy files were cleaned up after stopping tests. The one existing shortcut with an initial recorded position (CrimeScript) was unchanged.
