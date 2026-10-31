#include <iostream>
#include "remotekit/core.hpp"
int main() {
  remotekit::Endpoint endpoint;
  const auto session = endpoint.CreateSession("demo-tenant").value;
  const auto profile = endpoint.AddProfile(session, "default").value;
  const auto view = endpoint.CreateWebView(session, profile).value;
  endpoint.SetFocus(session, view, true);
  auto request = endpoint.RequestLifecycle(session, view, remotekit::Lifecycle::freeze);
  std::cout << "Model only: freeze requested; actual remains live until host completion.\n";
  endpoint.CompleteLifecycle(session, request.value, true);
  auto atlas = remotekit::PackAtlas(1024, 1024, 2, {{view, 640, 480, 1.25}});
  if (!atlas)
    return 1;
  const auto& rect = atlas.value.placements.front().content;
  std::cout << "Stable view " << view << " content rect: " << rect.x << ',' << rect.y << ' '
            << rect.width << 'x' << rect.height << '\n';
}
