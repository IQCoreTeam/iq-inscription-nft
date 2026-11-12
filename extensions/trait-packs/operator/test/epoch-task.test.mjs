import{test}from'node:test';import assert from'node:assert/strict';import{nextEpochTask}from'../epoch-task.mjs';
const state=()=>({pool:{activeEpoch:0,epochCount:1,retired:false,definitions:[{remaining:80}]},epoch:{pool:'pool',id:0,status:1,ticketCount:1,cursor:0,tickets:[{claimMask:0,refunded:false}],closeSlot:100,deadlineSlot:120},slot:10,providerStatus:'pending',saleDemand:false});
test('bounded epoch decisions resume from chain instead of process memory',()=>{const s=state();assert.equal(nextEpochTask(s),null);s.slot=100;assert.deepEqual(nextEpochTask(s),{kind:'freeze'});s.epoch.status=2;assert.deepEqual(nextEpochTask(s),{kind:'request'});s.epoch.status=3;assert.equal(nextEpochTask(s),null);s.providerStatus='fulfilled';assert.deepEqual(nextEpochTask(s),{kind:'capture'});s.epoch.status=7;assert.deepEqual(nextEpochTask(s),{kind:'allocate',limit:8,cursor:0});s.epoch.status=4;for(let pull=0;pull<4;pull++){assert.deepEqual(nextEpochTask(structuredClone(s)),{kind:'claim',ticket:0,pull});s.epoch.tickets[0].claimMask|=1<<pull;}assert.deepEqual(nextEpochTask(s),{kind:'payout'});s.epoch.status=6;s.pool.definitions[0].remaining=0;assert.equal(nextEpochTask(s),null);});
test('timeouts never replace fulfilled or unknown entropy with a refund',()=>{const s=state();s.slot=121;s.epoch.status=3;s.providerStatus='unknown';assert.equal(nextEpochTask(s),null);s.providerStatus='fulfilled';assert.deepEqual(nextEpochTask(s),{kind:'capture'});s.providerStatus='pending';assert.deepEqual(nextEpochTask(s),{kind:'void'});s.epoch.status=5;assert.deepEqual(nextEpochTask(s),{kind:'refund',ticket:0});s.epoch.tickets[0].refunded=true;s.pool.retired=true;assert.equal(nextEpochTask(s),null);});

test('settled and fully refunded epochs reopen while stock remains, with a fresh window',()=>{
 const s=state();s.epoch.status=6;assert.equal(nextEpochTask(s),null);s.saleDemand=true;assert.deepEqual(nextEpochTask(s),{kind:'open'});s.epoch.status=5;s.epoch.tickets[0].refunded=true;assert.deepEqual(nextEpochTask(s),{kind:'open'});
 s.epoch.tickets=[];s.epoch.ticketCount=0;assert.deepEqual(nextEpochTask(s),{kind:'open'});
 s.epoch={...s.epoch,id:1,status:1,closeSlot:200};s.pool.activeEpoch=1;s.pool.epochCount=2;s.slot=150;assert.equal(nextEpochTask(s),null);
 s.epoch.status=6;s.pool.retired=true;assert.equal(nextEpochTask(s),null);
});

test('allocation resumes with a distinct confirmed prefix for more than eight tickets',()=>{
 const s=state();s.epoch.status=7;s.epoch.ticketCount=9;s.epoch.tickets=Array.from({length:9},()=>({claimMask:0,refunded:false}));assert.deepEqual(nextEpochTask(s),{kind:'allocate',limit:8,cursor:0});s.epoch.cursor=8;assert.deepEqual(nextEpochTask(s),{kind:'allocate',limit:8,cursor:8});s.epoch.cursor=9;assert.throws(()=>nextEpochTask(s),/allocation cursor/);
});

test('recorded requester surplus is recovered once provider state permits it before advancing',()=>{
 const s=state();s.epoch.requested=true;s.epoch.status=7;s.requesterLamports=1000;assert.deepEqual(nextEpochTask(s),{kind:'sweep',balance:1000,slot:s.slot});s.requesterLamports=0;assert.equal(nextEpochTask(s).kind,'allocate');s.epoch.status=5;s.requesterLamports=2000;assert.equal(nextEpochTask(s).kind,'sweep');s.epoch.status=3;assert.equal(nextEpochTask(s),null);
});
