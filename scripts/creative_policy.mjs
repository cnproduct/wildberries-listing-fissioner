export const CREATIVE_POLICY_VERSION = "2026-10-13-camera-v2";
export const CAMERA_ANGLES = ["front", "left_three_quarter", "right_three_quarter", "slightly_high_front", "low_front", "top_detail"];
export const SHOT_SIZES = ["full_product", "environmental", "close_up"];
export const SCENE_DIRECTION = "First inspect every supplied reference image and identify its role and actual application context. Preserve those useful roles, but art-direct a fresh background, prop placement, lighting and product camera view. Do not merely recolour or replace the background behind the same product cutout. Use varied camera heights and framing within the evidence-supported view list. Aim for four views only when supported; never force a side/rear view from front-only references. Never invent unseen rear labels, hidden mechanisms or unverified usage. Use another supported front or three-quarter view when a new viewpoint cannot be reconstructed truthfully.";

export function validateShotPlans(items, referenceCount, supportedAngles=CAMERA_ANGLES) {
  if (!Array.isArray(items) || items.length !== 10) throw new Error("Ten proposals required");
  for (const item of items) {
    if (!supportedAngles.includes(item.camera_angle) || !SHOT_SIZES.includes(item.shot_size) ||
        !Number.isInteger(item.source_reference_index) || item.source_reference_index < 1 || item.source_reference_index > referenceCount ||
        typeof item.source_role !== "string" || !item.source_role.trim()) {
      throw new Error("Each proposal needs a real reference, its role, camera angle and shot size");
    }
  }
  if (new Set(items.map(x => x.camera_angle)).size < Math.min(4,supportedAngles.length) || new Set(items.map(x => x.shot_size)).size < 2) {
    throw new Error("Insufficient camera and framing variety");
  }
}
