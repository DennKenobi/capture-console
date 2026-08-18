# Per-channel WASAPI endpoint peak meters — Capture Console test tooling.
# VB-Audio virtual endpoints do NOT implement loopback capture (loopback reads silence),
# so channel placement on the VAIO is verified with IAudioMeterInformation instead.
#   powershell -File capture/test/device-meter.ps1 -DeviceMatch "VBMatrix In 6" [-Seconds 3]
param(
    [Parameter(Mandatory = $true)][string]$DeviceMatch,
    [double]$Seconds = 3.0,
    [switch]$Json
)

Add-Type @'
using System;
using System.Runtime.InteropServices;

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumeratorM {
  int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollectionM devices);
  int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDeviceM endpoint);
}
[Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceCollectionM {
  int GetCount(out int count);
  int Item(int index, out IMMDeviceM device);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceM {
  int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
  int OpenPropertyStore(int stgmAccess, out IPropertyStoreM properties);
  int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
}
[Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPropertyStoreM {
  int GetCount(out int count);
  int GetAt(int index, out PropertyKeyM key);
  int GetValue(ref PropertyKeyM key, out PropVariantM value);
}
[StructLayout(LayoutKind.Sequential)]
struct PropertyKeyM { public Guid fmtid; public int pid; }
[StructLayout(LayoutKind.Sequential)]
struct PropVariantM { public ushort vt; public ushort r1, r2, r3; public IntPtr p; public int p2; }
[Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioMeterInformationM {
  int GetPeakValue(out float peak);
  int GetMeteringChannelCount(out int count);
  int GetChannelsPeakValues(int count, [Out, MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 0)] float[] peaks);
}
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumeratorM {}

public static class ChannelMeter {
  public static string Probe(string nameFragment, int samples, int intervalMs) {
    var devEnum = (IMMDeviceEnumeratorM)(new MMDeviceEnumeratorM());
    IMMDeviceCollectionM coll;
    devEnum.EnumAudioEndpoints(0, 1, out coll);
    int count; coll.GetCount(out count);
    var nameKey = new PropertyKeyM { fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 14 };
    for (int i = 0; i < count; i++) {
      IMMDeviceM dev; coll.Item(i, out dev);
      IPropertyStoreM store; dev.OpenPropertyStore(0, out store);
      PropVariantM val; store.GetValue(ref nameKey, out val);
      string name = val.vt == 31 ? Marshal.PtrToStringUni(val.p) : "";
      if (name == null || !name.ToLower().Contains(nameFragment.ToLower())) continue;
      var iid = typeof(IAudioMeterInformationM).GUID;
      object o; dev.Activate(ref iid, 23, IntPtr.Zero, out o);
      var meter = (IAudioMeterInformationM)o;
      int ch; meter.GetMeteringChannelCount(out ch);
      var max = new float[ch];
      var cur = new float[ch];
      for (int n = 0; n < samples; n++) {
        meter.GetChannelsPeakValues(ch, cur);
        for (int c = 0; c < ch; c++) if (cur[c] > max[c]) max[c] = cur[c];
        System.Threading.Thread.Sleep(intervalMs);
      }
      var parts = new string[ch];
      for (int c = 0; c < ch; c++) parts[c] = max[c].ToString("F4");
      return "{\"device\":\"" + name + "\",\"channels\":" + ch + ",\"peaks\":[" + string.Join(",", parts) + "]}";
    }
    return "{\"error\":\"no device match: " + nameFragment + "\"}";
  }
}
'@

$samples = [int]($Seconds * 20)
$result = [ChannelMeter]::Probe($DeviceMatch, $samples, 50)
if ($Json) { Write-Output $result }
else {
    $r = $result | ConvertFrom-Json
    if ($r.error) { Write-Output $r.error; exit 1 }
    Write-Output "$($r.device) ($($r.channels)ch, peak-hold over ${Seconds}s)"
    for ($c = 0; $c -lt $r.channels; $c++) {
        $v = $r.peaks[$c]
        $bar = "#" * [Math]::Min(60, [int]($v * 60))
        Write-Output ("  ch{0}: {1:F4} {2}" -f ($c + 1), $v, $bar)
    }
}