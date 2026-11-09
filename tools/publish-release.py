#!/usr/bin/env python3
"""Pack and publish encrypted Control releases through the GitHub CLI."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
from urllib.parse import unquote, urlparse

from release_payload import digest, write_payload

ROOT = Path(__file__).resolve().parents[1]


def gh(*arguments):
    return subprocess.run(
        ['gh', *map(str, arguments)], check=True, capture_output=True,
        text=True, encoding='utf-8', errors='replace',
    ).stdout


def retry_upload(arguments):
    for attempt in range(8):
        try:
            return gh(*arguments)
        except subprocess.CalledProcessError:
            if attempt == 7:
                raise
            time.sleep(min(60, 5 * 2 ** attempt))


def upload_assets(repo, tag, files, existing, dry_run=False):
    sizes = {asset['name']: asset['size'] for asset in existing if asset.get('state') == 'uploaded'}
    for file in files:
        size = file.stat().st_size
        if sizes.get(file.name) == size:
            print(f'Skip {file.name} ({size} bytes already uploaded)', flush=True)
            continue
        print(f'Upload {file.name} ({size} bytes)', flush=True)
        if not dry_run:
            retry_upload(['release', 'upload', tag, str(file), '--repo', repo, '--clobber'])


def should_include_full(manifests, patch_size, force=False):
    if force:
        return True
    total = patch_size
    for manifest in manifests:
        if 'full' in manifest:
            return total > manifest['full']['size']
        if 'patch' not in manifest:
            return True
        total += manifest['patch']['asset']['size']
    return True


def latest_release(repo):
    try:
        return json.loads(gh('api', f'repos/{repo}/releases/latest'))
    except subprocess.CalledProcessError as error:
        if 'HTTP 404' in (error.stderr or ''):
            return None
        raise


def draft_release(repo, build_id):
    pages = json.loads(gh('api', '--paginate', '--slurp', f'repos/{repo}/releases?per_page=100'))
    matches = [release for page in pages for release in page
               if release['draft'] and build_id in (release.get('body') or '').split()]
    if len(matches) > 1:
        raise RuntimeError('Multiple draft releases name this buildId')
    return matches[0] if matches else None


class Publisher:
    def __init__(self, args):
        self.args = args
        self.cache = args.cache.resolve()
        self.package = args.package.resolve()
        self.tool = args.tool.resolve()
        self.key = args.key.resolve()
        self.manifests = {}

    def invoke(self, command, **options):
        arguments = [str(self.tool), command, '--key=' + str(self.key)]
        arguments.extend('--' + name.replace('_', '-') + '=' + str(value)
                         for name, value in options.items() if value is not None and value is not True)
        arguments.extend('--' + name.replace('_', '-')
                         for name, value in options.items() if value is True)
        result = subprocess.run(arguments, check=True, capture_output=True,
                                text=True, encoding='utf-8', errors='replace')
        return json.loads(result.stdout)

    def inspect(self, url):
        if url not in self.manifests:
            parsed = urlparse(url)
            match = re.fullmatch(r'/([^/]+/[^/]+)/releases/download/([^/]+)/control\.manifest', parsed.path)
            if parsed.scheme != 'https' or parsed.netloc != 'github.com' or not match:
                raise ValueError('Expected a GitHub release manifest URL')
            directory = self.cache / 'manifests' / hashlib.sha256(url.encode()).hexdigest()
            directory.mkdir(parents=True, exist_ok=True)
            file = directory / 'control.manifest'
            gh('release', 'download', unquote(match[2]), '--repo', match[1],
               '--pattern', 'control.manifest', '--output', file, '--clobber')
            self.manifests[url] = self.invoke('inspect', manifest=file)
        return self.manifests[url]

    def history(self, url):
        seen = set()
        for _ in range(64):
            manifest = self.inspect(url)
            if manifest['buildId'] in seen:
                return
            seen.add(manifest['buildId'])
            yield manifest
            if 'full' in manifest or 'patch' not in manifest:
                return
            url = manifest['patch']['manifest']
            # A broken chain ends the history; hosts behind it need a full, which the caller adds.
            try:
                following = self.inspect(url)
            except (subprocess.CalledProcessError, ValueError):
                return
            if following['buildId'] != manifest['patch']['from']:
                return

    def base_payload(self, previous, previous_url):
        if previous is None:
            return None
        base = self.cache / 'payloads' / (previous['buildId'] + '.tar')
        expected = previous['payload']

        def matches():
            return (base.is_file() and base.stat().st_size == expected['size']
                    and digest(base) == expected['sha256'])

        if not matches():
            self.invoke('fetch', manifest=previous_url, out=base)
        if not matches():
            raise RuntimeError('Fetched base payload does not match the previous manifest')
        return base

    def run(self):
        build_id = json.loads((self.package / 'build.json').read_text(encoding='utf-8'))['buildId']
        if not re.fullmatch('[0-9a-f]{64}', build_id):
            raise ValueError('Invalid package buildId')
        provenance = json.loads((self.package / 'manifest.json').read_text(encoding='utf-8'))
        commit = provenance['source']['commit']
        if provenance['buildId'] != build_id or not re.fullmatch('[0-9a-f]{40}', commit):
            raise ValueError('Invalid package provenance')
        try:
            gh('api', f'repos/{self.args.repo}/commits/{commit}')
        except subprocess.CalledProcessError as error:
            raise RuntimeError(f'Source commit {commit} is not on GitHub; push it first') from error
        payload = self.cache / 'payloads' / (build_id + '.tar')
        metadata = write_payload(self.package, payload)
        latest = latest_release(self.args.repo)
        previous_url = (f'https://github.com/{self.args.repo}/releases/download/'
                        f'{latest["tag_name"]}/control.manifest') if latest else None
        previous = self.inspect(previous_url) if previous_url else None
        if previous and previous['buildId'] == build_id:
            print('already published', flush=True)
            return
        draft = draft_release(self.args.repo, build_id)
        output = self.cache / 'out' / build_id
        state_file = output.with_suffix('.json')
        output.parent.mkdir(parents=True, exist_ok=True)
        if output.exists():
            state = json.loads(state_file.read_text(encoding='utf-8'))
            if state['repo'] != self.args.repo or state['payload'] != metadata:
                raise RuntimeError('Cached publication does not match this package/repository')
            tag = state['tag']
            if draft and draft['tag_name'] != tag:
                raise RuntimeError('Cached publication does not match the existing draft')
            if self.args.full and not state['full']:
                raise RuntimeError('Cached publication has no full asset; resume without --full')
        else:
            if draft:
                raise RuntimeError('Draft exists but its packed assets are missing from the cache')
            tag = 'control-' + datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S') + '-' + build_id[:8]
            base = self.base_payload(previous, previous_url)
            options = dict(payload=payload, build=build_id,
                           url_prefix=f'https://github.com/{self.args.repo}/releases/download/{tag}/',
                           base=base, base_build=previous['buildId'] if previous else None,
                           base_manifest=previous_url)
            with tempfile.TemporaryDirectory(dir=output.parent) as temporary:
                packed = Path(temporary) / 'packed'
                full = self.args.full or previous is None
                summary = self.invoke('pack', out=packed, full=True if full else None, **options)
                if not full:
                    upload = json.loads((packed / 'upload.json').read_text(encoding='utf-8'))
                    # AAD tags add 16 bytes per encrypted slice.
                    patch_size = sum(item['size'] - 16 for item in upload
                                     if item['name'].startswith('control-patch.'))
                    full = should_include_full(self.history(previous_url), patch_size)
                    if full:
                        packed = Path(temporary) / 'packed-full'
                        summary = self.invoke('pack', out=packed, full=True, **options)
                state = {'repo': self.args.repo, 'tag': tag, 'payload': metadata, 'full': full,
                     'summary': summary}
                state_file.write_text(json.dumps(state, indent=2) + '\n', encoding='utf-8')
                packed.rename(output)
        uploads = json.loads((output / 'upload.json').read_text(encoding='utf-8'))
        files = []
        for item in uploads:
            name = item['name']
            if Path(name).name != name or '/' in name or '\\' in name:
                raise ValueError('Invalid upload filename')
            file = output / name
            if file.stat().st_size != item['size']:
                raise ValueError('Cached upload size mismatch: ' + name)
            files.append(file)
        if not files or files[-1].name != 'control.manifest':
            raise ValueError('upload.json must place control.manifest last')
        files.extend(self.package / 'bin' / name
                     for name in ('remotekit_control.exe', 'remotekit_node.exe'))
        notes = (f'buildId: {build_id}\ncommit: {commit}\npayload: {metadata["size"]} bytes\n'
                 + '\n'.join(f'{file.name}: {file.stat().st_size} bytes' for file in files))
        if not draft:
            print(f'Create draft {tag} at {commit}', flush=True)
            if not self.args.dry_run:
                gh('release', 'create', tag, '--repo', self.args.repo, '--draft', '--target', commit,
                   '--title', 'Control ' + build_id[:12], '--notes', notes)
        upload_assets(self.args.repo, tag, files, draft['assets'] if draft else [], self.args.dry_run)
        print(f'Publish {tag} as latest', flush=True)
        if not self.args.dry_run:
            gh('release', 'edit', tag, '--repo', self.args.repo, '--draft=false', '--latest')
        print(f'https://github.com/{self.args.repo}/releases/latest/download/control.manifest', flush=True)


def main(arguments=None):
    cache = Path(os.environ.get('LOCALAPPDATA', Path.home())) / 'RemoteKit/release'
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--package', type=Path, required=True)
    parser.add_argument('--repo', default='FlysoftBeta/RemoteKit')
    parser.add_argument('--key', type=Path, default=cache / 'release.key')
    parser.add_argument('--cache', type=Path, default=cache)
    parser.add_argument('--full', action='store_true')
    parser.add_argument('--tool', type=Path,
                        default=ROOT / 'build/endpoint-package/endpoint/remotekit_release.exe')
    parser.add_argument('--dry-run', action='store_true')
    Publisher(parser.parse_args(arguments)).run()


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f'error: {error}', file=sys.stderr)
        sys.exit(1)
