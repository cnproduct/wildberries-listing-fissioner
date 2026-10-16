import test from 'node:test';
import assert from 'node:assert/strict';
import {structuredGeneration} from '../scripts/structured_generation.mjs';
import {supportedCameraAngles,assessCameraReview} from '../scripts/camera_policy.mjs';

test('malformed source analysis and invalid schema are corrected before use',async()=>{
 const valid={geometry:'flat bottle',reference_views:[{reference_index:1,visible_surfaces:['front']}]};
 const responses=['of label: not JSON',JSON.stringify({...valid,reference_views:[]}),JSON.stringify(valid)];
 const prompts=[];
 const result=await structuredGeneration(async parts=>{prompts.push(parts);return [{text:responses.shift()}];},[{text:'Inspect original'}],v=>supportedCameraAngles(v,1),'source_analysis');
 assert.deepEqual(result,valid);assert.equal(prompts.length,3);
 assert.match(prompts[2].at(-1).text,/Invalid source camera evidence/);
 assert.ok(prompts.every(p=>p[0].text==='Inspect original'));
});
test('split fenced JSON is read, but thoughts and prose are not accepted as evidence',async()=>{
 const result=await structuredGeneration(async()=>[{text:'private reasoning',thought:true},{text:'```json\n{"ok":'},{text:'true}\n```'}],[],v=>assert.equal(v.ok,true),'source_analysis');
 assert.equal(result.ok,true);
 let count=0;
 await assert.rejects(()=>structuredGeneration(async()=>{count++;return [{text:'[]'}];},[],()=>{},'source_analysis'),/^Error: Structured generation invalid: source_analysis$/);
 assert.equal(count,3);
});
test('well-formed failed quality reviews are returned as failed, never retried into approval',async()=>{
 const raw={product_passed:false,product_issues:['wrong label'],copy_passed:true,copy_issues:[],composition_passed:true,composition_issues:[],camera:{matches_plan:true,observed_angle:'front',reason:'front'}};
 let count=0;
 const r=await structuredGeneration(async()=>{count++;return [{text:JSON.stringify(raw)}];},[],v=>assessCameraReview(v,['front']),'image_review');
 assert.equal(assessCameraReview(r,['front']).passed,false);assert.equal(count,1);
});
test('transport failures are not multiplied by schema retries or exposed as raw response text',async()=>{
 let count=0;
 await assert.rejects(()=>structuredGeneration(async()=>{count++;throw Error('Native generation HTTP 403');},[],()=>{},'scene_plan'),/HTTP 403/);
 assert.equal(count,1);
});


test('complete evidence with no visible product is not retried until the model invents one',async()=>{
 let calls=0;
 const analysis={geometry:'No product identifiable',reference_views:[{reference_index:1,visible_surfaces:[]}]};
 await assert.rejects(()=>structuredGeneration(async()=>{calls++;return [{text:JSON.stringify(analysis)}];},[],v=>supportedCameraAngles(v,1),'source_analysis'),/No supported camera view/);
 assert.equal(calls,1);
});
