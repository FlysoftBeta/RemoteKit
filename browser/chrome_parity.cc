#include "browser/chrome_parity.h"

#include <array>

#include "base/strings/utf_string_conversions.h"
#include "net/http/http_util.h"
#include "third_party/blink/public/common/renderer_preferences/renderer_preferences.h"
#include "third_party/blink/public/common/web_preferences/web_preferences.h"
#include "ui/gfx/font_list.h"

namespace remotekit::browser {
namespace {
// Chrome 157: prefs_tab_helper.cc kFontDefaults, locale_settings_win.grd and
// locale_settings_win_zh-CN.xtb. Hans defaults are suppressed for the UI script;
// all other registered scripts without defaults inherit the common family.
struct ScriptFonts {
  const char* script;
  const char* standard;
  const char* fixed;
  const char* serif;
  const char* sans;
  const char* cursive;
  const char* fantasy;
  const char* math;
};
constexpr ScriptFonts kFonts[] = {
    {"Zyyy", ",Noto Sans SC,Noto Sans CJK SC,Microsoft YaHei", "NSimsun",
     ",Noto Serif SC,Noto Serif CJK SC,Simsun", ",Noto Sans SC,Noto Sans CJK SC,Microsoft YaHei",
     "KaiTi", "Impact", "Cambria Math"},
    {"Arab", "", "Courier New", "", "Segoe UI", "", "", ""},
    {"Cyrl", "Times New Roman", "Courier New", "Times New Roman", "Arial", "", "", ""},
    {"Grek", "Times New Roman", "Courier New", "Times New Roman", "Arial", "", "", ""},
    {"Jpan", ",Noto Sans JP,Noto Sans CJK JP,Meiryo,Yu Gothic", ",BIZ UDGothic,MS Gothic",
     ",Noto Serif JP,Noto Serif CJK JP,Yu Mincho,MS PMincho",
     ",Noto Sans JP,Noto Sans CJK JP,Meiryo,Yu Gothic", "", "", ""},
    {"Hang", ",Noto Sans KR,Noto Sans CJK KR,Malgun Gothic", "Gulimche",
     ",Noto Serif KR,Noto Serif CJK KR,Batang", ",Noto Sans KR,Noto Sans CJK KR,Malgun Gothic",
     "Gungsuh", "", ""},
    {"Hant", ",Noto Sans TC,Noto Sans CJK TC,Microsoft JhengHei", "MingLiU",
     ",Noto Serif TC,Noto Serif CJK TC,PMingLiU",
     ",Noto Sans TC,Noto Sans CJK TC,Microsoft JhengHei", "DFKai-SB", "", ""},
    {"Deva", "Nirmala UI", "Consolas", "Nirmala UI", "Nirmala UI", "", "", ""},
};
}  // namespace

std::string ChromeAcceptLanguage() {
  return net::HttpUtil::GenerateAcceptLanguageHeader(
      net::HttpUtil::ExpandLanguageList(kChromeLanguages));
}

void ApplyChromeRendererPreferences(blink::RendererPreferences& prefs) {
  prefs.accept_languages = kChromeLanguages;
  // chrome/browser/renderer_preferences_util.cc: Windows focus ring.
  prefs.focus_ring_color = 0xFF101010;
}

void ApplyChromeWebPreferences(blink::web_pref::WebPreferences& prefs) {
  std::array<blink::web_pref::ScriptFontFamilyMap*, 7> maps = {
      &prefs.standard_font_family_map, &prefs.fixed_font_family_map,
      &prefs.serif_font_family_map,    &prefs.sans_serif_font_family_map,
      &prefs.cursive_font_family_map,  &prefs.fantasy_font_family_map,
      &prefs.math_font_family_map};
  for (auto* map : maps)
    map->clear();
  for (const auto& row : kFonts) {
    std::array<const char*, 7> families = {row.standard, row.fixed,   row.serif, row.sans,
                                           row.cursive,  row.fantasy, row.math};
    for (size_t i = 0; i < std::size(maps); ++i) {
      if (*families[i])
        (*maps[i])[row.script] =
            base::UTF8ToUTF16(gfx::FontList::FirstAvailableOrFirst(families[i]));
    }
  }
  prefs.default_font_size = 16;
  prefs.default_fixed_font_size = 13;
  prefs.minimum_font_size = 0;
  prefs.minimum_logical_font_size = 12;
  // components/strings/components_locale_settings_zh-CN.xtb.
  prefs.default_encoding = "GBK";
  prefs.pointer_events_max_touch_points = 10;
  prefs.touch_event_feature_detection_enabled = true;
  prefs.available_pointer_types = static_cast<int>(blink::mojom::PointerType::kPointerFineType) |
                                  static_cast<int>(blink::mojom::PointerType::kPointerCoarseType);
  prefs.primary_pointer_type = blink::mojom::PointerType::kPointerFineType;
  prefs.available_hover_types = static_cast<int>(blink::mojom::HoverType::kHoverHoverType);
  prefs.primary_hover_type = blink::mojom::HoverType::kHoverHoverType;
  prefs.preferred_color_scheme = blink::mojom::PreferredColorScheme::kLight;
  prefs.preferred_contrast = blink::mojom::PreferredContrast::kNoPreference;
  prefs.in_forced_colors = false;
}
}  // namespace remotekit::browser
