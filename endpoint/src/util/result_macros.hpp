#pragma once

#include "util/error.hpp"

#define RK_RETURN_IF_ERROR(...)     \
  do {                              \
    auto rk_result = (__VA_ARGS__); \
    if (!rk_result)                 \
      return rk_result.error();     \
  } while (false)

#define RK_ASSIGN_OR_RETURN(name, ...)   \
  auto rk_result_##name = (__VA_ARGS__); \
  if (!rk_result_##name)                 \
    return rk_result_##name.error();     \
  auto name = std::move(rk_result_##name).value()
