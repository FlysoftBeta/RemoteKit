import importlib.util
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from contextlib import redirect_stderr, redirect_stdout
import io

TOOLS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOLS))
spec = importlib.util.spec_from_file_location('release_script', TOOLS / 'release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseArguments(unittest.TestCase):
    def test_publication_flags_require_publish(self):
        for flag in ('--full', '--transition', '--prerelease'):
            with self.subTest(flag=flag), patch.object(sys, 'argv', ['release.py', flag]), \
                 patch.object(release.subprocess, 'check_output') as status, \
                 redirect_stderr(io.StringIO()):
                with self.assertRaises((ValueError, SystemExit)):
                    release.main()
                status.assert_not_called()

    def test_transition_rejects_full_and_prerelease(self):
        for flag in ('--full', '--prerelease'):
            with self.subTest(flag=flag), \
                 patch.object(sys, 'argv', ['release.py', '--publish', '--transition', flag]), \
                 patch.object(release.subprocess, 'check_output') as status, \
                 redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit):
                    release.main()
                status.assert_not_called()

    def test_publication_mode_is_forwarded(self):
        for flags in (['--transition'], ['--prerelease'], ['--prerelease', '--full']):
            packager = SimpleNamespace(main=lambda args: {'directory': 'synthetic-package'})
            package_spec = SimpleNamespace(loader=SimpleNamespace(exec_module=lambda module: None))
            with self.subTest(flags=flags), \
                 patch.object(sys, 'argv', ['release.py', '--publish', *flags]), \
                 patch.object(release.subprocess, 'check_output', return_value=''), \
                 patch.object(release, 'resolve_node', return_value=Path('node.exe')), \
                 patch.object(release, 'run') as run, \
                 patch.object(release.importlib.util, 'spec_from_file_location', return_value=package_spec), \
                 patch.object(release.importlib.util, 'module_from_spec', return_value=packager), \
                 redirect_stdout(io.StringIO()):
                release.main()
            command = run.call_args.args[0]
            self.assertEqual(command[:4], [sys.executable, 'tools/publish-release.py',
                                          '--package', 'synthetic-package'])
            self.assertEqual(set(command[4:]), set(flags))


if __name__ == '__main__':
    unittest.main()
