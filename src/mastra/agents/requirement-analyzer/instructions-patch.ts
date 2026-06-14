/**
 * Instructions Patch — New Tools Block
 *
 * This file documents the block that was merged into instructions.ts for the
 * Guardrails Implementation Challenge. It should be inserted after the
 * `submission_read` tool description in the existing instructions.ts.
 *
 * NOTE: instructions.ts in this solution submission already has this content
 * merged in. This file exists as a reference for applying the patch to a
 * fresh copy of the base codebase.
 *
 * WHERE TO INSERT: After the closing of the `### submission_read(path)` block
 * in AGENT_INSTRUCTIONS (around the line describing the `path` parameter).
 *
 * WHAT IT DOES:
 *  1. Documents submission_search_terms — the multi-query search tool that
 *     satisfies the False-Negative Guardrail's synonym-coverage requirement
 *     in a single tool call instead of many sequential searches.
 *  2. Documents verify_constraint — the cheap AST existence/relevance check
 *     that satisfies the False-Positive Guardrail's AST validation requirement
 *     without consuming a submission_read budget unit.
 *  3. Explains WHEN to use each new tool (replaces certain existing patterns).
 */

export const NEW_TOOLS_INSTRUCTIONS_BLOCK = `

### submission_search_terms(queries)
Run MULTIPLE related search terms in ONE call and get merged, deduplicated results.

Parameters:
- queries: array of 2–6 related terms (e.g. ["auth", "login", "session", "jwt"])

Returns:
- files[]/documents[] merged across all queries, each tagged with matchedQueries[]
- perQuery[] summary showing how many results each term found
- zeroResultQueries[] listing which terms found nothing

**Use INSTEAD OF multiple submission_search calls when:**
- The requirement maps to a domain concept with synonyms (auth, cache, rate-limit, multi-tenant, etc.)
- You want to verify a "not found" conclusion by trying several literal patterns at once
- Before concluding MISSING, run submission_search_terms with 4–6 synonyms from the domain table

Still use plain submission_search for a single specific symbol/file name lookup.

### verify_constraint(constraintText, candidatePath)
Sanity-check a candidate symbol/file against a constraint BEFORE citing it in your report.

Parameters:
- constraintText: the constraint or requirement text being verified
- candidatePath: "file.ext" or "file.ext:symbolName"

Returns:
- exists (bool): whether the path is in the AST index (catches hallucinated/typo paths cheaply)
- kind, signature, complexity, hasErrorHandling, hasLogging, calls[], calledBy[]
- keywordOverlapScore (0–1): LOW (< 0.1) means you may have the WRONG symbol
- suggestions[]: similar indexed paths if the path doesn't exist

**Use this to cheaply validate a candidate before submission_read.**
Does NOT count as evidence — you still must submission_read to quote code in the report.

`;

/**
 * Instructions for applying this patch manually:
 *
 * 1. Open src/mastra/agents/requirement-analyzer/instructions.ts
 * 2. Find the block that describes `### submission_read(path)`
 * 3. After that block ends (before the next section), paste the contents
 *    of NEW_TOOLS_INSTRUCTIONS_BLOCK above.
 * 4. The resulting instructions.ts in this submission already has this applied —
 *    compare with the base codebase's instructions.ts to see the exact diff.
 *
 * If using the instructions.ts provided in this submission, no action needed —
 * the tools are already documented in AGENT_INSTRUCTIONS.
 */
