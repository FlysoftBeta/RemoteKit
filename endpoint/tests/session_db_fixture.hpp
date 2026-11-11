#pragma once
#include "files/file_library.hpp"
#include <stdexcept>
namespace remotekit::test {
struct LibraryDatabase {
  SessionDb database;
  explicit LibraryDatabase(const fs::path& root) : database(root / ".session") {
    auto opened = database.Open();
    if (!opened)
      throw std::runtime_error(opened.error().message);
  }
};
class LibraryFixture : private LibraryDatabase, public FileLibrary {
 public:
  LibraryFixture(fs::path root, objects::ObjectService& objects, std::string tenant)
      : LibraryDatabase(root), FileLibrary(root, objects, std::move(tenant), database.Library()) {}
  SessionDb& Database() { return database; }
};
}  // namespace remotekit::test
