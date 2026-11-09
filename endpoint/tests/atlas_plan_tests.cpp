#include "protocol/atlas_plan.hpp"
#include "protocol/page_viewport.hpp"
#include <fstream>
#include <sstream>
#include <iostream>
int main(int argc, char** argv) {
  if (argc != 2)
    return 1;
  std::ifstream file(argv[1]);
  if (!file)
    return 2;
  std::string line;
  int count = 0;
  while (std::getline(file, line)) {
    if (line.empty() || line[0] == '#')
      continue;
    std::istringstream row(line);
    std::string name, list;
    float scale;
    unsigned alignment;
    int w, h, pw, ph;
    row >> name >> scale >> alignment >> list >> w >> h >> pw >> ph;
    std::vector<remotekit::protocol::PackItem> items;
    if (list != "-") {
      std::istringstream parts(list);
      std::string item;
      while (std::getline(parts, item, ',')) {
        auto x = item.find('x');
        items.push_back({static_cast<std::uint64_t>(items.size() + 1), std::stoi(item.substr(0, x)),
                         std::stoi(item.substr(x + 1)), 1});
      }
    }
    auto plan = remotekit::protocol::PlanAtlas(items, scale, alignment);
    if ((w == 0) != (!plan) || (plan && (plan->width != w || plan->height != h ||
                                         plan->physical.width != static_cast<unsigned>(pw) ||
                                         plan->physical.height != static_cast<unsigned>(ph)))) {
      std::cerr << name << " mismatch";
      if (plan)
        std::cerr << " " << plan->width << " " << plan->height << " " << plan->physical.width << " "
                  << plan->physical.height;
      std::cerr << "\n";
      return 3;
    }
    ++count;
  }
  auto wide = remotekit::protocol::PlanAtlas({{1, 4096, 600, 1}, {2, 4096, 600, 1}}, 1, 16);
  auto tall = remotekit::protocol::PlanAtlas({{1, 600, 4096, 1}, {2, 600, 4096, 1}}, 1, 16);
  if (!wide || !tall ||
      remotekit::protocol::AtlasAllocationDimensions(std::max(wide->width, tall->width),
                                                     std::max(wide->height, tall->height), 1, 16))
    return 4;
  if (remotekit::protocol::PageViewportHeight(900, 1000) != 120 ||
      remotekit::protocol::PageViewportHeight(80, 50) != 80 ||
      remotekit::protocol::PageViewportHeight(900, 400) != 500)
    return 5;
  std::vector<remotekit::protocol::PackItem> stable{{1, 1200, 900, 1}, {2, 800, 1200, 1}};
  const auto closed = remotekit::protocol::PlanAtlas(stable, 1.25f, 16);
  for (int occlusion : {0, 100, 400, 780}) {
    const int page_height = remotekit::protocol::PageViewportHeight(900, occlusion);
    const auto open = remotekit::protocol::PlanAtlas(stable, 1.25f, 16);
    if (!closed || !open || page_height < 120 || closed->width != open->width ||
        closed->height != open->height || closed->scale != open->scale ||
        closed->physical.width != open->physical.width ||
        closed->physical.height != open->physical.height)
      return 6;
  }
  std::cout << count << " shared atlas fixtures passed\n";
}
