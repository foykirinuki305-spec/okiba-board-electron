$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '..\scripts\resident-lease.ps1')
function Lease-Path([string]$p){return [IO.Path]::GetFullPath($p).TrimEnd('\')}
$script:nativeCalls=0
function Resident-All { $script:nativeCalls++;throw 'native locator must not run for visible source scope' }
$desktop=Lease-Path ([Environment]::GetFolderPath('DesktopDirectory'));$public=Lease-Path ([Environment]::GetFolderPath('CommonDesktopDirectory'));$checks=0
foreach($source in @((Join-Path $public 'existing.txt'),'C:\VisibleOtherFolder\existing.txt','C:\VisibleOtherFolder\nested\existing.txt')){
 $dest=Join-Path $desktop 'reserved-future.txt';$old=if($source.StartsWith('C:\VisibleOtherFolder')){'C:\VisibleOtherFolder'}else{$source}
 $record=@{source=$source;destination=$dest;identity='own';volume='v';size='1';mtime='1';originalAttributes=32;sourceParentID='s';destParentID='d'}
 $r=@{version=2;kind='resident-archive-samevolume';snapshot=@{ok=$true;identityVersion=1;folderFlags=4;autoArrange=$false;snap=$true;icons=@(@{identity='old';path=$old;x=0;y=0})};originalFlags=4;residentRecords=@($record);records=@(@{path=$dest;identity='own';size='1';mtime='1';attributes=32});targets=@(@{path=$dest;x=100;y=0})}
 $failed=$false;try{Resident-Validate $r $r.snapshot}catch{if($_.Exception.Message -notmatch '^resident-source-(public-desktop|baseline-visible)$'){throw};$failed=$true}
 if(-not $failed -or $script:nativeCalls -ne 0){throw 'visible source allowed before native mutation guard'};$checks++
}
Write-Output "PASS resident visible-source preflight $checks checks; no native/file/settings calls"
