#!/usr/bin/env python3
"""Run real D3D11 hardware encoding smoke and save reproducible evidence."""
import argparse,datetime,hashlib,json,subprocess,time
from pathlib import Path
from h264_sps import inspect_sps,check_bt709_limited
ROOT=Path(__file__).resolve().parents[1]
def main():
 p=argparse.ArgumentParser(description=__doc__)
 p.add_argument('--executable',type=Path,default=ROOT/'build/endpoint-package/endpoint/endpoint_encoder_smoke.exe')
 p.add_argument('--codec',choices=['qsv','nvenc'],default='qsv')
 p.add_argument('--depth',type=int,default=4)
 p.add_argument('--width',type=int,default=1928)
 p.add_argument('--height',type=int,default=1088)
 p.add_argument('--level',type=int,default=42)
 p.add_argument('--output',type=Path,default=ROOT/'develop/tmp/encoding-smoke')
 a=p.parse_args();destination=a.output/str(time.time_ns());destination.mkdir(parents=True)
 command=[str(a.executable.resolve()),a.codec,str(a.depth),'steps',str(a.width),str(a.height),str(a.level)]
 timed_out=False
 try:completed=subprocess.run(command,cwd=destination,capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=45)
 except subprocess.TimeoutExpired as error:
  timed_out=True
  decode=lambda data:data.decode('utf-8',errors='replace') if isinstance(data,bytes) else (data or '')
  completed=subprocess.CompletedProcess(command,124,decode(error.stdout),decode(error.stderr))
 (destination/'stdout.log').write_text(completed.stdout,encoding='utf-8')
 (destination/'stderr.log').write_text(completed.stderr,encoding='utf-8')
 gpu=subprocess.run(['powershell.exe','-NoProfile','-NonInteractive','-Command',
   '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion,PNPDeviceID | ConvertTo-Json -Compress'],capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=15)
 build={}
 cache=a.executable.resolve().parent.parent/'CMakeCache.txt'
 if cache.is_file():
  for line in cache.read_text(encoding='utf-8',errors='replace').splitlines():
   if '=' not in line or ':' not in line:continue
   key=line.split(':',1)[0]
   if key in ['CMAKE_BUILD_TYPE','CMAKE_CXX_COMPILER','CMAKE_CXX_FLAGS_RELEASE','CMAKE_MSVC_RUNTIME_LIBRARY']:
    build[key]=line.split('=',1)[1]
 result={'build':build,'utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'command':command,
   'exitCode':completed.returncode,'timedOut':timed_out,'executableSha256':hashlib.sha256(a.executable.read_bytes()).hexdigest(),
   'gpu':json.loads(gpu.stdout) if gpu.returncode==0 else None,'hardwareOnly':True,
   'scope':'D3D11 VideoProcessor + real asynchronous hardware encoder; no browser/network/client measurement'}
 if completed.returncode==0:
  try:
   result['measurement']=json.loads(completed.stdout.strip().splitlines()[-1])
   result['sps']=inspect_sps(destination/'hardware-smoke.h264');check_bt709_limited(result['sps'])
   for record in result['sps']['unique']:
    if record['profileIdc']!=66 or record['levelIdc']>a.level or (record['width'],record['height'])!=(a.width,a.height):
     raise ValueError('SPS exceeds requested profile/level or changes visible dimensions: '+json.dumps(record))
  except Exception as error:
   result['inspectionError']=str(error);completed.returncode=3;result['exitCode']=3
 (destination/'result.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
 print(json.dumps({'evidence':str(destination),**result}))
 raise SystemExit(completed.returncode)
if __name__=='__main__':main()
