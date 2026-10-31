#!/usr/bin/env python3
"""Fetch pinned, hash-verified endpoint hardware/media build dependencies."""
import hashlib
from pathlib import Path
import urllib.request
import zipfile
ROOT = Path(__file__).resolve().parents[1]
DEPENDENCIES = [
 ('json-LICENSE.MIT','https://raw.githubusercontent.com/nlohmann/json/v3.12.0/LICENSE.MIT','46a65cffd1ea955132d95a8dd921640714a8d6b537d2e4e482d31145ae95b603'),
 ('json.hpp','https://raw.githubusercontent.com/nlohmann/json/v3.12.0/single_include/nlohmann/json.hpp','aaf127c04cb31c406e5b04a63f1ae89369fccde6d8fa7cdda1ed4f32dfc5de63'),
 ('libvpl-v2.17.0.zip','https://github.com/intel/libvpl/archive/refs/tags/v2.17.0.zip','980d9f3f1dbecc7cbc28b0ff0c0647f925cbaf72844c85515b69b89e9603c35d'),
 ('nvEncodeAPI.h','https://raw.githubusercontent.com/FFmpeg/nv-codec-headers/n13.0.19.0/include/ffnvcodec/nvEncodeAPI.h','4fe4094541ef0f8a13249d97a8692dc5f835a6e9dd42eeadb3e2f7321d54dc7e'),
]
def main():
 destination=ROOT/'build/dependencies'
 destination.mkdir(parents=True,exist_ok=True)
 for name,url,expected in DEPENDENCIES:
  path=destination/name
  if not path.exists():
   temporary=path.with_suffix(path.suffix+'.download')
   urllib.request.urlretrieve(url,temporary)
   if hashlib.sha256(temporary.read_bytes()).hexdigest()!=expected:
    temporary.unlink()
    raise RuntimeError('Dependency SHA256 mismatch: '+name)
   temporary.replace(path)
  if hashlib.sha256(path.read_bytes()).hexdigest()!=expected:
   raise RuntimeError('Cached dependency SHA256 mismatch: '+str(path))
 source=destination/'libvpl-2.17.0'
 if not source.exists():
  with zipfile.ZipFile(destination/'libvpl-v2.17.0.zip') as archive:
   for member in archive.infolist():
    if not (destination/member.filename).resolve().is_relative_to(destination.resolve()):
     raise RuntimeError('Archive entry escapes dependency directory')
   archive.extractall(destination)
 print('Endpoint dependencies verified: libvpl 2.17.0, JSON 3.12.0, NVENC API 13.0')
if __name__=='__main__':main()
