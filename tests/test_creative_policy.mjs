import test from 'node:test';
import assert from 'node:assert/strict';
import {validateShotPlans,CAMERA_ANGLES,sourceEditParts,CREATIVE_POLICY_VERSION,LEGACY_CREATIVE_POLICIES} from '../scripts/creative_policy.mjs';
const plan=()=>Array.from({length:10},(_,i)=>({source_reference_index:i%8+1,source_role:'real scene',camera_angle:CAMERA_ANGLES[i%6],shot_size:i%2?'environmental':'full_product'}));
test('scene proposals require real source mapping and camera/framing variety',()=>{
  validateShotPlans(plan(),8);
  const bad=plan();bad[0].source_reference_index=9;assert.throws(()=>validateShotPlans(bad,8));
});
test('ten identical front-facing cutouts cannot satisfy camera policy',()=>{
  const bad=plan().map(x=>({...x,camera_angle:'front'}));assert.throws(()=>validateShotPlans(bad,8),/variety/);
});
test('source edit policy preserves one reference view and framing across distinct backgrounds',()=>{
  const items=plan().map((x,i)=>({...x,source_reference_index:1,camera_angle:'front',shot_size:'full_product',scene_prompt:'background '+i}));
  validateShotPlans(items,8,['front'],true);
  for(const [key,value] of [['source_reference_index',2],['camera_angle','low_front'],['shot_size','close_up']]){
    const changed=items.map(x=>({...x}));changed[1][key]=value;
    assert.throws(()=>validateShotPlans(changed,8,CAMERA_ANGLES,true),/preserve one/);
  }
  assert.throws(()=>validateShotPlans(items,0,['front'],true),/real reference/);
  assert.equal(CREATIVE_POLICY_VERSION,'2026-10-14-source-edit-v3');
  assert.deepEqual(LEGACY_CREATIVE_POLICIES,['2026-10-13-camera-v2','2026-10-11-camera-v1']);
});
test('edit request sends only the selected original, never mixes labels or edits its payload',()=>{
  const originals=[{inlineData:{mimeType:'image/png',data:'packaging-A'}},{inlineData:{mimeType:'image/png',data:'packaging-B'}}];
  const before=JSON.stringify(originals);
  const shot={source_reference_index:2,scene_prompt:'bathroom',camera_angle:'front'};
  const parts=sourceEditParts(shot,originals,{sales_quantity:3},'Fix the label');
  assert.equal(parts.length,2);assert.equal(parts[1],originals[1]);assert.equal(JSON.stringify(originals),before);
  assert.match(parts[0].text,/Keep the original product cutout/);assert.match(parts[0].text,/Fix the label/);
  assert.match(parts[0].text,/"sales_quantity":3/);assert.ok(!parts[0].text.includes('packaging-A'));
  for(const index of [0,3,1.5,'2',undefined]) assert.throws(()=>sourceEditParts({...shot,source_reference_index:index},originals,{}),/real source/);
  assert.throws(()=>sourceEditParts(shot,[originals[0],{}],{}),/real source/);
});
