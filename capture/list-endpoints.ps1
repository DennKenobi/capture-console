# Render-endpoint enumeration for the console's device dropdown — Session 9.
# Same IAudioMeterInformation COM core as device-meter.ps1 (GetMeteringChannelCount is
# the endpoint's mix-format channel count — exactly the "does it have 8 channels?"
# question the operator needs answered before picking a device).
# Output: one JSON object {"default":"<label>","devices":[{"label":"...","channels":N},...]}
#   powershell -NoProfile -ExecutionPolicy Bypass -File capture/list-endpoints.ps1

Add-Type @'
using System;
using System.Runtime.InteropServices;

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumeratorE {
  int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollectionE devices);
  int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDeviceE endpoint);
}
[Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceCollectionE {
  int GetCount(out int count);
  int Item(int index, out IMMDeviceE device);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceE {
  int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
  int OpenPropertyStore(int stgmAccess, out IPropertyStoreE properties);
  int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
}
[Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPropertyStoreE {
  int GetCount(out int count);
  int GetAt(int index, out PropertyKeyE key);
  int GetValue(ref PropertyKeyE key, out PropVariantE value);
}
[StructLayout(LayoutKind.Sequential)]
struct PropertyKeyE { public Guid fmtid; public int pid; }
[StructLayout(LayoutKind.Sequential)]
struct PropVariantE { public ushort vt; public ushort r1, r2, r3; public IntPtr p; public int p2; }
[Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioMeterInformationE {
  int GetPeakValue(out float peak);
  int GetMeteringChannelCount(out int count);
  int GetChannelsPeakValues(int count, [Out, MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 0)] float[] peaks);
}
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumeratorE {}

public static class EndpointList {
  static string JsonEscape(string s) {
    return s.Replace("\\", "\\\\").Replace("\"", "\\\"");
  }
  public static string List() {
    var devEnum = (IMMDeviceEnumeratorE)(new MMDeviceEnumeratorE());
    var nameKey = new PropertyKeyE { fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 14 };

    string defLabel = "";
    try {
      IMMDeviceE defDev;
      devEnum.GetDefaultAudioEndpoint(0, 1, out defDev); // eRender, eMultimedia
      IPropertyStoreE defStore; defDev.OpenPropertyStore(0, out defStore);
      PropVariantE defVal; defStore.GetValue(ref nameKey, out defVal);
      if (defVal.vt == 31) defLabel = Marshal.PtrToStringUni(defVal.p);
    } catch {}

    IMMDeviceCollectionE coll;
    devEnum.EnumAudioEndpoints(0, 1, out coll); // eRender, DEVICE_STATE_ACTIVE
    int count; coll.GetCount(out count);
    var parts = new System.Collections.Generic.List<string>();
    for (int i = 0; i < count; i++) {
      try {
        IMMDeviceE dev; coll.Item(i, out dev);
        IPropertyStoreE store; dev.OpenPropertyStore(0, out store);
        PropVariantE val; store.GetValue(ref nameKey, out val);
        string name = val.vt == 31 ? Marshal.PtrToStringUni(val.p) : "";
        if (string.IsNullOrEmpty(name)) continue;
        var iid = typeof(IAudioMeterInformationE).GUID;
        object o; dev.Activate(ref iid, 23, IntPtr.Zero, out o);
        int ch; ((IAudioMeterInformationE)o).GetMeteringChannelCount(out ch);
        parts.Add("{\"label\":\"" + JsonEscape(name) + "\",\"channels\":" + ch + "}");
      } catch { /* one bad endpoint must not empty the list */ }
    }
    return "{\"default\":\"" + JsonEscape(defLabel) + "\",\"devices\":[" + string.Join(",", parts) + "]}";
  }
}
'@

Write-Output ([EndpointList]::List())
