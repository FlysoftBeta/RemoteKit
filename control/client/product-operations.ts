import type { ProductState, ProductAction, ProductOperation, OperationReceipt } from '../shared/product';
/** Product actions return execution receipts, never an authoritative workspace. */
export type ProductActionHandler = (action: ProductAction) => Promise<OperationReceipt>;
export function requireAcceptedReceipt(receipt: OperationReceipt): OperationReceipt {
 if (receipt.status === 'rejected' || receipt.status === 'expired')
  throw new Error(receipt.error ?? '操作被拒绝');
 return receipt;
}
export interface PendingOperation extends ProductOperation { receipt?:OperationReceipt }
/** Snapshots are the only product authority; projections live for this page only. */
export function projectOperations(state:ProductState|null, pending:PendingOperation[]):ProductState|null {
 if(!state)return null;const next=JSON.parse(JSON.stringify(state)) as ProductState,w=next.workspace;
 for(const operation of pending) {
  const a=operation.action,id='pending-'+operation.operationId;
  if(operation.receipt && ['rejected','expired'].includes(operation.receipt.status))continue;
  if(operation.receipt && ['committed','unknown'].includes(operation.receipt.status) && (operation.receipt.revision??Infinity)<=w.revision)continue;
  switch(a.type) {
   case 'window.create': w.windows.push({id,activeTabId:id+'-tab',weight:1});w.tabs.push({id:id+'-tab',windowId:id,webviewId:'',kind:'start',title:'新窗口（待确认）',url:''});w.activeWindowId=id;break;
   case 'tab.create': {const window=w.windows.find(x=>x.id===a.windowId);if(window){w.tabs.push({id,windowId:window.id,webviewId:'',kind:'start',title:'新标签页（待确认）',url:''});window.activeTabId=id;w.activeWindowId=window.id;}break;}
   case 'window.activate':w.activeWindowId=a.windowId;break;
   case 'tab.activate':{const tab=w.tabs.find(t=>t.id===a.tabId);if(tab){w.activeWindowId=tab.windowId;w.windows.find(x=>x.id===tab.windowId)!.activeTabId=tab.id;}break;}
   case 'tab.navigate':{const tab=w.tabs.find(t=>t.id===a.tabId);if(tab){tab.kind='remote';tab.pendingUrl=a.url;tab.loading=true;}break;}
   case 'tab.close':{const tab=w.tabs.find(t=>t.id===a.tabId);if(tab)tab.title=tab.title.replace(/（待确认）$/,'')+'（待确认）';break;}
   case 'window.close':for(const tab of w.tabs.filter(t=>t.windowId===a.windowId))tab.title=tab.title.replace(/（待确认）$/,'')+'（待确认）';break;
  }
 }return next;
}
export function snapshotNewer(next:ProductState,previous:ProductState|null) { if(typeof next.serverIncarnation!=='string' || !next.serverIncarnation || !Number.isSafeInteger(next.snapshotSequence) || next.snapshotSequence!<1)return false;return !previous || next.serverIncarnation!==previous.serverIncarnation || (next.snapshotSequence??0)>(previous.snapshotSequence??-1); }

export function operationId():string { if(typeof crypto.randomUUID==='function')return crypto.randomUUID();const bytes=crypto.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;const hex=Array.from(bytes,value=>value.toString(16).padStart(2,'0')).join('');return hex.slice(0,8)+'-'+hex.slice(8,12)+'-'+hex.slice(12,16)+'-'+hex.slice(16,20)+'-'+hex.slice(20); }
