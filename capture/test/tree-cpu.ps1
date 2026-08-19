# Process-tree CPU sampler — Capture Console bench tooling (Session 6).
# Sums CPU-seconds over a window for every process whose CommandLine matches
# -Marker (electron trees carry their --user-data-dir in child cmdlines, so a
# bench workdir substring captures the whole tree), and reports cores = ΔCPU/s
# plus the whole-box % over the same window. With no -Marker it is a whole-box
# idle-baseline sampler.
#
#   powershell -File capture/test/tree-cpu.ps1 -Marker vhost-gate -Seconds 60
#   powershell -File capture/test/tree-cpu.ps1 -Seconds 60          # baseline
param(
  [string]$Marker = '',
  [int]$Seconds = 60
)

function TreeSnapshot([string]$m) {
  $map = @{}
  Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match [regex]::Escape($m) } | ForEach-Object {
    $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
    if ($p) { $map[$_.ProcessId] = $p.TotalProcessorTime.TotalSeconds }
  }
  $map
}

$boxSamples = New-Object System.Collections.Generic.List[double]
$t0 = if ($Marker) { TreeSnapshot $Marker } else { $null }
$sw = [System.Diagnostics.Stopwatch]::StartNew()
while ($sw.Elapsed.TotalSeconds -lt $Seconds) {
  $c = Get-Counter '\Processor(_Total)\% Processor Time' -SampleInterval 2 -MaxSamples 1
  $boxSamples.Add($c.CounterSamples[0].CookedValue)
}
$sw.Stop()
$elapsed = $sw.Elapsed.TotalSeconds
$box = ($boxSamples | Measure-Object -Average -Minimum -Maximum)

if ($Marker) {
  $t1 = TreeSnapshot $Marker
  $cpu = 0.0; $procs = 0
  foreach ($id in $t1.Keys) {
    if ($t0.ContainsKey($id)) { $cpu += ($t1[$id] - $t0[$id]); $procs++ }
    else { $procs++ }  # spawned mid-window: contributes 0 (conservative)
  }
  $cores = [math]::Round($cpu / $elapsed, 2)
  "marker=$Marker seconds=$([math]::Round($elapsed,1)) procs=$procs treeCores=$cores boxAvgPct=$([math]::Round($box.Average,1)) boxMinPct=$([math]::Round($box.Minimum,1)) boxMaxPct=$([math]::Round($box.Maximum,1))"
} else {
  "baseline seconds=$([math]::Round($elapsed,1)) boxAvgPct=$([math]::Round($box.Average,1)) boxMinPct=$([math]::Round($box.Minimum,1)) boxMaxPct=$([math]::Round($box.Maximum,1)) samples=$($boxSamples.Count)"
}
