#include "remotekit/atlas_plan.hpp"
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
    std::vector<remotekit::PackItem> items;
    if (list != "-") {
      std::istringstream parts(list);
      std::string item;
      while (std::getline(parts, item, ',')) {
        auto x = item.find('x');
        items.push_back({static_cast<remotekit::WebViewId>(items.size() + 1),
                         std::stoi(item.substr(0, x)), std::stoi(item.substr(x + 1)), 1});
      }
    }
    auto plan = remotekit::PlanAtlas(items, scale, alignment);
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
  auto wide = remotekit::PlanAtlas({{1, 4096, 600, 1}, {2, 4096, 600, 1}}, 1, 16);
  auto tall = remotekit::PlanAtlas({{1, 600, 4096, 1}, {2, 600, 4096, 1}}, 1, 16);
  if (!wide || !tall ||
      remotekit::AtlasAllocationDimensions(std::max(wide->width, tall->width),
                                           std::max(wide->height, tall->height), 1, 16))
    return 4;
  std::cout << count << " shared atlas fixtures passed\n";
}
