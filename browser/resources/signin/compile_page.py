import pathlib
import sys

source, destination = map(pathlib.Path, sys.argv[1:])
html = source.read_text(encoding='utf-8')
destination.parent.mkdir(parents=True, exist_ok=True)
destination.write_text(
    '// Generated from changyan.html by compile_page.py.\n#pragma once\ninline constexpr char kChangyanPage[] = R"rkpage(' + html + ')rkpage";\n',
    encoding='utf-8',
)
