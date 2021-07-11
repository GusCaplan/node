#include "node_wasm_streaming.h"
#include "base_object-inl.h"
#include "env-inl.h"
#include "node.h"
#include "node_errors.h"
#include "v8.h"

namespace node {
namespace wasm_streaming {

using errors::TryCatchScope;

using v8::ArrayBuffer;
using v8::ArrayBufferView;
using v8::BackingStore;
using v8::CompiledWasmModule;
using v8::Context;
using v8::Function;
using v8::FunctionCallbackInfo;
using v8::FunctionTemplate;
using v8::Local;
using v8::MaybeLocal;
using v8::Object;
using v8::OwnedBuffer;
using v8::String;
using v8::Undefined;
using v8::Value;
using v8::WasmStreaming;

class WasmStreamingClient : public WasmStreaming::Client {
 public:
  explicit WasmStreamingClient(Environment* env) : env_(env) {}

 private:
  void OnModuleCompiled(CompiledWasmModule compiled_module) {
    env_->SetImmediateThreadsafe([compiled_module](Environment* env) mutable {
      OwnedBuffer owned = compiled_module.Serialize();
      if (owned.size == 0) {
        return;
      }

      std::shared_ptr<BackingStore> store =
          ArrayBuffer::NewBackingStore(env->isolate(), owned.size);
      unsigned char* dest = static_cast<unsigned char*>(store->Data());
      memcpy(dest, &owned.buffer, owned.size);
      Local<ArrayBuffer> ab = ArrayBuffer::New(env->isolate(), store);
      Local<String> url =
          String::NewFromUtf8(env->isolate(),
                              compiled_module.source_url().c_str(),
                              {},
                              compiled_module.source_url().size())
              .ToLocalChecked();

      Local<Value> args[] = {url, ab};
      env->wasm_streaming_cache_callback()
          ->Call(
              env->context(), Undefined(env->isolate()), arraysize(args), args)
          .ToLocalChecked();
    });
  }

  Environment* env_;
};

class WasmStreamingWrap : public BaseObject {
 public:
  static MaybeLocal<Object> Create(Environment* env, Local<Value> arg) {
    return GetConstructorTemplate(env)->NewInstance(env->context(), 1, &arg);
  }

  void MemoryInfo(MemoryTracker* tracker) const override {}

  SET_MEMORY_INFO_NAME(WasmStreamingWrap)
  SET_SELF_SIZE(WasmStreamingWrap)

 private:
  WasmStreamingWrap(Environment* env,
                    Local<Object> object,
                    std::shared_ptr<WasmStreaming> streaming)
      : BaseObject(env, object), streaming_(streaming) {
    MakeWeak();
  }

  static void New(const FunctionCallbackInfo<Value>& args) {
    Environment* env = Environment::GetCurrent(args);

    std::shared_ptr<WasmStreaming> streaming =
        WasmStreaming::Unpack(env->isolate(), args[0]);
    new WasmStreamingWrap(env, args.This(), streaming);
  }

  static void SetURL(const FunctionCallbackInfo<Value>& args) {
    WasmStreamingWrap* wrap;
    ASSIGN_OR_RETURN_UNWRAP(&wrap, args.This());
    Environment* env = wrap->env();

    CHECK(args[0]->IsString());
    String::Utf8Value utf8(args.GetIsolate(), args[0]);

    wrap->streaming_->SetUrl(*utf8, utf8.length());

    if (!env->wasm_streaming_cache_callback().IsEmpty()) {
      wrap->streaming_->SetClient(std::make_shared<WasmStreamingClient>(env));
    }
  }

  static void SetCompiledModuleBytes(const FunctionCallbackInfo<Value>& args) {
    WasmStreamingWrap* wrap;
    ASSIGN_OR_RETURN_UNWRAP(&wrap, args.This());

    CHECK(args[0]->IsArrayBufferView());
    Local<ArrayBufferView> ui = args[0].As<ArrayBufferView>();
    std::shared_ptr<BackingStore> store = ui->Buffer()->GetBackingStore();
    auto data = static_cast<uint8_t*>(store->Data()) + ui->ByteOffset();
    bool result =
        wrap->streaming_->SetCompiledModuleBytes(data, ui->ByteLength());

    if (result) {
      // hold buffer long enough for v8 to use it
      wrap->cached_backing_store_ = store;
    }

    args.GetReturnValue().Set(result);
  }

