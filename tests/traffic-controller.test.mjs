import test from 'node:test';
import assert from 'node:assert/strict';
import {createTrafficController} from '../src/core/traffic-controller.mjs';

const edge=(overrides={})=>({id:'E',lanes:[{id:'L1',direction:'both'}],
  lanePolicy:{laneCount:1,simultaneousPassing:'no-alternating'},occupancyResourceIds:[],...overrides});

test('one lane rejects simultaneous opposing entry and grants it after release',()=>{
  const traffic=createTrafficController([edge()]);
  assert.equal(traffic.tryEnter({agfId:'A1',edgeId:'E',traversal:'forward',requestOrder:1}).entered,true);
  const blocked=traffic.tryEnter({agfId:'A2',edgeId:'E',traversal:'reverse',requestOrder:2});
  assert.equal(blocked.entered,false);
  assert.deepEqual(blocked.blockers,['A1']);
  traffic.release('A1');
  assert.equal(traffic.tryEnter({agfId:'A2',edgeId:'E',traversal:'reverse',requestOrder:2}).entered,true);
});

test('two explicit lanes permit two vehicles but never exceed lane capacity',()=>{
  const traffic=createTrafficController([edge({lanes:[
    {id:'LF',direction:'forward'},{id:'LR',direction:'reverse'}
  ],lanePolicy:{laneCount:2,simultaneousPassing:'yes'}})]);
  assert.equal(traffic.tryEnter({agfId:'A1',edgeId:'E',traversal:'forward',requestOrder:1}).laneId,'LF');
  assert.equal(traffic.tryEnter({agfId:'A2',edgeId:'E',traversal:'reverse',requestOrder:2}).laneId,'LR');
  assert.equal(traffic.tryEnter({agfId:'A3',edgeId:'E',traversal:'forward',requestOrder:3}).entered,false);
});

test('two lanes do not override an alternating or controlled passing policy',()=>{
  for(const simultaneousPassing of ['no-alternating','controlled']){
    const traffic=createTrafficController([edge({lanes:[
      {id:'LF',direction:'forward'},{id:'LR',direction:'reverse'}
    ],lanePolicy:{laneCount:2,simultaneousPassing}})]);
    assert.equal(traffic.tryEnter({agfId:'A1',edgeId:'E',traversal:'forward'}).entered,true);
    assert.equal(traffic.tryEnter({agfId:'A2',edgeId:'E',traversal:'reverse'}).entered,false);
    assert.equal(traffic.snapshot().owners.LR,undefined);
    traffic.release('A1');
    assert.equal(traffic.tryEnter({agfId:'A2',edgeId:'E',traversal:'reverse'}).entered,true);
  }
});

test('a vehicle cannot acquire another segment before releasing its current resources',()=>{
  const traffic=createTrafficController([
    edge({id:'E1',lanes:[{id:'L1',direction:'both'}]}),
    edge({id:'E2',lanes:[{id:'L2',direction:'both'}]})
  ]);
  traffic.tryEnter({agfId:'A1',edgeId:'E1',traversal:'forward'});
  const saved=traffic.snapshot();
  assert.throws(()=>traffic.tryEnter({agfId:'A1',edgeId:'E2',traversal:'forward'}),/already holds/);
  assert.deepEqual(traffic.snapshot(),saved);
  traffic.release('A1');
  assert.deepEqual(traffic.snapshot().owners,{});
});

test('intersection resources are acquired atomically with a lane and released together',()=>{
  const traffic=createTrafficController([
    edge({id:'E1',lanes:[{id:'L1',direction:'both'}],occupancyResourceIds:['J1']}),
    edge({id:'E2',lanes:[{id:'L2',direction:'both'}],occupancyResourceIds:['J1']})
  ]);
  assert.equal(traffic.tryEnter({agfId:'A1',edgeId:'E1',traversal:'forward',requestOrder:1}).entered,true);
  assert.equal(traffic.tryEnter({agfId:'A2',edgeId:'E2',traversal:'forward',requestOrder:2}).entered,false);
  traffic.release('A1');
  assert.equal(traffic.tryEnter({agfId:'A2',edgeId:'E2',traversal:'forward',requestOrder:2}).entered,true);
});

test('wait-for cycles are detected without inventing an automatic recovery policy',()=>{
  const traffic=createTrafficController([
    edge({id:'E1',lanes:[{id:'L1',direction:'both'}]}),
    edge({id:'E2',lanes:[{id:'L2',direction:'both'}]})
  ]);
  traffic.tryEnter({agfId:'A1',edgeId:'E1',traversal:'forward',requestOrder:1});
  traffic.tryEnter({agfId:'A2',edgeId:'E2',traversal:'forward',requestOrder:2});
  traffic.waitFor('A1',['A2']);
  traffic.waitFor('A2',['A1']);
  assert.deepEqual(traffic.detectDeadlocks(),[['A1','A2']]);
  assert.equal(traffic.recoveryPolicy,'detect-only');
});