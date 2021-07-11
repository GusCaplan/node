#ifndef SRC_NODE_WASM_STREAMING_H_
#define SRC_NODE_WASM_STREAMING_H_

#if defined(NODE_WANT_INTERNALS) && NODE_WANT_INTERNALS

#include "v8.h"

namespace node {
namespace wasm_streaming {

void WasmStreamingCallback(const v8::FunctionCallbackInfo<v8::Value>& args);

}  // namespace wasm_streaming
}  // namespace node

#endif  // defined(NODE_WANT_INTERNALS) && NODE_WANT_INTERNALS

#endif  // SRC_NODE_WASM_STREAMING_H_