  static void OnBytesReceived(const FunctionCallbackInfo<Value>& args) {
    WasmStreamingWrap* wrap;
    ASSIGN_OR_RETURN_UNWRAP(&wrap, args.This());

    CHECK(args[0]->IsArrayBufferView());
    Local<ArrayBufferView> ui = args[0].As<ArrayBufferView>();
    std::shared_ptr<BackingStore> store = ui->Buffer()->GetBackingStore();
    auto data = static_cast<uint8_t*>(store->Data()) + ui->ByteOffset();
    wrap->streaming_->OnBytesReceived(data, ui->ByteLength());
  }

  static void Abort(const FunctionCallbackInfo<Value>& args) {
    WasmStreamingWrap* wrap;
    ASSIGN_OR_RETURN_UNWRAP(&wrap, args.This());

    wrap->streaming_->Abort(args[0]);
  }

  static void Finish(const FunctionCallbackInfo<Value>& args) {
    WasmStreamingWrap* wrap;
    ASSIGN_OR_RETURN_UNWRAP(&wrap, args.This());

    wrap->streaming_->Finish();
  }

  static Local<Function> GetConstructorTemplate(Environment* env) {
    Local<FunctionTemplate> tpl = env->NewFunctionTemplate(New);
    tpl->InstanceTemplate()->SetInternalFieldCount(
        WasmStreamingWrap::kInternalFieldCount);
    tpl->Inherit(BaseObject::GetConstructorTemplate(env));

    env->SetProtoMethod(tpl, "setURL", SetURL);
    env->SetProtoMethod(tpl, "setCompiledModuleBytes", SetCompiledModuleBytes);
    env->SetProtoMethod(tpl, "onBytesReceived", OnBytesReceived);
    env->SetProtoMethod(tpl, "abort", Abort);
    env->SetProtoMethod(tpl, "finish", Finish);

    return tpl->GetFunction(env->context()).ToLocalChecked();
  }

  std::shared_ptr<WasmStreaming> streaming_;
  std::shared_ptr<BackingStore> cached_backing_store_;
};

void WasmStreamingCallback(const FunctionCallbackInfo<Value>& args) {
  Environment* env = Environment::GetCurrent(args);

  TryCatchScope try_catch(env);

  Local<Function> fn = env->wasm_streaming_callback();

  Local<Object> wrap =
      WasmStreamingWrap::Create(env, args.Data()).ToLocalChecked();
  Local<Value> handler = env->wasm_streaming_cache_handler();
  if (handler.IsEmpty()) {
    handler = Undefined(env->isolate());
  }
  Local<Value> argv[] = {args[0], wrap, handler};

  if (fn->Call(env->context(), Undefined(env->isolate()), arraysize(argv), argv)
          .IsEmpty()) {
    std::shared_ptr<WasmStreaming> streaming =
        WasmStreaming::Unpack(env->isolate(), args.Data());
    streaming->Abort(try_catch.Exception());
  }
}

void SetWasmStreamingCallback(const FunctionCallbackInfo<Value>& args) {
  Environment* env = Environment::GetCurrent(args);
  CHECK(args[0]->IsFunction());
  env->set_wasm_streaming_callback(args[0].As<Function>());
}

void SetWasmStreamingCacheHandler(const FunctionCallbackInfo<Value>& args) {
  Environment* env = Environment::GetCurrent(args);
  if (args[0]->IsNull()) {
    env->set_wasm_streaming_cache_handler(Local<Object>());
    env->set_wasm_streaming_cache_callback(Local<Function>());
  } else {
    env->set_wasm_streaming_cache_handler(args[0].As<Object>());
    env->set_wasm_streaming_cache_callback(args[1].As<Function>());
  }
}

void Initialize(Local<Object> target,
                Local<Value> unused,
                Local<Context> context,
                void* priv) {
  Environment* env = Environment::GetCurrent(context);

  env->SetMethod(target, "setWasmStreamingCallback", SetWasmStreamingCallback);
  env->SetMethod(
      target, "setWasmStreamingCacheHandler", SetWasmStreamingCacheHandler);
}

}  // namespace wasm_streaming
}  // namespace node

NODE_MODULE_CONTEXT_AWARE_INTERNAL(wasm_streaming,
                                   node::wasm_streaming::Initialize)
