/** Use only models advertised by this generation endpoint; respect explicit overrides. */
export function selectNativeModels(models, requestedText, requestedImage) {
  const available = new Set(Object.keys(models || {}));
  const text = requestedText || ['gemini-3.8-flash-high','gemini-3.7-flash-high'].find(x=>available.has(x));
  const image = requestedImage || 'gemini-3.1-flash-image';
  if (!text || !available.has(text) || !available.has(image)) {
    throw new Error('Native generation model unavailable in endpoint catalog');
  }
  return {text,image};
}
