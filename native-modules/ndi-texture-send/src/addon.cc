// ndi-texture-send — GPU shared-texture readback → NDI send, off the Electron main loop.
// Capture Console fork, Session 6.
//
// Consumes Electron OSR shared textures (webPreferences.offscreen.useSharedTexture)
// per the Electron 43 OSR contract (shell/browser/osr/README.md):
//   - open the NT handle EVERY frame (µs-cheap; handle values are not stable keys),
//   - CopyResource into a staging texture we own, Flush, then the JS side calls
//     texture.release() immediately — never read the shared texture after release,
//   - bgra/rgba output textures carry NO keyed mutex (only nv12 does), so there is
//     nothing to Acquire; Flush-before-release is the sanctioned ordering.
//
// Threading: the caller (Electron main) thread does only OpenSharedResource1 +
// CopyResource + Flush (command submission, no GPU waits). A dedicated worker thread
// per sender does Map (the GPU wait), the synchronous NDI send straight from the
// mapped pointer (pData + RowPitch — NDI takes an explicit stride, no repacking),
// and Unmap. No per-frame callbacks ever land on the caller's loop; stats are
// polled synchronously.
//
// Send discipline mirrors capture/ndi-sender.js: bounded slots (depth), drop when
// full, never queue unbounded. Senders live for the process lifetime; destroy()
// exists only for the watchdog-guarded exit path (the Session 5 wedge rules apply
// to native code too).

#include <napi.h>

#include <windows.h>
#include <d3d11_1.h>
#include <wrl/client.h>

#include <Processing.NDI.Lib.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <deque>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

using Microsoft::WRL::ComPtr;

namespace {

std::once_flag g_ndi_init_flag;
bool g_ndi_ok = false;

bool EnsureNdi() {
  std::call_once(g_ndi_init_flag, []() { g_ndi_ok = NDIlib_initialize(); });
  return g_ndi_ok;
}

uint64_t NowNs() {
  return (uint64_t)std::chrono::duration_cast<std::chrono::nanoseconds>(
             std::chrono::steady_clock::now().time_since_epoch())
      .count();
}

std::string HrString(const char* what, HRESULT hr) {
  char buf[128];
  snprintf(buf, sizeof(buf), "%s failed (hr=0x%08lX)", what, (unsigned long)hr);
  return std::string(buf);
}

NDIlib_FourCC_video_type_e FourCCFromString(const std::string& s) {
  if (s == "rgba") return NDIlib_FourCC_video_type_RGBA;
  return NDIlib_FourCC_video_type_BGRA;  // Chromium OSR default
}

HRESULT CreateD3D(ComPtr<ID3D11Device>* device, ComPtr<ID3D11Device1>* device1,
                  ComPtr<ID3D11DeviceContext>* ctx) {
  // Default adapter = the adapter Chromium's GPU process uses on this box.
  HRESULT hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
                                 D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0,
                                 D3D11_SDK_VERSION, device->GetAddressOf(), nullptr,
                                 ctx->GetAddressOf());
  if (FAILED(hr)) return hr;
  return (*device)->QueryInterface(IID_PPV_ARGS(device1->GetAddressOf()));
}

HANDLE HandleFromBuffer(const Napi::Buffer<uint8_t>& buf) {
  if (buf.Length() < sizeof(HANDLE)) return nullptr;
  return *reinterpret_cast<HANDLE*>(buf.Data());
}

// One bounded pipeline slot: either a staging texture (GPU path) or an owned
// CPU buffer (fallback path). FREE → RESERVED (caller filling) → QUEUED
// (worker's) → FREE.
struct Slot {
  enum State { FREE, RESERVED, QUEUED };
  State state = FREE;
  // GPU path
  ComPtr<ID3D11Texture2D> staging;
  UINT stagingW = 0, stagingH = 0;
  DXGI_FORMAT stagingFmt = DXGI_FORMAT_UNKNOWN;
  // CPU path
  std::vector<uint8_t> cpu;
  int cpuStride = 0;
  // frame descriptor
  bool isTexture = false;
  int visW = 0, visH = 0;
  NDIlib_FourCC_video_type_e fourcc = NDIlib_FourCC_video_type_BGRA;
};

