function Strict-InferAreaGrid($members,[int]$sx,[int]$sy,[int]$scale,[int]$viewDpi) {
  if($sx -le 0 -or $sy -le 0 -or $scale -le 0 -or $viewDpi -le 0 -or $scale*96 -ne $viewDpi*100){return $null}
  $residues=@($members | ForEach-Object { '{0},{1}' -f (($_.x%$sx+$sx)%$sx),(($_.y%$sy+$sy)%$sy) } | Select-Object -Unique)
  if($residues.Count -ne 1){return $null}
  $xy=$residues[0].Split(',');return @{gx=[int]$xy[0];gy=[int]$xy[1];sx=$sx;sy=$sy}
}
