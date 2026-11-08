#include "browser/control_input_codec.h"
#include <array>
#include <cmath>
#include "base/strings/string_number_conversions.h"
#include "base/strings/utf_string_conversions.h"
namespace remotekit::browser {
namespace {
bool ReadId(const base::DictValue& object, std::string_view key, uint64_t* value) {
  const auto* text = object.FindString(key);
  return text && base::StringToUint64(*text, value) && *value != 0;
}
std::optional<double> Number(const base::DictValue& object, std::string_view key) {
  const auto* value = object.Find(key);
  if (value && value->is_int())
    return value->GetInt();
  if (value && value->is_double())
    return value->GetDouble();
  return std::nullopt;
}
Result<InputPayload> PayloadError(const char* detail) {
  return {{}, {ErrorCode::invalid_request, detail}};
}
Result<InputPayload> DecodeIme(const base::DictValue* event) {
  InputPayload payload;
  const auto* type = event->FindString("type");
  if (*type == "ime_commit" || *type == "ime_set") {
    const auto* text = event->FindString("text");
    if (!text)
      return PayloadError("text_required");
    if (*type == "ime_commit")
      payload = ImeCommit{base::UTF8ToUTF16(*text)};
    else {
      const auto start = event->FindInt("selection_start"), end = event->FindInt("selection_end");
      if (!start || !end || *start < 0 || *end < 0)
        return PayloadError("selection_required");
      payload = ImeSet{base::UTF8ToUTF16(*text), static_cast<uint32_t>(*start),
                       static_cast<uint32_t>(*end)};
    }
  } else if (*type == "ime_cancel")
    payload = ImeCancel{};
  else if (*type == "ime_finish")
    payload = ImeFinish{};

  return {std::move(payload), {}};
}
Result<InputPayload> DecodeKey(const base::DictValue* event) {
  InputPayload payload;

  const auto* action = event->FindString("action");
  const auto physical = event->FindInt("physical_code"),
             windows = event->FindInt("windows_key_code"), dom_code = event->FindInt("dom_code");
  const auto* dom_key = event->FindString("dom_key");
  uint64_t key_value = 0;
  if (!action || !physical || *physical < 0 || !windows || !dom_code || *dom_code < 0 || !dom_key ||
      !base::StringToUint64(*dom_key, &key_value))
    return PayloadError("invalid_key");
  KeyInput key;
  if (*action == "down")
    key.action = KeyInput::Action::down;
  else if (*action == "up")
    key.action = KeyInput::Action::up;
  else if (*action == "char")
    key.action = KeyInput::Action::character;
  else
    return PayloadError("invalid_key_action");
  key.physical_code = static_cast<uint32_t>(*physical);
  key.windows_key_code = *windows;
  key.dom_code = static_cast<uint32_t>(*dom_code);
  key.dom_key = key_value;
  key.modifiers = static_cast<uint32_t>(event->FindInt("modifiers").value_or(0));
  key.repeat = event->FindBool("repeat").value_or(false);
  if (const auto* text = event->FindString("text"))
    key.text = base::UTF8ToUTF16(*text);
  if (const auto* text = event->FindString("unmodified_text"))
    key.unmodified_text = base::UTF8ToUTF16(*text);
  payload = std::move(key);

  return {std::move(payload), {}};
}
Result<InputPayload> DecodeTouch(const base::DictValue* event) {
  InputPayload payload;

  const auto* action = event->FindString("action");
  const auto* points = event->FindList("points");
  if (!action || !points || points->size() > 16)
    return PayloadError("invalid_touch");
  TouchInput touch;
  const auto* gesture_mode = event->FindString("gestureMode");
  if (!gesture_mode || *gesture_mode != "client-v1")
    return PayloadError("gestureMode must be client-v1");
  const auto* candidates = event->FindList("gestures");
  if (!candidates || candidates->size() > 8)
    return PayloadError("invalid_gestures");
  if (candidates)
    for (const auto& candidate : *candidates) {
      const auto* g = candidate.GetIfDict();
      const auto* kind = g ? g->FindString("type") : nullptr;
      const auto x = g ? Number(*g, "x") : std::nullopt, y = g ? Number(*g, "y") : std::nullopt;
      if (!kind || !x || !y)
        return PayloadError("invalid_gesture");
      static constexpr std::array<const char*, 12> names = {
          "tapDown",    "tapCancel",   "tap",      "scrollBegin", "scrollUpdate", "scrollEnd",
          "pinchBegin", "pinchUpdate", "pinchEnd", "flingStart",  "flingCancel",  "longTap"};
      int candidate_index = 0;
      while (candidate_index != 12 && *kind != names[candidate_index])
        ++candidate_index;
      if (candidate_index == 12)
        return PayloadError("invalid_gesture_type");
      for (const auto* field : {"deltaX", "deltaY", "scale", "velocityX", "velocityY"})
        if (g->contains(field) && !Number(*g, field))
          return PayloadError("invalid_gesture_number");
      if ((candidate_index == 3 || candidate_index == 4) &&
          (!Number(*g, "deltaX") || !Number(*g, "deltaY")))
        return PayloadError("missing_gesture_delta");
      if (candidate_index == 7 && !Number(*g, "scale"))
        return PayloadError("missing_gesture_scale");
      if (candidate_index == 9 && (!Number(*g, "velocityX") || !Number(*g, "velocityY")))
        return PayloadError("missing_gesture_velocity");
      touch.gestures.push_back({static_cast<TouchInput::Gesture::Type>(candidate_index), *x, *y,
                                Number(*g, "deltaX").value_or(0), Number(*g, "deltaY").value_or(0),
                                Number(*g, "scale").value_or(1),
                                Number(*g, "velocityX").value_or(0),
                                Number(*g, "velocityY").value_or(0)});
    }

  if (*action == "start")
    touch.action = TouchInput::Action::start;
  else if (*action == "move")
    touch.action = TouchInput::Action::move;
  else if (*action == "end")
    touch.action = TouchInput::Action::end;
  else if (*action == "cancel")
    touch.action = TouchInput::Action::cancel;
  else
    return PayloadError("invalid_touch_action");
  if (const auto* mode = event->FindString("clockMode")) {
    const auto* sequence = event->FindString("sequenceId");
    const auto elapsed = Number(*event, "sampleElapsedUs");
    const auto wall = Number(*event, "startServerWallUs");
    if (!sequence || sequence->empty() || sequence->size() > 128 || !elapsed || *elapsed < 0 ||
        *elapsed > 86400000000.0 || std::floor(*elapsed) != *elapsed ||
        (*mode != "source" && *mode != "arrival-fallback") ||
        (*mode == "source" &&
         (!wall || *wall <= 0 || *wall > 9007199254740991.0 || std::floor(*wall) != *wall)) ||
        (*mode == "arrival-fallback" && wall))
      return PayloadError("invalid_touch_clock");
    touch.clock = TouchInput::Clock{*sequence, *mode == "source", static_cast<int64_t>(*elapsed),
                                    wall ? static_cast<int64_t>(*wall) : 0};
  } else if (event->contains("sequenceId") || event->contains("sampleElapsedUs") ||
             event->contains("startServerWallUs"))
    return PayloadError("incomplete_touch_clock");
  if (const auto* samples = event->FindList("samples")) {
    if (!touch.clock || touch.action != TouchInput::Action::move || samples->size() > 32)
      return PayloadError("invalid_touch_samples");
    for (const auto& sample : *samples) {
      const auto* dict = sample.GetIfDict();
      const auto elapsed = dict ? Number(*dict, "sampleElapsedUs") : std::nullopt;
      const auto* changed = dict ? dict->FindList("points") : nullptr;
      if (!elapsed || *elapsed < 0 || *elapsed > touch.clock->elapsed_us ||
          std::floor(*elapsed) != *elapsed || !changed || changed->empty() || changed->size() > 16)
        return PayloadError("invalid_touch_sample");
      TouchInput::Sample value{static_cast<int64_t>(*elapsed), {}};
      for (const auto& point : *changed) {
        const auto* point_dict = point.GetIfDict();
        if (!point_dict)
          return PayloadError("invalid_touch_sample_point");
        const auto contact_id = point_dict->FindInt("id");
        const auto x = Number(*point_dict, "x"), y = Number(*point_dict, "y"),
                   pressure = Number(*point_dict, "pressure");
        if (!contact_id || *contact_id < 0 || !x || !y || !pressure)
          return PayloadError("invalid_touch_sample_point");
        value.points.push_back({static_cast<uint32_t>(*contact_id), *x, *y, *pressure});
      }
      touch.samples.push_back(std::move(value));
    }
  }
  for (const auto& point : *points) {
    const auto* dict = point.GetIfDict();
    if (!dict)
      return PayloadError("invalid_touch_point");
    auto point_id = dict->FindInt("id");
    auto x = Number(*dict, "x"), y = Number(*dict, "y"), pressure = Number(*dict, "pressure");
    if (!point_id || *point_id < 0 || !x || !y || !pressure)
      return PayloadError("invalid_touch_point");
    touch.points.push_back({static_cast<uint32_t>(*point_id), *x, *y, *pressure});
  }
  payload = std::move(touch);

  return {std::move(payload), {}};
}
Result<InputPayload> DecodeGesture(const base::DictValue* event) {
  InputPayload payload;

  const auto* mode = event->FindString("gestureMode");
  const auto* action = event->FindString("action");
  const auto* sequence = event->FindString("sequenceId");
  const bool long_press = action && *action == "longPress";
  const auto elapsed = Number(*event, "sampleElapsedUs"),
             x = Number(*event, long_press ? "x" : "cumulativeX"),
             y = Number(*event, long_press ? "y" : "cumulativeY");
  if (!mode || *mode != "client-v1" || !action || !sequence || !elapsed || !x || !y ||
      *elapsed < 0 || *elapsed > 86400000000.0 || std::floor(*elapsed) != *elapsed)
    return PayloadError("invalid_client_gesture");
  GestureInput::Action kind;
  if (long_press)
    kind = GestureInput::Action::long_press;
  else if (*action == "momentum")
    kind = GestureInput::Action::momentum;
  else if (*action == "momentumEnd")
    kind = GestureInput::Action::momentum_end;
  else if (*action == "cancel")
    kind = GestureInput::Action::cancel;
  else
    return PayloadError("invalid_client_gesture_action");
  GestureInput gesture{kind, *sequence, static_cast<int64_t>(*elapsed)};
  if (long_press) {
    gesture.x = *x;
    gesture.y = *y;
  } else {
    gesture.cumulative_x = *x;
    gesture.cumulative_y = *y;
  }
  payload = std::move(gesture);

  return {std::move(payload), {}};
}
Result<InputPayload> DecodeMouse(const base::DictValue* event) {
  InputPayload payload;

  const auto* action = event->FindString("action");
  const auto x = Number(*event, "x"), y = Number(*event, "y");
  const auto button = event->FindInt("button");
  const auto clicks = event->FindInt("click_count").value_or(1);
  if (!action || !x || !y || !button || *button < 0 || *button > 5 || clicks < 0 || clicks > 3 ||
      (*action != "move" && *action != "leave" && clicks == 0))
    return PayloadError("invalid_mouse");
  MouseInput::Action kind;
  if (*action == "move")
    kind = MouseInput::Action::move;
  else if (*action == "down")
    kind = MouseInput::Action::down;
  else if (*action == "up")
    kind = MouseInput::Action::up;
  else if (*action == "leave")
    kind = MouseInput::Action::leave;
  else
    return PayloadError("invalid_mouse_action");
  payload = MouseInput{kind,
                       *x,
                       *y,
                       static_cast<uint8_t>(*button),
                       static_cast<uint32_t>(event->FindInt("modifiers").value_or(0)),
                       static_cast<uint8_t>(clicks)};

  return {std::move(payload), {}};
}
Result<InputPayload> DecodeWheel(const base::DictValue* event) {
  InputPayload payload;

  auto x = Number(*event, "x"), y = Number(*event, "y"), dx = Number(*event, "dx"),
       dy = Number(*event, "dy");
  if (!x || !y || !dx || !dy)
    return PayloadError("invalid_wheel");
  payload =
      WheelInput{*x, *y, *dx, *dy, static_cast<uint32_t>(event->FindInt("modifiers").value_or(0))};

  return {std::move(payload), {}};
}
Result<InputPayload> DecodeSelectionCommand(const base::DictValue* event) {
  SelectionCommand value;
  const auto* menu = event->FindString("menu");
  const auto* command = event->FindString("command");
  if (!menu || !ReadId(*event, "menu", &value.menu) || *menu != base::NumberToString(value.menu) ||
      !command)
    return PayloadError("invalid_selection_command");
  if (*command == "cut")
    value.command = SelectionCommand::Command::cut;
  else if (*command == "copy")
    value.command = SelectionCommand::Command::copy;
  else if (*command == "paste")
    value.command = SelectionCommand::Command::paste;
  else if (*command == "selectAll")
    value.command = SelectionCommand::Command::select_all;
  else
    return PayloadError("invalid_selection_command");
  return {value, {}};
}
Result<InputPayload> DecodePayload(const base::DictValue* event, std::string_view type) {
  struct Decoder {
    std::string_view type;
    Result<InputPayload> (*decode)(const base::DictValue*);
  };
  static constexpr Decoder decoders[] = {
      {"ime_commit", DecodeIme},
      {"ime_set", DecodeIme},
      {"ime_cancel", DecodeIme},
      {"ime_finish", DecodeIme},
      {"key", DecodeKey},
      {"touch", DecodeTouch},
      {"selection_command", DecodeSelectionCommand},
      {"gesture", DecodeGesture},
      {"mouse", DecodeMouse},
      {"wheel", DecodeWheel},
  };
  for (const auto& decoder : decoders)
    if (decoder.type == type)
      return decoder.decode(event);
  return PayloadError("Unsupported input type");
}
}  // namespace
Result<InputEvent> DecodeControlInput(const base::DictValue& request,
                                      SessionId session,
                                      WebViewId view) {
  InputEvent input;
  auto error = [](const char* detail) -> Result<InputEvent> {
    return {{}, {ErrorCode::invalid_request, detail}};
  };
  input.token.session = session;
  input.token.view = view;
  if (!ReadId(request, "instance", &input.token.instance) ||
      !ReadId(request, "document", &input.token.document) ||
      !ReadId(request, "focus", &input.token.focus) ||
      !ReadId(request, "sequence", &input.sequence))
    return error("input_token_required");
  const auto* event = request.FindDict("event");
  const auto* type = event ? event->FindString("type") : nullptr;
  if (!type)
    return error("event_type_required");
  if (event->Find("editableTarget")) {
    const auto* target = event->FindString("editableTarget");
    if (!target || !ReadId(*event, "editableTarget", &input.editable_target) ||
        *target != base::NumberToString(input.editable_target))
      return error("invalid_editable_target");
  }
  auto decoded = DecodePayload(event, *type);
  if (!decoded)
    return {{}, decoded.status};
  input.payload = std::move(decoded.value);
  const auto valid = ValidateInput(input.payload);
  if (!valid)
    return {{}, valid};
  return {std::move(input), {}};
}
}  // namespace remotekit::browser
