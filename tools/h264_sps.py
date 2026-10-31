#!/usr/bin/env python3
"""Inspect Annex-B H.264 SPS geometry and VUI color metadata without decoding pixels."""
import argparse,json,re
from pathlib import Path
class Bits:
 def __init__(self,data):self.data=data;self.position=0
 def read(self,count):
  if self.position+count>len(self.data)*8:raise ValueError('Truncated SPS')
  value=0
  for _ in range(count):
   value=(value<<1)|((self.data[self.position//8]>>(7-self.position%8))&1);self.position+=1
  return value
 def ue(self):
  zeros=0
  while not self.read(1):
   zeros+=1
   if zeros>31:raise ValueError('Invalid Exp-Golomb code')
  return (1<<zeros)-1+self.read(zeros)
 def se(self):
  value=self.ue();return (value+1)//2 if value&1 else -(value//2)
def skip_hrd(bits):
 count=bits.ue()+1
 if count>32:raise ValueError('Invalid HRD CPB count')
 bits.read(4);bits.read(4)
 for _ in range(count):bits.ue();bits.ue();bits.read(1)
 for _ in range(4):bits.read(5)
def parse_sps(nal):
 rbsp=bytearray();zeros=0
 for value in nal[1:]:
  if zeros>=2 and value==3:zeros=0;continue
  rbsp.append(value);zeros=zeros+1 if value==0 else 0
 bits=Bits(rbsp);profile=bits.read(8);constraints=bits.read(8);level=bits.read(8);bits.ue()
 chroma=1;separate=0
 if profile in [100,110,122,244,44,83,86,118,128,138,139,134,135]:
  chroma=bits.ue()
  if chroma==3:separate=bits.read(1)
  bits.ue();bits.ue();bits.read(1)
  if bits.read(1):
   for index in range(8 if chroma!=3 else 12):
    if not bits.read(1):continue
    last=next_scale=8
    for _ in range(16 if index<6 else 64):
     if next_scale:next_scale=(last+bits.se()+256)%256
     last=next_scale or last
 bits.ue();order=bits.ue()
 if order==0:bits.ue()
 elif order==1:
  bits.read(1);bits.se();bits.se()
  for _ in range(bits.ue()):bits.se()
 bits.ue();bits.read(1);width_mbs=bits.ue()+1;height_maps=bits.ue()+1
 frame_only=bits.read(1)
 if not frame_only:bits.read(1)
 bits.read(1);crop=[bits.ue() for _ in range(4)] if bits.read(1) else [0,0,0,0]
 chroma_array=0 if separate else chroma
 unit_x=1 if chroma_array in [0,3] else 2
 unit_y=(2-frame_only)*(2 if chroma_array==1 else 1)
 result={'profileIdc':profile,'constraintFlags':constraints,'levelIdc':level,
   'width':width_mbs*16-(crop[0]+crop[1])*unit_x,
   'height':height_maps*16*(2-frame_only)-(crop[2]+crop[3])*unit_y,
   'vuiPresent':bool(bits.read(1))}
 if result['vuiPresent']:
  if bits.read(1):
   if bits.read(8)==255:bits.read(16);bits.read(16)
  if bits.read(1):bits.read(1)
  result['videoSignalTypePresent']=bool(bits.read(1))
  if result['videoSignalTypePresent']:
   result['videoFormat']=bits.read(3);result['fullRange']=bool(bits.read(1))
   result['colourDescriptionPresent']=bool(bits.read(1))
   if result['colourDescriptionPresent']:
    result['colourPrimaries']=bits.read(8);result['transferCharacteristics']=bits.read(8);result['matrixCoefficients']=bits.read(8)
  if bits.read(1):bits.ue();bits.ue() # chroma sample location
  if bits.read(1):bits.read(32);bits.read(32);bits.read(1) # timing info
  result['nalHrdPresent']=bool(bits.read(1))
  if result['nalHrdPresent']:skip_hrd(bits)
  result['vclHrdPresent']=bool(bits.read(1))
  if result['vclHrdPresent']:skip_hrd(bits)
 return result
def inspect_sps(path):
 units=re.split(b'\x00\x00(?:\x00)?\x01',Path(path).read_bytes())
 records=[parse_sps(unit) for unit in units if unit and unit[0]&31==7]
 if not records:raise ValueError('No Annex-B SPS found')
 unique=list({json.dumps(record,sort_keys=True):record for record in records}.values())
 return {'spsCount':len(records),'unique':unique}
def check_bt709_limited(inspection):
 for record in inspection['unique']:
  if not (record.get('videoSignalTypePresent') and record.get('colourDescriptionPresent') and
     record.get('fullRange') is False and all(record.get(key)==1 for key in ['colourPrimaries','transferCharacteristics','matrixCoefficients'])):
   raise ValueError('SPS does not declare BT.709 limited-range: '+json.dumps(record))
if __name__=='__main__':
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('file',type=Path)
 parser.add_argument('--check-bt709-limited',action='store_true')
 parser.add_argument('--check-no-hrd',action='store_true');args=parser.parse_args()
 result=inspect_sps(args.file)
 if args.check_bt709_limited:check_bt709_limited(result)
 if args.check_no_hrd and any(record.get('nalHrdPresent') or record.get('vclHrdPresent') for record in result['unique']):raise ValueError('SPS declares HRD')
 print(json.dumps(result))
