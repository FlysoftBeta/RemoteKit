#!/usr/bin/env python3
"""Read existing streaming cases into tenant-level JSON and a compact layer table."""
import argparse,json,re
from pathlib import Path
from streaming_metrics import load_metrics
ROOT=Path(__file__).resolve().parents[1]
def load(path):
 try:return json.loads(path.read_text(encoding='utf-8'))
 except (OSError,ValueError):return None
def difference(values):
 values=[v for v in values if isinstance(v,(int,float))]
 return values[-1]-values[0] if len(values)>1 else None
def rtc_rate_samples(samples,field):
 values=[]
 for previous,current in zip(samples,samples[1:]):
  before=previous.get('rtc',{}).get(field);after=current.get('rtc',{}).get(field)
  elapsed=current.get('at',0)-previous.get('at',0)
  if before is not None and after is not None and elapsed>0:values.append((after-before)*1000/elapsed)
 return values

def bench_metrics(folder):
 records={}
 path=folder/'metrics/client-metrics.jsonl'
 if path.is_file():
  for record in load_metrics(path):
   value=record.get('metrics',{})
   if value.get('kind')=='streaming-benchmark':records[value['tenantIndex']]=value
 return records

def summarize(folder,summaries,metrics):
 log=(folder/'control.err').read_text(encoding='utf-8',errors='replace') if (folder/'control.err').exists() else ''
 pids=dict(re.findall(r'^session (\d+) browser pid (\d+)$',log,re.MULTILINE));rows=[]
 for record in summaries:
  index=record['tenantIndex'];m=metrics.get(index,{});receiver=record.get('receiver',{})
  endpoint=receiver.get('lastEndpoint',{});samples=m.get('rtcSamples',[]);last=samples[-1] if samples else {}
  views=m.get('actualLayout',{}).get('views',[]);session=str(views[0].get('session','')) if views else ''
  pid=pids.get(session);trace=next((b for b in record.get('browser',[]) if b.get('file','').startswith('browser-'+str(pid)+'-atlas-')),None)
  network=last.get('networkSimulation',{});down=network.get('downlink',{})
  host=record.get('hostLoad',{}).get('systemCpuPercent',{});presentation=receiver.get('presentation',{})
  costs=presentation.get('costsMs',{});latency=receiver.get('latency',{});encoded=presentation.get('encodedFrameBytes',{})
  sender_samples=[]
  for sample in samples:
   sender=sample.get('endpoint',{}).get('senderRtcStats')
   if isinstance(sender,dict) and sender.get('sampleTimeUs') is not None and (not sender_samples or sender_samples[-1]['sampleTimeUs']!=sender['sampleTimeUs']):sender_samples.append(sender)
  sender=sender_samples[-1] if sender_samples else {};outbound=sender.get('outbound',[])
  sent_bytes=lambda value:sum(item['bytesSent'] for item in value.get('outbound',[]) if 'bytesSent' in item) if any('bytesSent' in item for item in value.get('outbound',[])) else None
  byte_delta=difference([sent_bytes(value) for value in sender_samples])
  rtts=sorted(1000*value['selectedPair']['currentRoundTripTime'] for value in sender_samples if isinstance(value.get('selectedPair',{}).get('currentRoundTripTime'),(int,float)))
  outbound_sum=lambda value,key:sum(item[key] for item in value.get('outbound',[]) if key in item) if any(key in item for item in value.get('outbound',[])) else None
  packet_delta=difference([outbound_sum(value,'packetsSent') for value in sender_samples])
  send_delay_delta=difference([outbound_sum(value,'totalPacketSendDelay') for value in sender_samples])
  sender_seconds=(sender_samples[-1]['sampleTimeUs']-sender_samples[0]['sampleTimeUs'])/1e6 if len(sender_samples)>1 else None
  row={'case':folder.name,'caseBase':folder.name.removesuffix('-marker-visible'),'tenant':index,'session':session,'browserPid':pid,
   'sourceRafFps':record.get('source',{}).get('raf',{}).get('fps'),
   'captureCallbackFps':trace.get('capture_callback',{}).get('fps') if trace else None,
   'atlasPublishFps':trace.get('atlas_publish',{}).get('fps') if trace else None,
   'atlasCopyFps':receiver.get('atlasCopiesPerSecond'),'encodeFps':receiver.get('encodeCompletedPerSecond'),
   'decodeFps':receiver.get('framesDecodedPerSecond'),'paintFps':receiver.get('displayPaintFps'),
   'renderP50Ms':latency.get('p50'),'renderP95Ms':latency.get('p95'),'renderP99Ms':latency.get('p99'),
   'renderSampleCount':m.get('markerSampleCount'),'invalidMarkers':receiver.get('invalidMarkers'),
   'inputSampleCount':m.get('inputSampleCount'),'inputTimeoutCount':len(m.get('inputTimeouts',[])),
   'inputLatency':m.get('inputToObservedMs'),
   'encodedFrameBytesP95':encoded.get('p95'),'encodedFrameBytesMax':encoded.get('max'),
   'encodedFrameByteSamples':encoded.get('measured'),'encodedKeyframes':encoded.get('keyframes'),
   'encodeDropsPerSec':receiver.get('encodeDroppedPerSecond'),
   'receiverPliDelta':difference([s.get('rtc',{}).get('pliCount') for s in samples]),
   'receiverLostDelta':difference([s.get('rtc',{}).get('packetsLost') for s in samples]),
   'relayDroppedPacketsTotal':down.get('droppedPackets'),'relayMaxQueueBytesTotal':down.get('maximumQueueBytes'),
   'relayLateMaxMsTotal':down.get('maximumSchedulerLateMs'),
   'relayProcessAverageCoresTotal':network.get('processCpuSinceRelayCreation',{}).get('averageCores'),
   'cpuP50':host.get('p50'),'cpuP95':host.get('p95'),
   'visibility':sorted({x.get('value','unknown') for x in receiver.get('visibility',[])}),
   'senderAvailableOutgoingBitrate':sender.get('selectedPair',{}).get('availableOutgoingBitrate'),
   'senderBytesSentTotal':sent_bytes(sender),'senderBytesSentDelta':byte_delta,
   'senderVideoBitrateBps':8*byte_delta/sender_seconds if byte_delta is not None and sender_seconds and sender_seconds>0 else None,
   'senderSampleCount':len(sender_samples),'senderSampleWindowSeconds':sender_seconds,
   'senderRttMs':{'samples':rtts,'p50':rtts[round((len(rtts)-1)*.50)] if rtts else None,'p95':rtts[round((len(rtts)-1)*.95)] if rtts else None,'max':max(rtts) if rtts else None},
   'senderMeanPacketSendDelayMs':1000*send_delay_delta/packet_delta if send_delay_delta is not None and send_delay_delta>=0 and packet_delta and packet_delta>0 else None,
   'selectedLocalCandidate':sender.get('localCandidate'),'selectedRemoteCandidate':sender.get('remoteCandidate'),
   'senderQualityReason':outbound[0].get('qualityLimitationReason') if outbound else None,
   'jitterFieldsAvailable':last.get('jitterBufferFieldAvailability',{}),
   'markerReadbackP50Ms':costs.get('markerReadback',{}).get('p50'),'markerReadbackP95Ms':costs.get('markerReadback',{}).get('p95'),
   'videoCallbackP50Ms':costs.get('videoCallbackTotal',{}).get('p50'),'videoCallbackP95Ms':costs.get('videoCallbackTotal',{}).get('p95'),
   'fpsSecondDistribution':{'displayPaint':receiver.get('displayPerSecondFrames'),'authorized':receiver.get('authorizedPerSecondFrames'),
    'atlasCopy':[s.get('endpoint',{}).get('atlasCopyFps') for s in samples],
    'encode':[s.get('endpoint',{}).get('encodedFps') for s in samples],
    'decode':rtc_rate_samples(samples,'framesDecoded'),'source':record.get('source',{}).get('raf',{}).get('perSecondFrames'),
    'capture':None}}
  row['missingFields']=[key for key,value in row.items() if value is None]
  row['missingFields'] += ['fpsSecondDistribution.'+key for key,value in row['fpsSecondDistribution'].items() if value is None]
  row['missingFields'] += [key for key,available in row['jitterFieldsAvailable'].items() if not available]
  rows.append(row)
 return rows