class TextureSender : public Napi::ObjectWrap<TextureSender> {
 public:
  static Napi::Function Init(Napi::Env env) {
    return DefineClass(
        env, "TextureSender",
        {
            InstanceMethod("sendTexture", &TextureSender::SendTexture),
            InstanceMethod("sendFrame", &TextureSender::SendFrame),
            InstanceMethod("stats", &TextureSender::Stats),
            InstanceMethod("connections", &TextureSender::Connections),
            InstanceMethod("tally", &TextureSender::Tally),
            InstanceMethod("destroy", &TextureSender::Destroy),
        });
  }

  TextureSender(const Napi::CallbackInfo& info) : Napi::ObjectWrap<TextureSender>(info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
      Napi::TypeError::New(env, "createSender(name, fps?, depth?)").ThrowAsJavaScriptException();
      return;
    }
    name_ = info[0].As<Napi::String>().Utf8Value();
    fps_ = info.Length() > 1 && info[1].IsNumber() ? info[1].As<Napi::Number>().Int32Value() : 30;
    int depth = info.Length() > 2 && info[2].IsNumber() ? info[2].As<Napi::Number>().Int32Value() : 2;
    if (depth < 1) depth = 1;
    if (depth > 4) depth = 4;

    if (!EnsureNdi()) {
      Napi::Error::New(env, "NDIlib_initialize failed (unsupported CPU?)").ThrowAsJavaScriptException();
      return;
    }

    HRESULT hr = CreateD3D(&device_, &device1_, &ctx_);
    if (FAILED(hr)) {
      Napi::Error::New(env, HrString("D3D11CreateDevice", hr)).ThrowAsJavaScriptException();
      return;
    }

    NDIlib_send_create_t opts{};
    opts.p_ndi_name = name_.c_str();
    opts.clock_video = false;  // paint events set the cadence — NDI must not throttle
    opts.clock_audio = false;
    ndi_ = NDIlib_send_create(&opts);
    if (!ndi_) {
      // Same failure surface grandiose exposed as code 2014: duplicate/lingering
      // name. The JS wrapper owns the retry ladder.
      Napi::Error::New(env, "NDIlib_send_create failed (name in use or lingering?)")
          .ThrowAsJavaScriptException();
      return;
    }

