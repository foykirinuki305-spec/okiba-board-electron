# Desktop lease safety review

Scope: the opt-in same-path hidden-file lease, its legacy-return reservation, and normal startup/update data preservation. The default application route has **not** enabled the lease. Resident-rename research is outside this review.

## Verification matrix

| Boundary | Required evidence | Existing regression / state |
|---|---|---|
| Before revealing | Native Desktop/session, owner PID + birth, selected file identity/content metadata, unique old icon identities, exact old-grid alignment, complete target layout | Controller and native mock regressions; hosted native protocol fixtures. Unknown geometry fails closed. |
| Shared operation ownership | Canonical Desktop + session pipe and durable pointer before any return mutation | Global-lock, legacy reservation and main VM regressions; hosted concurrent-process fixtures. Old route also reserves after its read-only preflight. |
| Helper timeout | Confirm old helper exit before replacement, pin new PID/birth, re-adopt only validated recovery | Hosted helper-hang cases; unconfirmed termination retains reservation and forbids rollback. |
| Owner disconnect / death | IPC disconnect is not proof of death. Native pinned owner state controls recovery | Hosted disconnect-alive / kill-reveal / lost-ACK cases. Idle disconnected helper is stopped before watchdog exit. |
| Metadata gate | Snap restored, old identities/coordinates unchanged, targets exact, before hashes match, durable permit before metadata writes | Controller 105-check suite; main metadata and commit-receipt tests. |
| Permit granted, owner alive | No timeout-based re-hide; never invoke metadata commit twice | Pending VM regression and fake GUI transient/persistent failures. |
| Owner dead after permit | All-before => selected rollback; all-after => verified visible completion; mixed/unreadable => blocked | Native commit research and protocol fixtures; receipt pure classification. Watchdog never rewrites board JSON. |
| Successful native release | Explicit visible/hidden outcome; fresh old/target/flag check, selected file-record/attribute check, final fresh snapshot; clear token only after all checks | Native mock suite 53 checks; hosted release-target-shift / release-file-changed one-shot fault cases added, checkpoint CI result still required. |
| Global release | Terminal journal first, then matching global pointer removal, then pipe close. No terminal success while lock is owned | Global-lock tests and finishVisible VM release-failure tests. Failure retains unresolved state. |
| Pending UI | No second move while authoritative completion is unknown; bounded checks never execute metadata again | Pending 47-check suite, main 76-check suite, hosted fake GUI cases. |
| Updated app startup | Existing board JSON bytes/material hashes and home placement/unknown fields preserved; only appVersion changes | Home unknown-field 34 checks; installer/normal-startup/reinstall/migration/uninstall fixture added, installed CI result still required. |

## Open issues / explicit limits

1. **Setting-conflict guard added (latest native CI pending):** successful native restoration pins the ON boundary. Later OFF is rejected without changing flags. The watchdog durably records restoration-attempted before a request and restoration-verified only after complete evidence. Helper adoption requires observed ON for attempted/verified states; OFF after a lost restore response is ambiguous and stays blocked. Pre-restoration owned-OFF recovery remains allowed. A same-value ABA change (user OFF then ON between observations) cannot be distinguished from no change; this is an observation limit, not permission to overwrite a detected OFF.
2. **Known external metadata CAS limit:** main checks byte contents and file identity before and after writing its own temporary file, then atomically replaces the destination. An unrelated process can still write between the final check and replacement. This is not a fully atomic filesystem compare-and-swap. Do not describe it as one.
3. **Known system shutdown/power-loss limit:** durable journal/pointer evidence blocks new work but does not guarantee automatic repair of Desktop settings after the watchdog itself is terminated. No startup code guesses or clears stale evidence.
4. **Known unresolved recovery behavior:** source substitution, geometry/Explorer changes, old-icon changes, missing evidence, disk errors or unknown helper state retain protection. User/third-party icon positions are never restored by guessing. Stale/manual recovery is not implemented as an automatic destructive cleanup.
5. **Known functionality boundary:** same-path hidden-file lease requires proven grids. Unknown/mixed-DPI paths and other return kinds use the reserved old transaction path; its known Explorer arrival-shift risk is not solved merely by mutual exclusion. A failed old-position proof retains the pointer, rather than claiming success.
6. **Observation is not perpetual control:** a verified release proves a checked boundary, not that another OS process cannot modify files/icons immediately afterward. All CI evidence uses synthetic inputs on disposable Windows runners; it is not blanket proof for every mixed-DPI user Desktop.

## Local validation for this review

Read-only inspection and pure/mock tests only. No user Desktop positioning, Shell setting change, or user material modification was performed. Native / GUI / installed lifecycle cases are hosted-CI-only. Test counts above identify observed pure suites, not a claim that the latest combined CI checkpoint has passed.
