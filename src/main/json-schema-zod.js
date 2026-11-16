// JSON Schema → zod, for tools whose schemas live as JSON Schema (theme-tools.js,
// app-tools.js) but that Claude runs serve from the in-process SDK server, which
// takes zod shapes. Covers the subset those tools use: type (a name or a list,
// with "null" making it nullable), enum, minimum/maximum, integer, properties,
// additionalProperties (a schema → a record of it), items. Unknown keywords
// pass. Nested objects keep keys their schema does not list (the tool itself
// cleans its input), so a schema that forgets a key never drops what the
// agent sent.

const scalar = (z, type, schema) => {
  if (type === 'string') return Array.isArray(schema.enum) && schema.enum.length ? z.enum(schema.enum) : z.string();
  if (type === 'integer' || type === 'number') {
    let out = type === 'integer' ? z.number().int() : z.number();
    if (typeof schema.minimum === 'number') out = out.min(schema.minimum);
    if (typeof schema.maximum === 'number') out = out.max(schema.maximum);
    return out;
  }
  if (type === 'boolean') return z.boolean();
  return null;
};

const ofType = (z, type, schema) => {
  if (type === 'object') {
    if (schema.properties && typeof schema.properties === 'object') {
      const required = new Set(schema.required ?? []);
      const shape = {};
      for (const [key, property] of Object.entries(schema.properties)) {
        const value = zodForJsonSchema(z, property);
        shape[key] = required.has(key) ? value : value.optional();
      }
      return z.looseObject(shape);
    }
    const extra = schema.additionalProperties;
    return z.record(z.string(), extra && typeof extra === 'object' ? zodForJsonSchema(z, extra) : z.any());
  }
  if (type === 'array') return z.array(schema.items && typeof schema.items === 'object' ? zodForJsonSchema(z, schema.items) : z.any());
  return scalar(z, type, schema) ?? z.any();
};

/** A zod type for one JSON Schema (with its description). */
export const zodForJsonSchema = (z, schema) => {
  if (!schema || typeof schema !== 'object') return z.any();
  const types = (Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : []).filter(Boolean);
  const nullable = types.includes('null');
  const main = types.filter((type) => type !== 'null');
  let out;
  if (main.length === 0) out = z.any();
  else if (main.length === 1) out = ofType(z, main[0], schema);
  else out = z.union(main.map((type) => ofType(z, type, schema)));
  if (nullable) out = out.nullable();
  return schema.description ? out.describe(schema.description) : out;
};

/** The zod shape (property → type) of a tool's object input schema. */
export const zodShapeForInputSchema = (z, inputSchema) => {
  const required = new Set(inputSchema?.required ?? []);
  const shape = {};
  for (const [key, property] of Object.entries(inputSchema?.properties ?? {})) {
    const type = zodForJsonSchema(z, property);
    shape[key] = required.has(key) ? type : type.optional();
  }
  return shape;
};
