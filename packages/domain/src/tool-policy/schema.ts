// A closed JSON-schema subset for gateway tool arguments (PW-027). Only what the tool schemas use:
// object (properties, required, additionalProperties: false), string (maxLength, minLength, pattern,
// enum), integer, boolean, array (items, minItems, maxItems, uniqueItems). Anything unknown fails.
// The same schemas are published to the model and checked against ajv in the PW-027 contract test.
export type Schema =
  | { type: 'object'; properties: Record<string, Schema>; required?: string[]; additionalProperties: false; description?: string }
  | { type: 'string'; maxLength: number; minLength?: number; pattern?: string; enum?: string[]; description?: string }
  | { type: 'integer'; minimum?: number; maximum?: number; description?: string }
  | { type: 'boolean'; description?: string }
  | { type: 'array'; items: Schema; minItems?: number; maxItems: number; uniqueItems?: boolean; description?: string }
  | { type: 'opaque_object'; maxKeys: number; description?: string }; // validated by the domain function

const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

export function validate(schema: Schema, v: unknown, at = '$'): string | null {
  switch (schema.type) {
    case 'object': {
      if (!plain(v)) return `${at} must be an object`;
      for (const k of Object.keys(v)) if (!Object.hasOwn(schema.properties, k)) return `${at}.${k.slice(0, 40)} is not allowed`;
      for (const k of schema.required ?? []) if (!Object.hasOwn(v, k)) return `${at}.${k} is required`;
      for (const [k, s] of Object.entries(schema.properties)) if (Object.hasOwn(v, k)) { const e = validate(s, v[k], `${at}.${k}`); if (e) return e; }
      return null;
    }
    case 'string':
      if (typeof v !== 'string') return `${at} must be a string`;
      if (v.length > schema.maxLength || v.length < (schema.minLength ?? 0)) return `${at} has the wrong length`;
      if (schema.pattern && !new RegExp(schema.pattern).test(v)) return `${at} has the wrong form`;
      if (schema.enum && !schema.enum.includes(v)) return `${at} must be one of ${schema.enum.join(', ')}`;
      return null;
    case 'integer':
      if (!Number.isInteger(v)) return `${at} must be an integer`;
      if ((schema.minimum !== undefined && (v as number) < schema.minimum) || (schema.maximum !== undefined && (v as number) > schema.maximum)) return `${at} is out of range`;
      return null;
    case 'boolean':
      return typeof v === 'boolean' ? null : `${at} must be true or false`;
    case 'array': {
      if (!Array.isArray(v)) return `${at} must be an array`;
      if (v.length > schema.maxItems || v.length < (schema.minItems ?? 0)) return `${at} has the wrong number of items`;
      if (schema.uniqueItems && new Set(v.map((x) => JSON.stringify(x))).size !== v.length) return `${at} has repeated items`;
      for (let i = 0; i < v.length; i++) { const e = validate(schema.items, v[i], `${at}[${i}]`); if (e) return e; }
      return null;
    }
    case 'opaque_object':
      return plain(v) && Object.keys(v).length <= schema.maxKeys ? null : `${at} must be a small object`;
    default:
      return `${at}: unsupported schema`;
  }
}

// the published form (standard JSON Schema): opaque objects become plain objects
export function publish(schema: Schema): Record<string, unknown> {
  if (schema.type === 'opaque_object') return { type: 'object', maxProperties: schema.maxKeys, ...(schema.description ? { description: schema.description } : {}) };
  if (schema.type === 'object') return { ...schema, properties: Object.fromEntries(Object.entries(schema.properties).map(([k, s]) => [k, publish(s)])) };
  if (schema.type === 'array') return { ...schema, items: publish(schema.items) };
  return { ...schema };
}
