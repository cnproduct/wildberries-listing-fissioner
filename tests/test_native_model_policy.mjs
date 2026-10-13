import test from 'node:test';
import assert from 'node:assert/strict';
import {selectNativeModels} from '../scripts/native_model_policy.mjs';
test('text selection follows endpoint catalog instead of a removed default',()=>{
 const catalog={'gemini-3.8-flash-high':{},'gemini-3.1-flash-image':{}};
 assert.equal(selectNativeModels(catalog).text,'gemini-3.8-flash-high');
 assert.throws(()=>selectNativeModels(catalog,'gemini-3.7-flash-high'),/model unavailable/);
 assert.throws(()=>selectNativeModels({'gemini-3.8-flash-high':{}}),/model unavailable/);
 assert.equal(selectNativeModels({'gemini-3.7-flash-high':{},'gemini-3.1-flash-image':{}}).text,'gemini-3.7-flash-high');
});