def span(values):
 numbers=[float(x) for x in values if isinstance(x,(int,float))]
 if not numbers:return 'missing'
 lo,hi=min(numbers),max(numbers)
 return f'{lo:.1f}' if abs(hi-lo)<.05 else f'{lo:.1f}–{hi:.1f}'
def main():
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('cases',nargs='*',type=Path)
 parser.add_argument('--root',type=Path,default=ROOT/'develop/tmp');parser.add_argument('--output-dir',type=Path,default=ROOT/'develop/docs')
 args=parser.parse_args();folders=args.cases or sorted(args.root.glob('matrix-*'));selected={};skipped=[]
 for folder in folders:
  if not folder.exists():folder=args.root/folder
  summaries=load(folder/'summary.json')
  if not isinstance(summaries,list) or not summaries:continue
  metrics=bench_metrics(folder);expected=summaries[0].get('config',{}).get('tenants',len(summaries))
  if len(summaries)!=expected or len(metrics)<expected:skipped.append(str(folder));continue
  base=folder.name.removesuffix('-marker-visible')
  if base not in selected or folder.name.endswith('-marker-visible'):selected[base]=(folder,summaries,metrics)
 if not selected:parser.error('No complete case directories found')
 rows=[]
 for base in sorted(selected):rows.extend(summarize(*selected[base]))
 args.output_dir.mkdir(parents=True,exist_ok=True)
 output=args.output_dir/'matrix-layer-check.json';output.write_text(json.dumps(rows,indent=2),encoding='utf-8')
 lines=['# Streaming matrix layers','',
  '| case | n | source | capture | copy | encode | decode | paint | render p95 ms | CPU p50/p95 | keyframes | PLI/loss Δ | relay drop/maxKB |',
  '|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---|---|---|']
 for case in sorted({row['case'] for row in rows}):
  group=[r for r in rows if r['case']==case];fields=['sourceRafFps','captureCallbackFps','atlasCopyFps','encodeFps','decodeFps','paintFps','renderP95Ms']
  cells=[span([r[key] for r in group]) for key in fields]
  cpu=span([r['cpuP50'] for r in group])+'/'+span([r['cpuP95'] for r in group]);keys=span([r['encodedKeyframes'] for r in group])
  pli=span([r['receiverPliDelta'] for r in group]);loss=span([r['receiverLostDelta'] for r in group]);drop=span([r['relayDroppedPacketsTotal'] for r in group])
  queue=span([r['relayMaxQueueBytesTotal']/1024 if r['relayMaxQueueBytesTotal'] is not None else None for r in group])
  lines.append('| '+' | '.join([case,str(len(group)),*cells,cpu,keys,pli+'/'+loss,drop+'/'+queue])+' |')
 lines+=['','FPS ranges cover tenants, not confidence intervals. Marker-visible retakes replace matching original cases.',
  'Capture joins Session to browser PID using control.err, then selects its matching raw trace; its first-event +5..+25s window is not proven perfectly aligned with client measurement windows.',
  'Relay maxima/totals include warmup. CPU is whole-host aggregate; GPU utilization and per-process attribution are absent.',
  'Sender video bitrate uses sender bytes/time from the same SDK clock, never the client upload BWE. Missing fields remain null and are listed per row.',
  'Marker readback/callback costs, sample counts, visibility and per-second FPS observations are retained in JSON. Invalid/absent markers do not imply zero render latency.']
 (args.output_dir/'matrix-layer-check.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')
 print(json.dumps({'cases':len(selected),'tenantRows':len(rows),'json':str(output),'skippedIncomplete':skipped}))
if __name__=='__main__':main()
