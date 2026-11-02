import test from 'node:test';
import assert from 'node:assert/strict';
import { cameraFormat, acceptsFile, mergeSelection, combineSelection, validateSelection } from '../client/file-selection';
import { foregroundRequest } from '../client/foreground-request';
import type { FileRequest, ProductState } from '../shared/product';
const request:FileRequest={id:'opaque',tabId:'a',windowId:'w',origin:'https://example.test',multiple:false,accept:['.JPG','image/png'],state:'pending',limits:{maxFiles:3,maxFileBytes:100,maxBatchBytes:150,sessionBytes:1000}};
test('file accept/multiple/limits and camera format follow request',()=>{
  assert.equal(cameraFormat(['application/pdf']),null);assert.equal(cameraFormat(['image/*']),'image/jpeg');assert.equal(cameraFormat(['.png']),'image/png');
  assert.ok(acceptsFile({name:'hello.JPG',type:''},request.accept));
  const a=new File(['data'],'a.jpg',{type:'image/jpeg',lastModified:1}),b=new File(['data'],'b.png',{type:'image/png',lastModified:1});
  assert.equal(validateSelection([a],request),'');assert.match(validateSelection([a,b],request),/数量/);
  assert.equal(mergeSelection([a],[a,b],true).length,2);assert.deepEqual(mergeSelection([a],[b],false),[b]);
  assert.deepEqual(combineSelection([a],[],false),[a]);assert.deepEqual(combineSelection([a],[b],false),[b]);
  assert.match(validateSelection([new File([new Uint8Array(101)],'large.jpg')],request),/单个/);
});
test('one foreground modal uses active visible window; background requests wait',()=>{
  const state={workspace:{layoutMode:'side-by-side',activeWindowId:'w2',windows:[{id:'w1',activeTabId:'a'},{id:'w2',activeTabId:'b'}]},pageDialogs:[{id:'page',tabId:'a'}],fileRequests:[{...request,id:'file',tabId:'b'}]} as unknown as ProductState;
  assert.deepEqual(foregroundRequest(state,1440),{kind:'file',id:'file'});
  state.fileRequests=[];assert.deepEqual(foregroundRequest(state,1440),{kind:'page',id:'page'});
  assert.equal(foregroundRequest(state,390),null);
});
