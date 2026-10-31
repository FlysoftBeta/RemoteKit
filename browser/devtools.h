#ifndef REMOTEKIT_BROWSER_DEVTOOLS_H_
#define REMOTEKIT_BROWSER_DEVTOOLS_H_

#include "base/files/file_path.h"

namespace remotekit::browser {

void StartDevTools(const base::FilePath& active_port_dir);
void StopDevTools();

}  // namespace remotekit::browser

#endif  // REMOTEKIT_BROWSER_DEVTOOLS_H_
