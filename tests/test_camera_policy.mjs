import test from 'node:test';
import assert from 'node:assert/strict';
import {supportedCameraAngles,effectiveShot,assessCameraReview,canReuseApprovedShot} from '../scripts/camera_policy.mjs';
import {validateShotPlans} from '../scripts/creative_policy.mjs';
const evidence={geometry:'flat oval bottle with a ribbed cap',reference_views:[{reference_index:1,visible_surfaces:['front']}]};
const review=()=>({product_passed:true,product_issues:[],copy_passed:true,copy_issues:[],composition_passed:true,composition_issues:[],camera:{matches_plan:false,observed_angle:'slightly_high_front',reason:'Safe elevated frontal view instead of a side view'}});
test('front-only source cannot authorize an unseen three-quarter side or overhead label',()=>{
 const allowed=supportedCameraAngles(evidence,1);
 assert.deepEqual(allowed,['front','slightly_high_front','low_front']);
 assert.equal(effectiveShot({camera_angle:'right_three_quarter',scene_name:'keep scene'},allowed).camera_angle,'front');
 const plans=Array.from({length:10},(_,i)=>({camera_angle:allowed[i%3],source_reference_index:1,source_role:'bottle_focus',shot_size:i%2?'environmental':'full_product'}));
 validateShotPlans(plans,1,allowed);
 plans[0].camera_angle='right_three_quarter';assert.throws(()=>validateShotPlans(plans,1,allowed));
});
test('safe actual camera variation alone does not fail the whole batch',()=>{
 const r=assessCameraReview(review(),supportedCameraAngles(evidence,1));
 assert.equal(r.passed,true);assert.equal(r.camera_adjusted,true);assert.equal(r.observed_angle,'slightly_high_front');
});
test('angle adaptation cannot excuse product distortion, invented text or wrong main subject',()=>{
 for(const [kind,issue] of [['product','garbled label'],['product','advertisement drawn on carton'],['product','changed cap'],['copy','unsupported claim'],['composition','carton hidden behind bottle']]){
  const r=review();r[kind+'_passed']=false;r[kind+'_issues']=[issue];const result=assessCameraReview(r,['front','slightly_high_front']);
  assert.equal(result.passed,false);assert.equal(result.camera_adjusted,false);assert.ok(result.issues.includes(issue));
 }
});
test('unknown views and contradictory review results never pass',()=>{
 const r=review();r.camera.observed_angle='unknown';assert.equal(assessCameraReview(r,['front']).passed,false);
 r.camera.observed_angle='front';r.product_issues=['extra unit'];assert.equal(assessCameraReview(r,['front']).passed,false);
 delete r.copy_passed;assert.throws(()=>assessCameraReview(r,['front']),/structured/);
 assert.throws(()=>supportedCameraAngles({...evidence,reference_views:[...evidence.reference_views,...evidence.reference_views]},2));
});

test('camera-policy upgrade preserves valid accepted images but never bypasses hashes or facts',()=>{
 const item={camera_angle:'left_three_quarter',title:'same product'};
 const old={identity:'facts-and-source',review:{passed:true,issues:[]},item:{...item,image_path:'old.jpg'},sha256:'verified-image'};
 assert.equal(canReuseApprovedShot(old,item,'facts-and-source','verified-image'),true);
 assert.equal(canReuseApprovedShot(old,item,'changed-facts','verified-image'),false);
 assert.equal(canReuseApprovedShot(old,item,'facts-and-source','edited-image'),false);
 const adapted={...old,planned_item:item,item:{...item,camera_angle:'front'}};
 assert.equal(canReuseApprovedShot(adapted,item,'facts-and-source','verified-image'),true);
 adapted.review={passed:false,issues:['wrong label']};assert.equal(canReuseApprovedShot(adapted,item,'facts-and-source','verified-image'),false);
});

test('side evidence from another reference does not authorize carton-only side reconstruction',()=>{
 const a={geometry:'bottle and carton',reference_views:[{reference_index:1,visible_surfaces:['front']},{reference_index:2,visible_surfaces:['front','left_side']}]};
 assert.ok(supportedCameraAngles(a,2).includes('left_three_quarter'));
 assert.ok(!supportedCameraAngles(a,2,1).includes('left_three_quarter'));
 assert.ok(supportedCameraAngles(a,2,2).includes('left_three_quarter'));
});