    slots_.resize(depth);
    running_ = true;
    worker_ = std::thread([this]() { WorkerLoop(); });
  }

  ~TextureSender() { DoDestroy(); }

 private:
  // ---- caller-thread entry points -----------------------------------------

  // sendTexture(ntHandleBuffer, visW, visH, pixelFormat?) → 1 sent, 0 dropped
  // (pipeline full — normal backpressure), -1 open/copy failure (caller counts
  // these toward the CPU-path fallback decision).
  Napi::Value SendTexture(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!running_ || !ndi_) return Napi::Number::New(env, -1);
    if (info.Length() < 3 || !info[0].IsBuffer()) {
      Napi::TypeError::New(env, "sendTexture(handleBuffer, w, h, pixelFormat?)")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    int visW = info[1].As<Napi::Number>().Int32Value();
    int visH = info[2].As<Napi::Number>().Int32Value();
    std::string fmt = info.Length() > 3 && info[3].IsString()
                          ? info[3].As<Napi::String>().Utf8Value()
                          : "bgra";

    int idx = ReserveSlot();
    if (idx < 0) {
      dropped_++;
      return Napi::Number::New(env, 0);
    }
    Slot& s = slots_[idx];

    HANDLE handle = HandleFromBuffer(info[0].As<Napi::Buffer<uint8_t>>());
    if (!handle) {
      ReleaseSlot(idx);
      openFails_++;
      SetError("handle buffer too small");
      return Napi::Number::New(env, -1);
    }

    // Open per-frame per the OSR contract: handle values are NOT stable keys for
    // the underlying texture, and opening costs microseconds.
    ComPtr<ID3D11Texture2D> shared;
    HRESULT hr = device1_->OpenSharedResource1(handle, IID_PPV_ARGS(shared.GetAddressOf()));
    if (FAILED(hr)) {
      ReleaseSlot(idx);
      openFails_++;
      SetError(HrString("OpenSharedResource1", hr));
      return Napi::Number::New(env, -1);
    }

    D3D11_TEXTURE2D_DESC desc;
    shared->GetDesc(&desc);
    if (!s.staging || s.stagingW != desc.Width || s.stagingH != desc.Height ||
        s.stagingFmt != desc.Format) {
      D3D11_TEXTURE2D_DESC sd = desc;
      sd.Usage = D3D11_USAGE_STAGING;
      sd.BindFlags = 0;
      sd.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
      sd.MiscFlags = 0;
      sd.MipLevels = 1;
      sd.ArraySize = 1;
      sd.SampleDesc.Count = 1;
      sd.SampleDesc.Quality = 0;
      hr = device_->CreateTexture2D(&sd, nullptr, s.staging.ReleaseAndGetAddressOf());
      if (FAILED(hr)) {
        s.staging.Reset();
        s.stagingW = s.stagingH = 0;
        s.stagingFmt = DXGI_FORMAT_UNKNOWN;
        ReleaseSlot(idx);
        openFails_++;
        SetError(HrString("CreateTexture2D(staging)", hr));
        return Napi::Number::New(env, -1);
      }
      s.stagingW = desc.Width;
      s.stagingH = desc.Height;
      s.stagingFmt = desc.Format;
    }

    {
      std::lock_guard<std::mutex> lk(ctx_m_);
      ctx_->CopyResource(s.staging.Get(), shared.Get());
      // Flush is the load-bearing call: the copy must be SUBMITTED before the JS
      // side releases the texture back to Chromium's pool.
      ctx_->Flush();
    }

    if (visW <= 0 || visW > (int)desc.Width) visW = (int)desc.Width;
    if (visH <= 0 || visH > (int)desc.Height) visH = (int)desc.Height;
    s.isTexture = true;
    s.visW = visW;
    s.visH = visH;
    s.fourcc = FourCCFromString(fmt);
    QueueSlot(idx);
    return Napi::Number::New(env, 1);
  }

  // sendFrame(buffer, w, h, stride, pixelFormat?) → 1 sent, 0 dropped, -1 error.
  // CPU fallback path: copies once into an owned slot buffer on the caller
  // thread, then the worker sends — the N-API submit + completion churn still
  // leaves the main loop even without the GPU handle.
  Napi::Value SendFrame(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!running_ || !ndi_) return Napi::Number::New(env, -1);
    if (info.Length() < 4 || !info[0].IsBuffer()) {
      Napi::TypeError::New(env, "sendFrame(buffer, w, h, stride, pixelFormat?)")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    auto buf = info[0].As<Napi::Buffer<uint8_t>>();
    int w = info[1].As<Napi::Number>().Int32Value();
    int h = info[2].As<Napi::Number>().Int32Value();
    int stride = info[3].As<Napi::Number>().Int32Value();
    std::string fmt = info.Length() > 4 && info[4].IsString()
                          ? info[4].As<Napi::String>().Utf8Value()
                          : "bgra";
    if (w <= 0 || h <= 0 || stride < w * 4 || buf.Length() < (size_t)stride * h) {
      SetError("sendFrame: bad dimensions/stride/buffer");
      return Napi::Number::New(env, -1);
    }

    int idx = ReserveSlot();
    if (idx < 0) {
      dropped_++;
      return Napi::Number::New(env, 0);
    }
    Slot& s = slots_[idx];
    s.cpu.resize((size_t)stride * h);
    memcpy(s.cpu.data(), buf.Data(), (size_t)stride * h);
    s.cpuStride = stride;
    s.isTexture = false;
    s.visW = w;
    s.visH = h;
    s.fourcc = FourCCFromString(fmt);
    QueueSlot(idx);
    return Napi::Number::New(env, 1);
  }

  Napi::Value Stats(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Object o = Napi::Object::New(env);
    o.Set("sent", Napi::Number::New(env, (double)sent_.load()));
    o.Set("dropped", Napi::Number::New(env, (double)dropped_.load()));
    o.Set("openFails", Napi::Number::New(env, (double)openFails_.load()));
    uint64_t mapNs = mapNsTotal_.exchange(0);
    uint64_t sendNs = sendNsTotal_.exchange(0);
    uint64_t n = frameSamples_.exchange(0);
    o.Set("mapMs", Napi::Number::New(env, n ? (double)mapNs / n / 1e6 : 0));
    o.Set("sendMs", Napi::Number::New(env, n ? (double)sendNs / n / 1e6 : 0));
    {
      std::lock_guard<std::mutex> lk(q_m_);
      o.Set("queued", Napi::Number::New(env, (double)queue_.size()));
    }
    {
      std::lock_guard<std::mutex> lk(err_m_);
      o.Set("lastError", lastError_.empty() ? env.Null() : (napi_value)Napi::String::New(env, lastError_));
    }
    return o;
  }

  Napi::Value Connections(const Napi::CallbackInfo& info) {
    if (!ndi_) return Napi::Number::New(info.Env(), -1);
    return Napi::Number::New(info.Env(), NDIlib_send_get_no_connections(ndi_, 0));
  }

  // Session 8 Part C: downstream tally, polled on the host's stats cadence (never
  // a per-frame callback). timeout 0 = return the current state immediately;
  // verified end-to-end against a receiver calling NDIlib_recv_set_tally
  // (<0.5 s propagation, clears when the tallying receiver disconnects).
  Napi::Value Tally(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!ndi_) return env.Null();
    NDIlib_tally_t t{};
    bool changed = NDIlib_send_get_tally(ndi_, &t, 0);
    Napi::Object o = Napi::Object::New(env);
    o.Set("changed", Napi::Boolean::New(env, changed));
    o.Set("on_program", Napi::Boolean::New(env, t.on_program));
    o.Set("on_preview", Napi::Boolean::New(env, t.on_preview));
    return o;
  }

  // Exit-path only. NDIlib_send_destroy can block with work in flight — the
  // external taskkill watchdog bounds any hang, same policy as the JS senders.
  Napi::Value Destroy(const Napi::CallbackInfo& info) {
    DoDestroy();
    return info.Env().Undefined();
  }

  // ---- worker -------------------------------------------------------------

  void WorkerLoop() {
    for (;;) {
      int idx = -1;
      {
        std::unique_lock<std::mutex> lk(q_m_);
        cv_.wait(lk, [&]() { return !running_ || !queue_.empty(); });
        if (!running_ && queue_.empty()) return;
        if (queue_.empty()) continue;
        idx = queue_.front();
        queue_.pop_front();
      }
      Slot& s = slots_[idx];
      if (s.isTexture) {
        SendTextureSlot(s);
      } else {
        SendCpuSlot(s);
      }
      ReleaseSlot(idx);
    }
  }

  void SendTextureSlot(Slot& s) {
    D3D11_MAPPED_SUBRESOURCE mapped{};
    HRESULT hr = E_FAIL;
    uint64_t t0 = NowNs();
    // DO_NOT_WAIT loop: the ctx mutex is never held across a GPU wait, so the
    // caller thread's open+copy stays unblocked.
    for (;;) {
      {
        std::lock_guard<std::mutex> lk(ctx_m_);
        hr = ctx_->Map(s.staging.Get(), 0, D3D11_MAP_READ, D3D11_MAP_FLAG_DO_NOT_WAIT, &mapped);
      }
      if (hr != DXGI_ERROR_WAS_STILL_DRAWING) break;
      if (!running_) return;
      std::this_thread::sleep_for(std::chrono::microseconds(250));
    }
    if (FAILED(hr)) {
      SetError(HrString("Map(staging)", hr));
      return;
    }
    uint64_t t1 = NowNs();

    NDIlib_video_frame_v2_t frame{};
    frame.xres = s.visW;
    frame.yres = s.visH;
    frame.FourCC = s.fourcc;
    frame.frame_rate_N = fps_;
    frame.frame_rate_D = 1;
    frame.picture_aspect_ratio = (float)s.visW / (float)s.visH;
    frame.frame_format_type = NDIlib_frame_format_type_progressive;
    frame.timecode = NDIlib_send_timecode_synthesize;
    frame.p_data = reinterpret_cast<uint8_t*>(mapped.pData);
    frame.line_stride_in_bytes = (int)mapped.RowPitch;
    NDIlib_send_send_video_v2(ndi_, &frame);  // sync — compresses on this thread
    uint64_t t2 = NowNs();

    {
      std::lock_guard<std::mutex> lk(ctx_m_);
      ctx_->Unmap(s.staging.Get(), 0);
    }
    mapNsTotal_ += t1 - t0;
    sendNsTotal_ += t2 - t1;
    frameSamples_++;
    sent_++;
  }

  void SendCpuSlot(Slot& s) {
    uint64_t t1 = NowNs();
    NDIlib_video_frame_v2_t frame{};
    frame.xres = s.visW;
    frame.yres = s.visH;
    frame.FourCC = s.fourcc;
    frame.frame_rate_N = fps_;
    frame.frame_rate_D = 1;
    frame.picture_aspect_ratio = (float)s.visW / (float)s.visH;
    frame.frame_format_type = NDIlib_frame_format_type_progressive;
    frame.timecode = NDIlib_send_timecode_synthesize;
    frame.p_data = s.cpu.data();
    frame.line_stride_in_bytes = s.cpuStride;
    NDIlib_send_send_video_v2(ndi_, &frame);
    sendNsTotal_ += NowNs() - t1;
    frameSamples_++;
    sent_++;
  }

  // ---- slot bookkeeping ---------------------------------------------------

  int ReserveSlot() {
    std::lock_guard<std::mutex> lk(q_m_);
    for (size_t i = 0; i < slots_.size(); i++) {
      if (slots_[i].state == Slot::FREE) {
        slots_[i].state = Slot::RESERVED;
        return (int)i;
      }
    }
    return -1;
  }

  void QueueSlot(int idx) {
    {
      std::lock_guard<std::mutex> lk(q_m_);
      slots_[idx].state = Slot::QUEUED;
      queue_.push_back(idx);
    }
    cv_.notify_one();
  }

  void ReleaseSlot(int idx) {
    std::lock_guard<std::mutex> lk(q_m_);
    slots_[idx].state = Slot::FREE;
  }

  void SetError(const std::string& e) {
    std::lock_guard<std::mutex> lk(err_m_);
    lastError_ = e;
  }

  void DoDestroy() {
    bool was = running_.exchange(false);
    if (!was) return;
    cv_.notify_all();
    if (worker_.joinable()) worker_.join();
    if (ndi_) {
      NDIlib_send_destroy(ndi_);
      ndi_ = nullptr;
    }
  }

  std::string name_;
  int fps_ = 30;
  NDIlib_send_instance_t ndi_ = nullptr;
  ComPtr<ID3D11Device> device_;
  ComPtr<ID3D11Device1> device1_;
  ComPtr<ID3D11DeviceContext> ctx_;
  std::mutex ctx_m_;  // guards ctx_ (ID3D11DeviceContext is not thread-safe)
  std::mutex q_m_;    // guards slots_[].state + queue_
  std::condition_variable cv_;
  std::vector<Slot> slots_;
  std::deque<int> queue_;
  std::thread worker_;
  std::atomic<bool> running_{false};
  std::atomic<uint64_t> sent_{0}, dropped_{0}, openFails_{0};
  std::atomic<uint64_t> mapNsTotal_{0}, sendNsTotal_{0}, frameSamples_{0};
  std::mutex err_m_;
  std::string lastError_;
};

