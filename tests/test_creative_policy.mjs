import test from 'node:test';
import assert from 'node:assert/strict';
import {validateShotPlans,CAMERA_ANGLES} from '../scripts/creative_policy.mjs';
const plan=()=>Array.from({length:10},(_,i)=>({source_reference_index:i%8+1,source_role:'real scene',camera_angle:CAMERA_ANGLES[i%6],shot_size:i%2?'environmental':'full_product'}));
test('scene proposals require real source mapping and camera/framing variety',()=>{
  validateShotPlans(plan(),8);
  const bad=plan();bad[0].source_reference_index=9;assert.throws(()=>validateShotPlans(bad,8));
});
test('ten identical front-facing cutouts cannot satisfy camera policy',()=>{
  const bad=plan().map(x=>({...x,camera_angle:'front'}));assert.throws(()=>validateShotPlans(bad,8),/variety/);
});
