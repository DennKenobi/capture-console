# Default-endpoint WASAPI session probe — Session 10 misroute-detector verify-early.
# vdo.ninja's &audiooutput can race device enumeration and silently fall back to the
# system default sink (Session 9, Player6). The detector's premise: an audio session
# on the DEFAULT render endpoint whose owning process sits inside an audio-worker
# PID tree means that worker's output is misrouted. This probe answers, one-shot,
# "who has sessions on the default endpoint right now" with PID ancestry so a worker
# tree can be matched. Read-only: enumerates sessions and processes, touches nothing.
#   powershell -NoProfile -ExecutionPolicy Bypass -File capture/test/session-probe.ps1 [-Json]
# Output (one JSON object):
#   {"default":"<label>","sessions":[{"pid":N,"name":"electron.exe","state":1,
#     "peak":0.0031,"sys":false,"chain":[N,parent,grandparent,...]}]}
# state: 0=inactive 1=active 2=expired. chain[0] is the session pid itself; the
# walk stops at a missing parent or a parent younger than its child (PID reuse).
param(
    [switch]$Json
)

Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumeratorP {
  int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollectionP devices);
  int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDeviceP endpoint);
}
[Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceCollectionP {
  int GetCount(out int count);
  int Item(int index, out IMMDeviceP device);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceP {
  int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
  int OpenPropertyStore(int stgmAccess, out IPropertyStoreP properties);
  int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
}
[Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPropertyStoreP {
  int GetCount(out int count);
  int GetAt(int index, out PropertyKeyP key);
  int GetValue(ref PropertyKeyP key, out PropVariantP value);
}
[StructLayout(LayoutKind.Sequential)]
struct PropertyKeyP { public Guid fmtid; public int pid; }
[StructLayout(LayoutKind.Sequential)]
struct PropVariantP { public ushort vt; public ushort r1, r2, r3; public IntPtr p; public int p2; }

// IAudioSessionManager2 (vtable = IAudioSessionManager's 2 methods first)
[Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionManager2P {
  int GetAudioSessionControl(ref Guid sessionGuid, int streamFlags, out IntPtr sessionControl);
  int GetSimpleAudioVolume(ref Guid sessionGuid, int streamFlags, out IntPtr audioVolume);
  int GetSessionEnumerator(out IAudioSessionEnumeratorP sessionEnum);
  int RegisterSessionNotification(IntPtr notification);
  int UnregisterSessionNotification(IntPtr notification);
  int RegisterDuckNotification([MarshalAs(UnmanagedType.LPWStr)] string sessionId, IntPtr notification);
  int UnregisterDuckNotification(IntPtr notification);
}
[Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionEnumeratorP {
  int GetCount(out int count);
  int GetSession(int index, [MarshalAs(UnmanagedType.IUnknown)] out object session);
}
// IAudioSessionControl2 (vtable = IAudioSessionControl's 9 methods first)
[Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionControl2P {
  int GetState(out int state);
  int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
  int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string value, ref Guid eventContext);
  int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
  int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string value, ref Guid eventContext);
  int GetGroupingParam(out Guid param);
  int SetGroupingParam(ref Guid param, ref Guid eventContext);
  int RegisterAudioSessionNotification(IntPtr notification);
  int UnregisterAudioSessionNotification(IntPtr notification);
  int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
  int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
  int GetProcessId(out uint procId);
  [PreserveSig] int IsSystemSoundsSession();
  int SetDuckingPreference(bool optOut);
}
[Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioMeterInformationP {
  int GetPeakValue(out float peak);
  int GetMeteringChannelCount(out int count);
  int GetChannelsPeakValues(int count, [Out, MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 0)] float[] peaks);
}
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumeratorP {}

public class SinkSession {
  public string Endpoint; public uint Pid; public int State; public float Peak; public bool Sys;
}
public static class SessionProbe {
  public static string DefaultLabel() {
    var devEnum = (IMMDeviceEnumeratorP)(new MMDeviceEnumeratorP());
    IMMDeviceP dev;
    devEnum.GetDefaultAudioEndpoint(0, 1, out dev); // eRender, eMultimedia
    var nameKey = new PropertyKeyP { fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 14 };
    IPropertyStoreP store; dev.OpenPropertyStore(0, out store);
    PropVariantP val; store.GetValue(ref nameKey, out val);
    return val.vt == 31 ? Marshal.PtrToStringUni(val.p) : "";
  }
  // Sessions on EVERY active render endpoint: the detector's real question is
  // "does this worker tree own an active session on its CONFIGURED endpoint"
  // (presence on the default endpoint is ambient — vdo.ninja keeps an active
  // silent AudioContext session on default even when correctly routed).
  public static List<SinkSession> Probe() {
    var outList = new List<SinkSession>();
    var devEnum = (IMMDeviceEnumeratorP)(new MMDeviceEnumeratorP());
    var nameKey = new PropertyKeyP { fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 14 };
    IMMDeviceCollectionP coll;
    devEnum.EnumAudioEndpoints(0, 1, out coll); // eRender, DEVICE_STATE_ACTIVE
    int devCount; coll.GetCount(out devCount);
    for (int d = 0; d < devCount; d++) {
      try {
        IMMDeviceP dev; coll.Item(d, out dev);
        IPropertyStoreP store; dev.OpenPropertyStore(0, out store);
        PropVariantP val; store.GetValue(ref nameKey, out val);
        string label = val.vt == 31 ? Marshal.PtrToStringUni(val.p) : "";
        var iid = typeof(IAudioSessionManager2P).GUID;
        object o; dev.Activate(ref iid, 23, IntPtr.Zero, out o);
        var mgr = (IAudioSessionManager2P)o;
        IAudioSessionEnumeratorP sessEnum; mgr.GetSessionEnumerator(out sessEnum);
        int count; sessEnum.GetCount(out count);
        for (int i = 0; i < count; i++) {
          try {
            object so; sessEnum.GetSession(i, out so);
            var ctl = (IAudioSessionControl2P)so;
            var s = new SinkSession();
            s.Endpoint = label;
            ctl.GetState(out s.State);
            ctl.GetProcessId(out s.Pid);
            s.Sys = ctl.IsSystemSoundsSession() == 0; // S_OK = yes, S_FALSE(1) = no
            try { ((IAudioMeterInformationP)so).GetPeakValue(out s.Peak); } catch { s.Peak = -1f; }
            outList.Add(s);
          } catch { /* one bad session must not empty the probe */ }
        }
      } catch { /* one bad endpoint must not empty the probe */ }
    }
    return outList;
  }
}
'@

$defLabel = [SessionProbe]::DefaultLabel()
$sessions = [SessionProbe]::Probe()

# Ancestry snapshot: one CIM query, then bounded parent walks with a PID-reuse
# guard (a parent created after its child is a recycled pid, not an ancestor).
$procs = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CreationDate
$byId = @{}
foreach ($p in $procs) { $byId[[int]$p.ProcessId] = $p }
function Get-AncestorChain([int]$procId) {
    $chain = New-Object System.Collections.Generic.List[int]
    $cur = $procId
    for ($depth = 0; $depth -lt 20; $depth++) {
        if (-not $byId.ContainsKey($cur)) { break }
        $chain.Add($cur)
        $parent = [int]$byId[$cur].ParentProcessId
        if ($parent -eq $cur -or -not $byId.ContainsKey($parent)) { break }
        if ($byId[$parent].CreationDate -and $byId[$cur].CreationDate -and
            $byId[$parent].CreationDate -gt $byId[$cur].CreationDate) { break }
        $cur = $parent
    }
    $chain.ToArray()
}

$rows = @()
foreach ($s in $sessions) {
    $procId = [int]$s.Pid
    $name = if ($byId.ContainsKey($procId)) { $byId[$procId].Name } else { '<gone>' }
    $rows += [pscustomobject]@{
        endpoint = $s.Endpoint
        pid      = $procId
        name     = $name
        state    = $s.State
        peak     = [Math]::Round($s.Peak, 4)
        sys      = [bool]$s.Sys
        chain    = @(Get-AncestorChain $procId)
    }
}
$result = [pscustomobject]@{ default = $defLabel; sessions = $rows }

if ($Json) { $result | ConvertTo-Json -Depth 5 -Compress }
else {
    Write-Output "default render endpoint: $defLabel"
    $stateNames = @('inactive', 'ACTIVE', 'expired')
    foreach ($group in ($rows | Group-Object endpoint)) {
        Write-Output "endpoint: $($group.Name)"
        foreach ($r in $group.Group) {
            $sysTag = if ($r.sys) { ' [system sounds]' } else { '' }
            Write-Output ("  pid={0,-7} {1,-28} {2,-8} peak={3:F4}{4}  chain: {5}" -f `
                    $r.pid, $r.name, $stateNames[$r.state], $r.peak, $sysTag, ($r.chain -join ' <- '))
        }
    }
}
