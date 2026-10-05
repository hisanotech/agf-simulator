import test from 'node:test';
import assert from 'node:assert/strict';
import {loadLocalMetricProfile} from '../src/ui/metric-profile.mjs';
import {syntheticMetricLayout} from '../examples/synthetic-metric-layout.mjs';

test('published and remote origins never request private geometry',async()=>{
  for(const hostname of ['example.test','192.0.2.1','localhost.example.test']){
    const result=await loadLocalMetricProfile({hostname,fetchProfile(){throw new Error('must not fetch');}});
    assert.equal(result.profile,null);assert.equal(result.state,'public');
  }
});
test('loopback loader accepts only explicit valid mm model inputs and uses no-store',async()=>{
  for(const hostname of ['localhost','127.0.0.1','[::1]']){
    let request;
    const result=await loadLocalMetricProfile({hostname,fetchProfile:async(path,options)=>{
      request={path,options};return {ok:true,json:async()=>structuredClone(syntheticMetricLayout)};
    }});
    assert.deepEqual(request,{path:'private/metric-layout-profile.json',options:{cache:'no-store'}});
    assert.deepEqual(result.profile,syntheticMetricLayout);assert.equal(result.state,'private');
  }
});
test('missing private profile falls back explicitly; corrupt or failed profile is reported',async()=>{
  assert.equal((await loadLocalMetricProfile({hostname:'localhost',fetchProfile:async()=>({status:404})})).state,'missing');
  await assert.rejects(loadLocalMetricProfile({hostname:'localhost',fetchProfile:async()=>({ok:false,status:500})}),/500/);
  await assert.rejects(loadLocalMetricProfile({hostname:'localhost',fetchProfile:async()=>({ok:true,json:async()=>({})})}),/metric layout/);
});
