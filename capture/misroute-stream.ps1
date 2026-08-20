# Streaming WASAPI session detector feed — Session 10 Part C (audio misroute).
# vdo.ninja's &audiooutput can race device enumeration and silently fall back to
# the system default sink (Session 9, Player6). Verify-early (session-probe.ps1)
# established the shipping discriminator:
#   - a CONNECTED audio worker owns an ACTIVE session on its configured endpoint,
#     and that session PERSISTS across publisher disconnects (element keeps its sink);
#   - a MISROUTED worker owns an ACTIVE session on the DEFAULT endpoint only;
#   - presence on the default endpoint alone is AMBIENT (every vdo.ninja page holds
#     an active silent AudioContext session there) — never a signal by itself.
# The console (misroute logic in console-main.js) matches session PID ancestry
# chains against audio-worker root pids from supervisor-status.json. This helper
# is read-only: it enumerates sessions and processes, touches nothing, and never
# contacts a worker (the fragile plane stays untouched by design).
#
# Emits one JSON line per interval with every ACTIVE non-system session on every
# active render endpoint:
#   {"default":"<label>","sessions":[{"endpoint":"...","pid":N,"peak":0.01,
#     "chain":[pid,parent,...]}]}
# Exits 2 if endpoint enumeration itself dies (spawner may respawn).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File capture/misroute-stream.ps1 `
#     [-IntervalMs 5000]
param(
    [int]$IntervalMs = 5000
)

Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumeratorX {
  int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollectionX devices);
  int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDeviceX endpoint);
}
[Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceCollectionX {
  int GetCount(out int count);
  int Item(int index, out IMMDeviceX device);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceX {
  int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
  int OpenPropertyStore(int stgmAccess, out IPropertyStoreX properties);
  int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
}
[Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPropertyStoreX {
  int GetCount(out int count);
  int GetAt(int index, out PropertyKeyX key);
  int GetValue(ref PropertyKeyX key, out PropVariantX value);
}
[StructLayout(LayoutKind.Sequential)]
struct PropertyKeyX { public Guid fmtid; public int pid; }
[StructLayout(LayoutKind.Sequential)]
struct PropVariantX { public ushort vt; public ushort r1, r2, r3; public IntPtr p; public int p2; }

// IAudioSessionManager2 (vtable = IAudioSessionManager's 2 methods first)
[Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionManager2X {
  int GetAudioSessionControl(ref Guid sessionGuid, int streamFlags, out IntPtr sessionControl);
  int GetSimpleAudioVolume(ref Guid sessionGuid, int streamFlags, out IntPtr audioVolume);
  int GetSessionEnumerator(out IAudioSessionEnumeratorX sessionEnum);
  int RegisterSessionNotification(IntPtr notification);
  int UnregisterSessionNotification(IntPtr notification);
  int RegisterDuckNotification([MarshalAs(UnmanagedType.LPWStr)] string sessionId, IntPtr notification);
  int UnregisterDuckNotification(IntPtr notification);
}
[Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionEnumeratorX {
  int GetCount(out int count);
  int GetSession(int index, [MarshalAs(UnmanagedType.IUnknown)] out object session);
}
// IAudioSessionControl2 (vtable = IAudioSessionControl's 9 methods first)
[Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionControl2X {
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
interface IAudioMeterInformationX {
  int GetPeakValue(out float peak);
  int GetMeteringChannelCount(out int count);
  int GetChannelsPeakValues(int count, [Out, MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 0)] float[] peaks);
}
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumeratorX {}

public class ActiveSessionX {
  public string Endpoint; public uint Pid; public float Peak;
}
public static class MisrouteScan {
  public static string DefaultLabel() {
    var devEnum = (IMMDeviceEnumeratorX)(new MMDeviceEnumeratorX());
    IMMDeviceX dev;
    devEnum.GetDefaultAudioEndpoint(0, 1, out dev); // eRender, eMultimedia
    var nameKey = new PropertyKeyX { fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 14 };
    IPropertyStoreX store; dev.OpenPropertyStore(0, out store);
    PropVariantX val; store.GetValue(ref nameKey, out val);
    return val.vt == 31 ? Marshal.PtrToStringUni(val.p) : "";
  }
  // ACTIVE non-system sessions on every active render endpoint (state 1 only —
  // inactive/expired sessions carry no routing information for the detector).
  public static List<ActiveSessionX> Scan() {
    var outList = new List<ActiveSessionX>();
    var devEnum = (IMMDeviceEnumeratorX)(new MMDeviceEnumeratorX());
    var nameKey = new PropertyKeyX { fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 14 };
    IMMDeviceCollectionX coll;
    devEnum.EnumAudioEndpoints(0, 1, out coll); // eRender, DEVICE_STATE_ACTIVE
    int devCount; coll.GetCount(out devCount);
    for (int d = 0; d < devCount; d++) {
      try {
        IMMDeviceX dev; coll.Item(d, out dev);
        IPropertyStoreX store; dev.OpenPropertyStore(0, out store);
        PropVariantX val; store.GetValue(ref nameKey, out val);
        string label = val.vt == 31 ? Marshal.PtrToStringUni(val.p) : "";
        var iid = typeof(IAudioSessionManager2X).GUID;
        object o; dev.Activate(ref iid, 23, IntPtr.Zero, out o);
        var mgr = (IAudioSessionManager2X)o;
        IAudioSessionEnumeratorX sessEnum; mgr.GetSessionEnumerator(out sessEnum);
        int count; sessEnum.GetCount(out count);
        for (int i = 0; i < count; i++) {
          try {
            object so; sessEnum.GetSession(i, out so);
            var ctl = (IAudioSessionControl2X)so;
            int state; ctl.GetState(out state);
            if (state != 1) continue;
            if (ctl.IsSystemSoundsSession() == 0) continue;
            var s = new ActiveSessionX();
            s.Endpoint = label;
            ctl.GetProcessId(out s.Pid);
            try { ((IAudioMeterInformationX)so).GetPeakValue(out s.Peak); } catch { s.Peak = -1f; }
            outList.Add(s);
          } catch { /* one bad session must not empty the scan */ }
        }
      } catch { /* one bad endpoint must not empty the scan */ }
    }
    return outList;
  }
}
'@

function Get-JsonEscaped([string]$s) {
    $s.Replace('\', '\\').Replace('"', '\"')
}

while ($true) {
    try {
        $defLabel = [MisrouteScan]::DefaultLabel()
        $sessions = [MisrouteScan]::Scan()
    } catch {
        [Console]::Out.WriteLine('{"error":"session scan failed: ' + (Get-JsonEscaped $_.Exception.Message) + '"}')
        [Console]::Out.Flush()
        exit 2
    }

    # Ancestry snapshot once per tick; bounded parent walks with a PID-reuse guard
    # (a parent created after its child is a recycled pid, not an ancestor).
    $byId = @{}
    foreach ($p in (Get-CimInstance Win32_Process |
            Select-Object ProcessId, ParentProcessId, CreationDate)) {
        $byId[[int]$p.ProcessId] = $p
    }
    $parts = foreach ($s in $sessions) {
        $chain = New-Object System.Collections.Generic.List[int]
        $cur = [int]$s.Pid
        for ($depth = 0; $depth -lt 20; $depth++) {
            if (-not $byId.ContainsKey($cur)) { break }
            $chain.Add($cur)
            $parent = [int]$byId[$cur].ParentProcessId
            if ($parent -eq $cur -or -not $byId.ContainsKey($parent)) { break }
            if ($byId[$parent].CreationDate -and $byId[$cur].CreationDate -and
                $byId[$parent].CreationDate -gt $byId[$cur].CreationDate) { break }
            $cur = $parent
        }
        '{"endpoint":"' + (Get-JsonEscaped $s.Endpoint) + '","pid":' + $s.Pid +
        ',"peak":' + $s.Peak.ToString('F4', [System.Globalization.CultureInfo]::InvariantCulture) +
        ',"chain":[' + ($chain -join ',') + ']}'
    }
    [Console]::Out.WriteLine('{"default":"' + (Get-JsonEscaped $defLabel) + '","sessions":[' + ($parts -join ',') + ']}')
    [Console]::Out.Flush()
    Start-Sleep -Milliseconds $IntervalMs
}
