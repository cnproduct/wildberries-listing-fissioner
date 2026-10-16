/** Evidence-bounded camera planning and separate product/composition gates. */
export const CAMERA_REVIEW_VERSION='2026-10-13-evidence-v2';
export const VIEW_INSTRUCTIONS={
 front:'Front label toward camera, approximately eye level. Keep all required packaging visible.',
 slightly_high_front:'Camera 5–15 degrees above label centre, looking slightly down. Keep the known front dominant; do not invent unseen top or rear details.',
 low_front:'Camera 5–10 degrees below label centre, looking slightly up. Keep the known front dominant; no unseen underside.',
 left_three_quarter:'Camera on the product front-left, showing its known LEFT side and front. Use only the left-side surface evidenced in the references.',
 right_three_quarter:'Camera on the product front-right, showing its known RIGHT side and front. Use only the right-side surface evidenced in the references.',
 top_detail:'High-angle view showing the actual top surface/cap shown in the references while keeping the front package and brand label clearly visible; do not invent a top label or mechanism.'
};
export function supportedCameraAngles(analysis, referenceCount, referenceIndex=null){
 if(!analysis || typeof analysis.geometry!=='string' || !analysis.geometry.trim() || !Array.isArray(analysis.reference_views) || analysis.reference_views.length!==referenceCount) throw Error('Invalid source camera evidence');
 const seen=new Set(),surfaces=new Set();
 for(const v of analysis.reference_views){
  if(!Number.isInteger(v.reference_index)||v.reference_index<1||v.reference_index>referenceCount||seen.has(v.reference_index)||!Array.isArray(v.visible_surfaces)||v.visible_surfaces.some(s=>!['front','left_side','right_side','top'].includes(s))) throw Error('Invalid source camera evidence');
  seen.add(v.reference_index);
  if(referenceIndex===null || v.reference_index===referenceIndex) v.visible_surfaces.forEach(s=>surfaces.add(s));
 }
 const allowed=[];
 if(surfaces.has('front')) allowed.push('front','slightly_high_front','low_front');
 if(surfaces.has('front')&&surfaces.has('left_side')) allowed.push('left_three_quarter');
 if(surfaces.has('front')&&surfaces.has('right_side')) allowed.push('right_three_quarter');
 if(surfaces.has('top')) allowed.push('top_detail');
 if(!allowed.length) {
  const error=Error('No supported camera view');
  if(referenceIndex===null) error.code='source_product_not_visible';
  throw error;
 }
 return allowed;
}
export function effectiveShot(item, allowed, index=0){
 if(!allowed.length || allowed.some(a=>!VIEW_INSTRUCTIONS[a])) throw Error('Invalid supported camera views');
 return {...item,camera_angle:allowed.includes(item.camera_angle)?item.camera_angle:allowed[index%allowed.length]};
}
export function assessCameraReview(raw, allowed){
 const issues=[];
 for(const kind of ['product','copy','composition']){
  if(typeof raw?.[kind+'_passed']!=='boolean'||!Array.isArray(raw[kind+'_issues'])||raw[kind+'_issues'].some(x=>typeof x!=='string')) throw Error('Invalid structured image review');
  issues.push(...raw[kind+'_issues']);
  if(!raw[kind+'_passed']&&!raw[kind+'_issues'].length) issues.push(kind+' verification failed');
 }
 const cam=raw.camera;
 if(!cam||typeof cam.matches_plan!=='boolean'||typeof cam.observed_angle!=='string'||typeof cam.reason!=='string') throw Error('Invalid camera review');
 if(!allowed.includes(cam.observed_angle)) issues.push('Camera shows an unsupported or unverified surface: '+cam.reason);
 // Angle labels are ambiguous; accept a independently verified, safe alternate
 // view only when every physical-product, copy and composition gate passes.
 return {passed:issues.length===0,issues,observed_angle:cam.observed_angle,
   camera_adjusted:issues.length===0&&!cam.matches_plan,camera_note:cam.reason,
   checks:{product_passed:raw.product_passed,copy_passed:raw.copy_passed,composition_passed:raw.composition_passed}};
}
export const CAMERA_REVIEW_PROMPT='Compare source photographs with the LAST generated image. Return ONLY JSON {product_passed:boolean,product_issues:[English strings],copy_passed:boolean,copy_issues:[English strings],composition_passed:boolean,composition_issues:[English strings],camera:{matches_plan:boolean,observed_angle:string,reason:string}}. '+
 'Product checks: exact physical shape, cap, label brand and major text/artwork, sale unit count and required packaging. Reject distorted labels, extra units and any promotional overlay from the source that has been painted onto the real package. Ignore only unreadable microprint, not major readable text. '+
 'Copy checks: verify Russian title/description against the source facts AND the actual image. The title and description are delivered separately in chat, NOT printed on the image. Source advertising banners are context only. Generated images must NOT contain added text overlays; absence of the source banners is expected, never a failure. Compare the requested scene_prompt and selected reference state; do not invent additional requirements. '+
 'Composition checks: required main subject and framing, appropriate scene background. Preserving the source product cutout with a new background is allowed. Reject when carton-focus puts the carton behind the bottle. '+
 'Camera check is separate: report the ACTUAL supported view, not an imagined exact azimuth. Small elevation/perspective differences and left/right terminology ambiguity alone are not product or composition errors. If view is indeterminate use unknown; never pretend an unverified hidden surface is supported. Never put a camera-only mismatch in product/copy/composition issues. All other failures remain strict.';
export function canReuseApprovedShot(saved,planned,identity,currentImageHash){
 return !!(saved?.identity===identity && saved.review?.passed===true && Array.isArray(saved.review.issues) && saved.review.issues.length===0 &&
   Object.keys(planned).every(k=>JSON.stringify((saved.planned_item || saved.item)?.[k])===JSON.stringify(planned[k])) && currentImageHash && saved.sha256===currentImageHash);
}
