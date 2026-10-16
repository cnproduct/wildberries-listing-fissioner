/** Retry malformed model output without weakening the caller's validation. */
export async function structuredGeneration(call, parts, validate, stage) {
  let correction = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    // Transport/auth failures belong to the transport retry policy.
    const response = await call([...parts, {text:'Return one complete JSON object only. No prose or Markdown. '+correction}]);
    let value;
    try {
      const text = response.filter(p => !p.thought && typeof p.text === 'string').map(p => p.text).join('').trim();
      value = JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
      if (!value || Array.isArray(value) || typeof value !== 'object') throw Error('Expected a JSON object');
    } catch {
      correction = 'The previous response was not a complete JSON object. Return the entire object with all required fields.';
      continue;
    }
    try {
      validate(value);
      return value;
    } catch (error) {
      if(error.code==='source_product_not_visible') throw error;
      // Only local validator messages are used, never raw model text.
      correction = 'Correct this validation error while preserving the source facts: '+error.message;
    }
  }
  throw Error('Structured generation invalid: '+stage);
}
