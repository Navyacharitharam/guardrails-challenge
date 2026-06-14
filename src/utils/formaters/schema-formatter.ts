import { z } from 'zod';

function formatZodType(schema: z.ZodTypeAny): string {
    const def = (schema as any).def || (schema as any)._def;
    // Zod v4 uses def.type, Zod v3 uses _def.typeName
    const typeName = def?.type || def?.typeName;

    // Handle optional wrapper - unwrap inner type
    if (typeName === 'optional') {
        return `${formatZodType(def.innerType)} (optional)`;
    }

    // Handle nullable wrapper - unwrap inner type
    if (typeName === 'nullable') {
        return `${formatZodType(def.innerType)} | null`;
    }

    // Handle default wrapper - unwrap inner type
    if (typeName === 'default') {
        return formatZodType(def.innerType);
    }

    // Handle string
    if (typeName === 'string') {
        const checks = def.checks || [];
        const regex = checks.find((c: any) => c.kind === 'regex');
        if (regex) return `string (pattern: ${regex.regex})`;
        const maxLen = checks.find((c: any) => c.kind === 'max');
        if (maxLen) return `string (max ${maxLen.value} chars)`;
        return 'string';
    }

    // Handle number
    if (typeName === 'number') {
        const checks = def.checks || [];
        const isInt = checks.some((c: any) => c.kind === 'int');
        const min = checks.find((c: any) => c.kind === 'min');
        const max = checks.find((c: any) => c.kind === 'max');
        let type = isInt ? 'integer' : 'number';
        if (min && max) type += ` (${min.value}-${max.value})`;
        return type;
    }

    // Handle boolean
    if (typeName === 'boolean') return 'boolean';

    // Handle literal
    if (typeName === 'literal') {
        const val = def.value;
        return typeof val === 'string' ? `"${val}"` : String(val);
    }

    // Handle enum (Zod v4 uses entries object, v3 uses values array)
    if (typeName === 'enum') {
        const entries = def.entries;
        if (entries && typeof entries === 'object') {
            return Object.values(entries).map((v: any) => `"${v}"`).join(' | ');
        }
        const values = def.values;
        if (Array.isArray(values)) {
            return values.map((v: string) => `"${v}"`).join(' | ');
        }
        return 'enum';
    }

    // Handle native enum
    if (typeName === 'nativeEnum') {
        const enumObj = def.values || def.entries;
        if (enumObj && typeof enumObj === 'object') {
            const values = Object.values(enumObj).filter(v => typeof v === 'string' || typeof v === 'number');
            return values.map(v => typeof v === 'string' ? `"${v}"` : String(v)).join(' | ');
        }
        return 'enum';
    }

    // Handle array (Zod v4 uses element, v3 uses type)
    if (typeName === 'array') {
        const elementSchema = def.element || def.type;
        const innerType = formatZodType(elementSchema);
        const maxItems = def.maxLength?.value;
        return `[${innerType}]${maxItems ? ` (max ${maxItems} items)` : ''}`;
    }

    // Handle object (Zod v4 uses shape getter)
    if (typeName === 'object') {
        const shape = typeof def.shape === 'function' ? def.shape() : def.shape;
        if (shape && typeof shape === 'object') {
            const inner = Object.entries(shape)
                .map(([k, v]) => {
                    const zodField = v as z.ZodTypeAny;
                    const desc = zodField.description;
                    const typeStr = formatZodType(zodField);
                    return `${k}: ${typeStr}${desc ? ` /* ${desc} */` : ''}`;
                })
                .join(', ');
            return `{ ${inner} }`;
        }
        return 'object';
    }

    // Handle union
    if (typeName === 'union') {
        const options = def.options as z.ZodTypeAny[];
        if (Array.isArray(options)) {
            return options.map(opt => formatZodType(opt)).join(' | ');
        }
        return 'union';
    }

    // Handle tuple
    if (typeName === 'tuple') {
        const items = def.items as z.ZodTypeAny[];
        if (Array.isArray(items)) {
            return `[${items.map(item => formatZodType(item)).join(', ')}]`;
        }
        return 'tuple';
    }

    // Handle record
    if (typeName === 'record') {
        const valueType = formatZodType(def.valueType);
        return `Record<string, ${valueType}>`;
    }

    // Handle any/unknown
    if (typeName === 'any') return 'any';
    if (typeName === 'unknown') return 'unknown';

    // Handle null/undefined/void
    if (typeName === 'null') return 'null';
    if (typeName === 'undefined') return 'undefined';
    if (typeName === 'void') return 'void';

    // Handle date
    if (typeName === 'date') return 'Date';

    // Fallback: try to infer from schema structure
    if ((schema as any).shape) {
        const shape = (schema as any).shape;
        const resolvedShape = typeof shape === 'function' ? shape() : shape;
        const inner = Object.entries(resolvedShape)
            .map(([k, v]) => {
                const zodField = v as z.ZodTypeAny;
                const desc = zodField.description;
                const typeStr = formatZodType(zodField);
                return `${k}: ${typeStr}${desc ? ` /* ${desc} */` : ''}`;
            })
            .join(', ');
        return `{ ${inner} }`;
    }

    return typeName ? `<${typeName}>` : 'unknown';
}

/**
 * Generate a human-readable schema description for LLM instructions
 */
export function formatSchemaForInstructions(schema: z.ZodObject<any>): string {
    const shape = schema.shape;
    const lines: string[] = ['{'];

    for (const [key, value] of Object.entries(shape)) {
        const zodValue = value as z.ZodTypeAny;
        const desc = zodValue.description || '';
        const typeStr = formatZodType(zodValue);
        lines.push(`  "${key}": ${typeStr}${desc ? ` // ${desc}` : ''}`);
    }

    lines.push('}');
    return lines.join('\n');
}
