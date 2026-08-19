# Streaming per-channel endpoint peak meters — Capture Console Session 7 Part B.
# Continuous sibling of capture/test/device-meter.ps1 (the reference instrument):
# same IAudioMeterInformation source of truth on the RENDER endpoint — the exact
# plane the audio workers write to. NEVER WASAPI loopback on VB-Audio endpoints
# (renders silence — Session 4). Zero contact with the audio workers by design.
#
# Emits one JSON line per interval (peak-hold within the interval):
#   {"device":"<full label>","channels":8,"peaks":[0.0000,...]}
# Exits 1 with {"error":...} if the endpoint is missing (spawner may retry) and
# exits 2 if the endpoint disappears mid-stream.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File capture/meter-stream.ps1 `
#     -DeviceMatch "VBMatrix In 6" [-IntervalMs 300]
param(
    [Parameter(Mandatory = $true)][string]$DeviceMatch,
    [int]$IntervalMs = 300
)

Add-Type @'
using System;
using System.Runtime.InteropServices;

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumeratorS {
  int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollectionS devices);
  int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDeviceS endpoint);
}
[Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceCollectionS {
  int GetCount(out int count);
  int Item(int index, out IMMDeviceS device);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceS {
  int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
  int OpenPropertyStore(int stgmAccess, out IPropertyStoreS properties);
  int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
}
[Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPropertyStoreS {
  int GetCount(out int count);
  int GetAt(int index, out PropertyKeyS key);
  int GetValue(ref PropertyKeyS key, out PropVariantS value);
}
[StructLayout(LayoutKind.Sequential)]
struct PropertyKeyS { public Guid fmtid; public int pid; }
[StructLayout(LayoutKind.Sequential)]
struct PropVariantS { public ushort vt; public ushort r1, r2, r3; public IntPtr p; public int p2; }
[Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioMeterInformationS {
  int GetPeakValue(out float peak);
  int GetMeteringChannelCount(out int count);
  int GetChannelsPeakValues(int count, [Out, MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 0)] float[] peaks);
}
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumeratorS {}

public static class ChannelMeterStream {
  // Never returns on the happy path: one JSON line per interval, flushed.
  public static int Stream(string nameFragment, int intervalMs) {
    var devEnum = (IMMDeviceEnumeratorS)(new MMDeviceEnumeratorS());
    IMMDeviceCollectionS coll;
    devEnum.EnumAudioEndpoints(0, 1, out coll); // eRender, DEVICE_STATE_ACTIVE
    int count; coll.GetCount(out count);
    var nameKey = new PropertyKeyS { fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 14 };
    for (int i = 0; i < count; i++) {
      IMMDeviceS dev; coll.Item(i, out dev);
      IPropertyStoreS store; dev.OpenPropertyStore(0, out store);
      PropVariantS val; store.GetValue(ref nameKey, out val);
      string name = val.vt == 31 ? Marshal.PtrToStringUni(val.p) : "";
      if (name == null || !name.ToLower().Contains(nameFragment.ToLower())) continue;
      var iid = typeof(IAudioMeterInformationS).GUID;
      object o; dev.Activate(ref iid, 23, IntPtr.Zero, out o);
      var meter = (IAudioMeterInformationS)o;
      int ch; meter.GetMeteringChannelCount(out ch);
      var max = new float[ch];
      var cur = new float[ch];
      int sampleMs = 50;
      int perInterval = Math.Max(1, intervalMs / sampleMs);
      var head = "{\"device\":\"" + name.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\",\"channels\":" + ch + ",\"peaks\":[";
      while (true) {
        Array.Clear(max, 0, ch);
        for (int n = 0; n < perInterval; n++) {
          int hr = meter.GetChannelsPeakValues(ch, cur);
          if (hr != 0) return 2; // endpoint went away mid-stream
          for (int c = 0; c < ch; c++) if (cur[c] > max[c]) max[c] = cur[c];
          System.Threading.Thread.Sleep(sampleMs);
        }
        var parts = new string[ch];
        for (int c = 0; c < ch; c++) parts[c] = max[c].ToString("F4", System.Globalization.CultureInfo.InvariantCulture);
        Console.Out.WriteLine(head + string.Join(",", parts) + "]}");
        Console.Out.Flush();
      }
    }
    Console.Out.WriteLine("{\"error\":\"no device match: " + nameFragment.Replace("\"", "'") + "\"}");
    Console.Out.Flush();
    return 1;
  }
}
'@

exit [ChannelMeterStream]::Stream($DeviceMatch, $IntervalMs)
