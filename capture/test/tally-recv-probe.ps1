# Session 8 Part C tally test tool — a receiver that EXPLICITLY raises program tally
# via NDIlib_recv_set_tally (raw SDK P/Invoke; grandiose does not expose the
# receiver-side tally setter). Discovers the source (finder-discovered ONLY — a
# name-only source never actually connects, at the raw SDK level too), connects
# metadata-only, raises program for $Seconds, flips to preview for 8 s, then exits.
# Session 8 verdicts established with it: NDI-native tally propagates sender-ward in
# <0.5 s and clears on receiver disconnect; NDI 6 Studio Monitor does NOT raise tally.
#   powershell -File capture/test/tally-recv-probe.ps1 -Source "IRONMAN5 (CC-Alice)" [-Seconds 30]
param(
    [string]$Source = 'IRONMAN5 (CC-S8-TALLY)',
    [int]$Seconds = 30
)

$dll = Join-Path $PSScriptRoot '..\..\node_modules\@stagetimerio\grandiose\dist\Processing.NDI.Lib.x64.dll'
$dll = (Resolve-Path $dll).Path

Add-Type @"
using System;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential)]
public struct NdiSource {
  public IntPtr p_ndi_name;
  public IntPtr p_url_address;
}
[StructLayout(LayoutKind.Sequential)]
public struct NdiRecvCreateV3 {
  public NdiSource source_to_connect_to;
  public int color_format;      // 0 = BGRX_BGRA
  public int bandwidth;         // -10 = metadata only (tally travels as connection metadata)
  [MarshalAs(UnmanagedType.U1)] public bool allow_video_fields;
  public IntPtr p_ndi_recv_name;
}
[StructLayout(LayoutKind.Sequential)]
public struct NdiTally {
  [MarshalAs(UnmanagedType.U1)] public bool on_program;
  [MarshalAs(UnmanagedType.U1)] public bool on_preview;
}
[StructLayout(LayoutKind.Sequential)]
public struct NdiFindCreate {
  [MarshalAs(UnmanagedType.U1)] public bool show_local_sources;
  public IntPtr p_groups;
  public IntPtr p_extra_ips;
}
public static class Ndi {
  [DllImport(@"$dll")] public static extern bool NDIlib_initialize();
  [DllImport(@"$dll")] public static extern IntPtr NDIlib_recv_create_v3(ref NdiRecvCreateV3 create);
  [DllImport(@"$dll")] public static extern void NDIlib_recv_destroy(IntPtr recv);
  [DllImport(@"$dll")] public static extern bool NDIlib_recv_set_tally(IntPtr recv, ref NdiTally tally);
  [DllImport(@"$dll")] public static extern int NDIlib_recv_get_no_connections(IntPtr recv);
  [DllImport(@"$dll")] public static extern IntPtr NDIlib_find_create_v2(ref NdiFindCreate create);
  [DllImport(@"$dll")] public static extern void NDIlib_find_destroy(IntPtr finder);
  [DllImport(@"$dll")] public static extern IntPtr NDIlib_find_get_current_sources(IntPtr finder, ref uint num);
  [DllImport(@"$dll")] [return: MarshalAs(UnmanagedType.U1)] public static extern bool NDIlib_find_wait_for_sources(IntPtr finder, uint timeoutMs);
}
"@

if (-not [Ndi]::NDIlib_initialize()) { Write-Output 'ERROR: NDIlib_initialize failed'; exit 1 }

# Finder-discovered sources ONLY (the Session 7 rule holds at the raw SDK level too:
# a name-only source never actually connects).
$fc = New-Object NdiFindCreate
$fc.show_local_sources = $true
$fc.p_groups = [IntPtr]::Zero
$fc.p_extra_ips = [IntPtr]::Zero
$finder = [Ndi]::NDIlib_find_create_v2([ref]$fc)
if ($finder -eq [IntPtr]::Zero) { Write-Output 'ERROR: find_create failed'; exit 1 }
$src = $null
$srcSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][NdiSource])
for ($try = 0; $try -lt 10 -and -not $src; $try++) {
    [Ndi]::NDIlib_find_wait_for_sources($finder, 1000) | Out-Null
    $num = [uint32]0
    $arr = [Ndi]::NDIlib_find_get_current_sources($finder, [ref]$num)
    for ($i = 0; $i -lt $num; $i++) {
        $cand = [System.Runtime.InteropServices.Marshal]::PtrToStructure([IntPtr]::Add($arr, $i * $srcSize), [type][NdiSource])
        $name = [System.Runtime.InteropServices.Marshal]::PtrToStringAnsi($cand.p_ndi_name)
        if ($name -eq $Source) { $src = $cand; break }
    }
}
if (-not $src) { Write-Output "ERROR: source '$Source' not discovered"; exit 1 }
$url = if ($src.p_url_address -ne [IntPtr]::Zero) { [System.Runtime.InteropServices.Marshal]::PtrToStringAnsi($src.p_url_address) } else { '(null)' }
Write-Output "$(Get-Date -Format HH:mm:ss.fff) discovered '$Source' at $url"

$recvNamePtr = [System.Runtime.InteropServices.Marshal]::StringToHGlobalAnsi('CC-S8-TALLY-PROBE')
$create = New-Object NdiRecvCreateV3
$create.source_to_connect_to = $src   # the DISCOVERED source struct, url included
$create.color_format = 0
$create.bandwidth = -10   # metadata-only: no video decode, tally still travels
$create.allow_video_fields = $false
$create.p_ndi_recv_name = $recvNamePtr

$recv = [Ndi]::NDIlib_recv_create_v3([ref]$create)
if ($recv -eq [IntPtr]::Zero) { Write-Output 'ERROR: recv_create failed'; exit 1 }
Write-Output "$(Get-Date -Format HH:mm:ss.fff) receiver up, connecting to '$Source' (metadata-only)"

Start-Sleep 3
Write-Output "$(Get-Date -Format HH:mm:ss.fff) connections=$([Ndi]::NDIlib_recv_get_no_connections($recv))"

$tally = New-Object NdiTally
$tally.on_program = $true
$tally.on_preview = $false
$ok = [Ndi]::NDIlib_recv_set_tally($recv, [ref]$tally)
Write-Output "$(Get-Date -Format HH:mm:ss.fff) set_tally(program=true) -> $ok"

Start-Sleep $Seconds

$tally.on_program = $false
$tally.on_preview = $true
$ok = [Ndi]::NDIlib_recv_set_tally($recv, [ref]$tally)
Write-Output "$(Get-Date -Format HH:mm:ss.fff) set_tally(preview=true) -> $ok"
Start-Sleep 8

[Ndi]::NDIlib_recv_destroy($recv)
Write-Output "$(Get-Date -Format HH:mm:ss.fff) receiver destroyed"
