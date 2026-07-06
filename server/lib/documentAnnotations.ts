'use strict';

/**
 * lib/documentAnnotations.ts
 * ---------------------------
 * Shared validation for DocumentAnnotation "shapes" payloads (A4, 2026-07-05;
 * extracted 2026-07-06 so routes/documents.ts and routes/fieldRoutes.ts don't
 * carry two independently-drifting copies of the same rules).
 *
 * v1 validation only accepts {type:"pin", x, y, text?}; "arrow"/"text" shape
 * types are reserved for a later UI pass and rejected here for now, matching
 * the DocumentAnnotation schema comment (the JSON column itself already
 * accommodates them so v2 needs zero migration -- only a validation change).
 */

const MAX_ANNOTATION_SHAPES = 50;
const MAX_ANNOTATION_TEXT_LEN = 500;

function validatePinShapes(shapes: any): { error?: string; shapes?: any[] } {
  if (!Array.isArray(shapes) || shapes.length === 0) {
    return { error: 'shapes must be a non-empty array' };
  }
  if (shapes.length > MAX_ANNOTATION_SHAPES) {
    return { error: `shapes cannot exceed ${MAX_ANNOTATION_SHAPES} entries` };
  }
  const cleaned: any[] = [];
  for (const s of shapes) {
    if (!s || typeof s !== 'object') return { error: 'each shape must be an object' };
    if (s.type !== 'pin') {
      return { error: `unsupported shape type "${s.type}" -- only "pin" is accepted in v1` };
    }
    const x = Number(s.x);
    const y = Number(s.y);
    if (!Number.isFinite(x) || x < 0 || x > 1 || !Number.isFinite(y) || y < 0 || y > 1) {
      return { error: 'pin x/y must be numbers between 0 and 1 (fraction of image size)' };
    }
    let text: string | undefined;
    if (s.text !== undefined && s.text !== null) {
      if (typeof s.text !== 'string' || s.text.length > MAX_ANNOTATION_TEXT_LEN) {
        return { error: `pin text must be a string of ${MAX_ANNOTATION_TEXT_LEN} characters or fewer` };
      }
      text = s.text;
    }
    cleaned.push(text !== undefined ? { type: 'pin', x, y, text } : { type: 'pin', x, y });
  }
  return { shapes: cleaned };
}

module.exports = { validatePinShapes, MAX_ANNOTATION_SHAPES, MAX_ANNOTATION_TEXT_LEN };

export {};
