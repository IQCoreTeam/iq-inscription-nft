import {test} from 'node:test';
import assert from 'node:assert/strict';
import {prepareRenderKit} from '../kit.mjs';
import {publishRenderKit} from '../publish.mjs';
import {fixture} from './fixtures.mjs';

const privateMarker='synthetic-unpublished-note';
async function advancedFixture(){
  const f=await fixture();
  const rectangle={left:0,top:0,width:16,height:16};
  f.input.config.description='Public collection description';
  f.input.config.groups[2].emitTrait=true;
  f.input.config.groups[2].assets[0].fixedAttributes=[{trait_type:'Style',value:'Synthetic'}];
  f.input.config.groups.push({name:'Hat',role:'overlay',emitTrait:false,assets:[
    {id:'hat-none',file:null,label:'None',weight:1},
    {id:'hat',file:'hair-a.png',label:'Hat',weight:1,registration:{source:{...rectangle},target:{...rectangle}},occlusion:{targetGroup:'Hair',maskFile:'hair-b.png'}}
  ]});
  f.input.items[0].sourceDna.push('hat-none');
  f.input.appearance.logoFile='hair-a.png';
  return f;
}
async function rejectsBeforeStorage(input,root){
  const calls={reads:0,writes:0};
  const context={gateway:'http://127.0.0.1:4560',owner:'11111111111111111111111111111111',expectedGenesis:'local-only',connection:{getGenesisHash:async()=>{calls.reads++;return 'local-only';}},saveCheckpoint:async()=>{},writeArtifact:async()=>{calls.writes++;throw Error('Unexpected storage write');},readArtifact:async()=>{calls.reads++;throw Error('Unexpected storage read');}};
  await assert.rejects(async()=>{
    const kit=await prepareRenderKit(input,root);
    await publishRenderKit(kit,root,context,{});
  },error=>{
    assert(!String(error.message).includes(privateMarker),'Validation errors must not echo imported private values');
    return /Unsupported field|Invalid/.test(error.message);
  });
  assert.deepEqual(calls,{reads:0,writes:0});
}

test('schema preserves consumed registration, mask and fixed-attribute fields',async()=>{
  const f=await advancedFixture();
  try{
    const kit=await prepareRenderKit(f.input,f.root);
    const hat=kit.config.groups[3].assets[1];
    assert.deepEqual(hat.registration.source,{left:0,top:0,width:16,height:16});
    assert.deepEqual(hat.occlusion,{targetGroup:'Hair',maskFile:'hair-b.png'});
    assert.deepEqual(kit.config.groups[2].assets[0].fixedAttributes,[{trait_type:'Style',value:'Synthetic'}]);
    assert.equal(kit.appearance.logoFile,'hair-a.png');
    assert.equal(kit.config.description,'Public collection description');
  }finally{await f.stop();}
});

test('unknown imported project fields at every publication level cause zero storage calls',async()=>{
  const f=await advancedFixture();
  const levels=[
    input=>input,
    input=>input.config,
    input=>input.config.canvas,
    input=>input.config.groups[0],
    input=>input.config.groups[0].assets[0],
    input=>input.config.groups[3].assets[1].registration,
    input=>input.config.groups[3].assets[1].registration.source,
    input=>input.config.groups[3].assets[1].registration.target,
    input=>input.config.groups[3].assets[1].occlusion,
    input=>input.config.groups[2].assets[0].fixedAttributes[0],
    input=>input.items[0],
    input=>input.definitions[0],
    input=>input.appearance,
  ];
  try{
    for(const select of levels){const input=structuredClone(f.input);select(input).privateProjectNote=privateMarker;await rejectsBeforeStorage(input,f.root);}
    const credential=structuredClone(f.input);credential.config.groups[2].assets[0].credential=privateMarker;await rejectsBeforeStorage(credential,f.root);
    const constraint=structuredClone(f.input);constraint.config.groups[2].assets[0].requires={privateProjectNote:[privateMarker]};await rejectsBeforeStorage(constraint,f.root);
  }finally{await f.stop();}
});

test('objects cannot smuggle project fields through public text or list-value fields',async()=>{
  const f=await advancedFixture();
  const changes=[
    input=>{input.config.seed={privateProjectNote:privateMarker};},
    input=>{input.config.name={privateProjectNote:privateMarker};},
    input=>{input.config.groups[0].name={privateProjectNote:privateMarker};},
    input=>{input.config.groups[0].assets[0].label={privateProjectNote:privateMarker};},
    input=>{input.config.groups[2].assets[0].fixedAttributes[0].value={privateProjectNote:privateMarker};},
    input=>{input.items[0].name={privateProjectNote:privateMarker};},
    input=>{input.items[0].sourceDna[0]={privateProjectNote:privateMarker};},
    input=>{input.definitions[0].creatorTier={privateProjectNote:privateMarker};},
    input=>{input.appearance.subtitle={privateProjectNote:privateMarker};},
  ];
  try{for(const change of changes){const input=structuredClone(f.input);change(input);await rejectsBeforeStorage(input,f.root);}}
  finally{await f.stop();}
});

test('validation keeps an atomic snapshot while the caller edits its draft',async()=>{
  const f=await advancedFixture();
  try{
    const pending=prepareRenderKit(f.input,f.root);
    f.input.items[0].name={privateProjectNote:privateMarker};
    f.input.appearance.privateProjectNote=privateMarker;
    const kit=await pending;
    assert.equal(kit.edition.items[0].name,'Creator #1');
    assert(!JSON.stringify(kit).includes(privateMarker));
  }finally{await f.stop();}
});
