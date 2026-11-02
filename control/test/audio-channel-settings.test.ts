import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store';
import { Control } from '../server/control';

const endpoint={async request(method:string){if(method==='session.snapshot')return{running:false,views:[]};return{accepted:true,applied:false};}};
test('audio output channels default on and persist the complete shared pair atomically',async()=>{
  const store=new Store(':memory:'),control=new Control(store,endpoint);
  try{
    const account=await store.register('audio-settings','password123'),tenant=account.tenantId;
    await control.attachViewer(tenant,'viewer',()=>{});
    assert.deepEqual(store.workspace(tenant).settings.audioChannels,{left:true,right:true});
    for(const left of [false,true])for(const right of [false,true]){
      const result=await control.viewerRequest(tenant,'viewer','action',{type:'settings.update',settings:{audioChannels:{left,right}}});
      assert.deepEqual(result.state.workspace.settings.audioChannels,{left,right});
      assert.deepEqual(control.productState(tenant).workspace.settings.audioChannels,{left,right});
      assert.deepEqual(store.workspace(tenant).settings.audioChannels,{left,right});
    }
    for(const channels of [{left:false},{right:false},{left:false,right:'yes'},{left:true,right:true,muted:false},null]){
      await assert.rejects(control.viewerRequest(tenant,'viewer','action',{type:'settings.update',settings:{audioChannels:channels}}),/同时提供/);
      assert.deepEqual(store.workspace(tenant).settings.audioChannels,{left:true,right:true});
    }
    await control.attachViewer(tenant,'replacement',()=>{});
    assert.deepEqual(control.productState(tenant).workspace.settings.audioChannels,{left:true,right:true});
    await assert.rejects(control.viewerRequest(tenant,'viewer','action',{type:'settings.update',settings:{audioChannels:{left:false,right:false}}}),/接管/);
  }finally{store.db.close();}
});
test('pre-audio settings migrate with both outputs on and failed persistence does not change confirmed channels',async()=>{
  const store=new Store(':memory:'),control=new Control(store,endpoint);
  try{
    const {tenantId:tenant}=await store.register('audio-migrate','password123');
    store.db.prepare('UPDATE user_settings SET data=? WHERE tenant=?').run(JSON.stringify({qualityPreference:'auto',clientScaleOverride:null,memorySaverEnabled:true,showStats:false}),tenant);
    assert.deepEqual(store.workspace(tenant).settings.audioChannels,{left:true,right:true});
    await control.attachViewer(tenant,'viewer',()=>{});
    const original=store.saveWorkspace.bind(store);store.saveWorkspace=()=>{throw Error('sqlite fault');};
    await assert.rejects(control.viewerRequest(tenant,'viewer','action',{type:'settings.update',settings:{audioChannels:{left:false,right:false}}}),/sqlite fault/);
    store.saveWorkspace=original;
    assert.deepEqual(control.productState(tenant).workspace.settings.audioChannels,{left:true,right:true});
  }finally{store.db.close();}
});