// probeOpen(ntHandleBuffer) → { width, height, dxgiFormat } — verify-early step 1:
// can this process open a real paint event's shared handle at all? Own throwaway
// device so the probe proves the standalone contract, not sender plumbing.
Napi::Value ProbeOpen(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsBuffer()) {
    Napi::TypeError::New(env, "probeOpen(handleBuffer)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  HANDLE handle = HandleFromBuffer(info[0].As<Napi::Buffer<uint8_t>>());
  if (!handle) {
    Napi::Error::New(env, "handle buffer too small").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  ComPtr<ID3D11Device> device;
  ComPtr<ID3D11Device1> device1;
  ComPtr<ID3D11DeviceContext> ctx;
  HRESULT hr = CreateD3D(&device, &device1, &ctx);
  if (FAILED(hr)) {
    Napi::Error::New(env, HrString("D3D11CreateDevice", hr)).ThrowAsJavaScriptException();
    return env.Undefined();
  }
  ComPtr<ID3D11Texture2D> shared;
  hr = device1->OpenSharedResource1(handle, IID_PPV_ARGS(shared.GetAddressOf()));
  if (FAILED(hr)) {
    Napi::Error::New(env, HrString("OpenSharedResource1", hr)).ThrowAsJavaScriptException();
    return env.Undefined();
  }
  D3D11_TEXTURE2D_DESC desc;
  shared->GetDesc(&desc);
  Napi::Object o = Napi::Object::New(env);
  o.Set("width", Napi::Number::New(env, desc.Width));
  o.Set("height", Napi::Number::New(env, desc.Height));
  o.Set("dxgiFormat", Napi::Number::New(env, desc.Format));
  return o;
}

Napi::Value CreateSender(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Function ctor = env.GetInstanceData<Napi::FunctionReference>()->Value();
  size_t argc = info.Length();
  std::vector<napi_value> args;
  for (size_t i = 0; i < argc; i++) args.push_back(info[i]);
  return ctor.New(args);
}

}  // namespace

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  Napi::Function ctor = TextureSender::Init(env);
  env.SetInstanceData(new Napi::FunctionReference(Napi::Persistent(ctor)));
  exports.Set("createSender", Napi::Function::New(env, CreateSender));
  exports.Set("probeOpen", Napi::Function::New(env, ProbeOpen));
  return exports;
}

NODE_API_MODULE(ndi_texture_send, Init)
