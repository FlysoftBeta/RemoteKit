#pragma once
#include "base/values.h"
#include "browser/view_model.h"
namespace remotekit::browser {
Result<InputEvent> DecodeControlInput(const base::DictValue&, SessionId, WebViewId);
}
