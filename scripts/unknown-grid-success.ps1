# Optional product success operations; native private ledger is authoritative.
function Unknown-BindingDigest([string]$canonical){
 if($null -eq $canonical){throw 'unknown-null-canonical-key'}
 $sha=[Security.Cryptography.SHA256]::Create()
 try{return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($canonical)))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
}
function Unknown-SuccessInit($r,$scope){
 if($null -eq $scope.success){return}
 if(@($r.records).Count -gt 32){throw 'unknown-success-item-limit'}
 $r.success=@{bindingFormat='sha256-utf8-v1';baseline=($r.snapshot|ConvertTo-Json -Depth 15 -Compress|ConvertFrom-Json);items=@($scope.success.items);anchorPath=$scope.success.anchorPath;requestedAnchor=$scope.success.requestedAnchor;binding=@{token=$r.token;probeId=$r.records[0].path;geometryKey=(Unknown-BindingDigest (Strict-GeometryKey $r.snapshot));iconsKey=(Unknown-BindingDigest (Strict-IconsKey $r.snapshot))};samples=@()}
 if(@($r.success.items).Count -ne @($r.records).Count){throw 'unknown-shape-count'}
 $seen=@{};foreach($item in $r.success.items){$p=Lease-Path $item.path;if($seen.ContainsKey($p) -or @($r.records|Where-Object{(Lease-Path $_.path) -ieq $p}).Count -ne 1 -or @($item.cell).Count -ne 2){throw 'unknown-shape-path'};$seen[$p]=$true;foreach($n in $item.cell){if($null -eq $n -or [double]$n -ne [int]$n){throw 'unknown-shape-cell'}}}
 if(-not $seen.ContainsKey((Lease-Path $r.success.anchorPath)) -or -not(Strict-PointValid $r.success.requestedAnchor)){throw 'unknown-shape-anchor'}
}
function Unknown-RecordSample($r,$req,$observed){
 if($null -eq $r.success){return $null}
 $samples=@($r.success.samples);if($samples.Count -ge 44 -or $null -eq $req.sampleId -or [double]$req.sampleId -ne $samples.Count -or $req.axis -notin @('x','y') -or $req.pass -notin @('candidate','forward','reverse')){throw 'unknown-sample-sequence'}
 $b=$r.success.binding;$sample=@{id=$samples.Count;axis=$req.axis;pass=$req.pass;token=$b.token;probeId=$b.probeId;geometryKey=$b.geometryKey;iconsKey=$b.iconsKey;requestX=[int]$req.point.x;requestY=[int]$req.point.y;x=[int]$observed.x;y=[int]$observed.y}
 $r.success.samples=@($samples)+@($sample);return $sample
}
function Unknown-AssertProofBinding($r){
 $b=$r.success.binding;$original=$r.success.baseline
 if($r.success.bindingFormat -cne 'sha256-utf8-v1' -or $b.geometryKey -cnotmatch '^[a-f0-9]{64}$' -or $b.iconsKey -cnotmatch '^[a-f0-9]{64}$' -or $null -eq $original -or $b.token -cne $r.token -or $b.probeId -cne $r.records[0].path -or $b.geometryKey -cne (Unknown-BindingDigest (Strict-GeometryKey $original)) -or $b.iconsKey -cne (Unknown-BindingDigest (Strict-IconsKey $original)) -or (Unknown-BindingDigest (Strict-GeometryKey $r.snapshot)) -cne $b.geometryKey -or (Unknown-BindingDigest (Strict-IconsKey $r.snapshot)) -cne $b.iconsKey){throw 'unknown-proof-binding-changed'}
}
function Unknown-AssertVisiblePhase($r){if($r.phase -notin @('resolved-restored','resolve-only')){throw 'unknown-visible-phase-forbidden'}}
function Unknown-VisibleAttributesMatch([uint32]$original,[uint32]$current){
 return (($current -band 2) -eq 0 -and ($current -band ([uint32]::MaxValue -bxor 128)) -eq ($original -band ([uint32]::MaxValue -bxor 130)))
}
function Unknown-ValidateSuccess($r){
 if($null -eq $r.success){throw 'unknown-success-scope-missing'}
 Unknown-AssertProofBinding $r
 $s=Unknown-Current $r;$area=$r.snapshot.areas[$r.targetAreaIndex];$old=@()
 foreach($i in $r.snapshot.icons){$areas=@($r.snapshot.areas|Where-Object{$i.x -ge $_.left -and $i.x -lt $_.right -and $i.y -ge $_.top -and $i.y -lt $_.bottom});if($areas.Count -ne 1 -or $null -eq $areas[0].grid){throw 'unknown-old-grid'};$old+=@{x=$i.x;y=$i.y;w=$areas[0].grid.sx;h=$areas[0].grid.sy}}
 $patch=$r.plan.patch;$input=@{proof=@{binding=$r.success.binding;samples=@($r.success.samples);maxSpacing=$r.plan.maxSpacing;center=@{x=[int][Math]::Floor(($patch.left+$patch.right)/2);y=[int][Math]::Floor(($patch.top+$patch.bottom)/2)};patch=$patch};items=@($r.success.items);anchorPath=$r.success.anchorPath;requestedAnchor=$r.success.requestedAnchor;area=$area;old=$old}|ConvertTo-Json -Depth 15 -Compress
 $input=[regex]::Replace($input,'[^\x00-\x7F]',{param($m) '\u'+([int][char]$m.Value).ToString('x4')})
 if([Text.Encoding]::UTF8.GetByteCount($input) -gt 1048576){throw 'unknown-validator-input-limit'}
 $trusted=Unknown-ValidatorConfig
 $node=$trusted.exe;$scriptFile=$trusted.script
 $p=New-Object Diagnostics.Process;$p.StartInfo.FileName=$node;$p.StartInfo.Arguments='"'+$scriptFile+'"';$p.StartInfo.UseShellExecute=$false;$p.StartInfo.CreateNoWindow=$true;$p.StartInfo.RedirectStandardInput=$true;$p.StartInfo.RedirectStandardOutput=$true;$p.StartInfo.RedirectStandardError=$true;$p.StartInfo.StandardOutputEncoding=[Text.Encoding]::UTF8;$p.StartInfo.StandardErrorEncoding=[Text.Encoding]::UTF8
 $p.StartInfo.EnvironmentVariables['ELECTRON_RUN_AS_NODE']='1'
 try{
  $deadline=[Diagnostics.Stopwatch]::StartNew();if(-not $p.Start()){throw 'unknown-validator-start'};$output=$p.StandardOutput.ReadToEndAsync();$errorText=$p.StandardError.ReadToEndAsync();$writing=$p.StandardInput.WriteAsync($input);if(-not $writing.Wait([Math]::Max(1,5000-[int]$deadline.ElapsedMilliseconds))){try{$p.Kill()}catch{};if(-not $p.WaitForExit(5000)){throw 'unknown-validator-stop-unconfirmed'};throw 'unknown-validator-stdin-timeout'};$p.StandardInput.Close()
  if(-not $p.WaitForExit([Math]::Max(1,5000-[int]$deadline.ElapsedMilliseconds))){try{$p.Kill()}catch{};if(-not $p.WaitForExit(5000)){throw 'unknown-validator-stop-unconfirmed'};throw 'unknown-validator-timeout'}
  $text=$output.GetAwaiter().GetResult();$err=$errorText.GetAwaiter().GetResult();if([Text.Encoding]::UTF8.GetByteCount($text) -gt 65536 -or $err.Length -gt 4096){throw 'unknown-validator-output-limit'}
  $v=$text|ConvertFrom-Json;if($null -eq $v -or $v -is [array] -or $v.ok -isnot [bool]){throw 'unknown-validator-json-shape'};if($p.ExitCode -ne 0 -or $v.ok -ne $true){throw ('unknown-proof-or-targets:'+ [string]$v.reason)}
 }finally{$p.Dispose()}
 # Revalidate returned coordinates and original records natively, not just JSON success.
 foreach($key in @('sx','sy','gx','gy')){$n=$v.grid.$key;if($null -eq $n -or [double]$n -ne [int]$n){throw 'unknown-grid-invalid'}}
 $check=$r|ConvertTo-Json -Depth 20 -Compress|ConvertFrom-Json;$check.version=1;$check.snapshot.areas[$r.targetAreaIndex].grid=$v.grid;$check.targets=@($v.targets)
 if(@($check.targets).Count -ne @($r.records).Count){throw 'unknown-target-count'}
 Lease-ValidateRecovery $check $s
 $anchorItem=@($r.success.items|Where-Object{(Lease-Path $_.path) -ieq (Lease-Path $r.success.anchorPath)})[0]
 foreach($item in $r.success.items){$target=@($v.targets|Where-Object{(Lease-Path $_.path) -ieq (Lease-Path $item.path)});$dx=[long]$item.cell[0]-[long]$anchorItem.cell[0];$dy=[long]$item.cell[1]-[long]$anchorItem.cell[1];if($target.Count -ne 1 -or $target[0].x -ne $v.anchor.x+$dx*$v.grid.sx -or $target[0].y -ne $v.anchor.y+$dy*$v.grid.sy){throw 'unknown-native-shape-mismatch'}}
 return $v
}
function Unknown-VerifyVisible($r){
 Unknown-AssertVisiblePhase $r
 if($r.flagState -cne 'on' -or $null -eq $r.success.resolved){throw 'unknown-visible-state'}
 $proof=Unknown-ValidateSuccess $r;if(($proof.grid|ConvertTo-Json -Compress) -cne ($r.success.resolved.grid|ConvertTo-Json -Compress) -or ($proof.targets|ConvertTo-Json -Depth 5 -Compress) -cne ($r.targets|ConvertTo-Json -Depth 5 -Compress)){throw 'unknown-resolved-proof-changed'}
 $s=Unknown-Current $r;$selected=Lease-Guard $r $s $true;if($selected.Count -ne @($r.records).Count){throw 'unknown-visible-count'};Lease-AllGrid $r.snapshot $s
 foreach($record in $r.records){$n=Lease-CheckRecord $record;if($n.hidden -or -not (Unknown-VisibleAttributesMatch $record.attributes $n.attributes)){throw 'unknown-visible-attributes'}}
 return @{ok=$true;oldUnchanged=$true;targetsExact=$true;snapRestored=$true;recovery=$r}
}
function Invoke-UnknownSuccess($req,$r){
 switch -CaseSensitive ($req.cmd){
 'leaseUnknownResolveTargets'{Unknown-Live $r;if($r.phase -cne 'calibrating'){throw 'unknown-resolve-phase'};$v=Unknown-ValidateSuccess $r;$r.success.resolved=$v;$r.snapshot.areas[$r.targetAreaIndex].grid=$v.grid;$r.targets=@($v.targets);$r.phase='targets-resolved';return @{ok=$true;recovery=$r;resolved=$v}}
 'leaseUnknownRevealResolvedAndPlace'{
  Unknown-Live $r;if($r.phase -cne 'targets-resolved'){throw 'unknown-place-phase'};$s=Unknown-Current $r;$null=Unknown-ValidateSuccess $r;Lease-SetSnap $r $s $false;$r.flagState='off'
  foreach($record in $r.records){$null=Unknown-Current $r;$n=Lease-CheckRecord $record;if($n.hidden){Lease-SetHidden $record $false $true}}
  $s=Lease-WaitVisibility $r $true;Unknown-AssertFlags $r $s;$selected=Lease-Guard $r $s;$ids=@();$paths=@();$xs=@();$ys=@();$tx=@();$ty=@()
  foreach($t in $r.targets){$i=$selected[(Lease-Path $t.path)];$ids+=$i.identity;$paths+=$t.path;$xs+=$i.x;$ys+=$i.y;$tx+=$t.x;$ty+=$t.y}
  [OkibaFolderView]::PositionLeaseItems([string[]]$ids,[string[]]$paths,[int[]]$xs,[int[]]$ys,[int[]]$tx,[int[]]$ty,[uint32]$s.folderFlags,[long]$r.snapshot.listviewHwnd,[int]$r.snapshot.explorerPid,[string]$r.snapshot.explorerStarted)
  Start-Sleep -Milliseconds 180;$s=Unknown-Current $r;$null=Lease-Guard $r $s $true;$r.phase='resolved-placed';return @{ok=$true;recovery=$r;targetsExact=$true;oldUnchanged=$true}
 }
 'leaseUnknownRestoreResolvedAndVerify'{
  if($r.phase -cne 'resolved-placed'){throw 'unknown-restore-phase'};$s=Unknown-Current $r;$null=Lease-Guard $r $s $true;Lease-AllGrid $r.snapshot $s
  foreach($record in $r.records){if((Lease-CheckRecord $record).hidden){throw 'unknown-target-hidden'}}
  Lease-SetSnap $r $s $true;$r.flagState='on';Start-Sleep -Milliseconds 250;$r.phase='resolved-restored';return Unknown-VerifyVisible $r
 }
 'leaseUnknownVerifyResolvedVisible'{return Unknown-VerifyVisible $r}
 'leaseUnknownReleaseVisible'{$null=Unknown-VerifyVisible $r;$script:SnapLease=$null;return @{ok=$true;released=$true}}
 default{throw 'unknown-success-command'}
 }
}
