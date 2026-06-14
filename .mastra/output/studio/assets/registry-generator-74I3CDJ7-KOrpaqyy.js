import{p as u}from"./mastra-4G5CNDS4-Cw3EgEyL.js";import"./preload-helper-PPVm8Dsz.js";const l={};var v={};function g(r){return"getAttachmentCapabilities"in r&&typeof r.getAttachmentCapabilities=="function"}async function y(r,d,i="utf-8"){const n=Math.random().toString(36).substring(2,15),o=`${r}.${v.pid}.${Date.now()}.${n}.tmp`;try{await l.writeFile(o,d,i),await l.rename(o,r)}catch(c){try{await l.unlink(o)}catch{}throw c}}async function P(r){const d=[];for(const e of r)await e.shouldEnable()&&d.push(e);const i={},n={},o={},c=3;for(const e of d){let p=null;for(let t=1;t<=c;t++)try{p=await e.fetchProviders();break}catch{if(t<c){const s=Math.min(1e3*Math.pow(2,t-1),5e3);await new Promise(f=>setTimeout(f,s))}}if(!p)continue;const m=e.id==="models.dev",a=g(e)?e.getAttachmentCapabilities():void 0;for(const[t,s]of Object.entries(p)){const f=m?t:t===e.id?e.id:`${e.id}/${t}`;i[f]=s,n[f]=s.models.sort(),a?.[t]&&(o[f]=a[t])}}return{providers:i,models:n,attachmentCapabilities:o}}function M(r){return`/**
 * THIS FILE IS AUTO-GENERATED - DO NOT EDIT
 * Generated from model gateway providers
 */

/**
 * Provider models mapping type
 * This is derived from the JSON data and provides type-safe access
 */
export type ProviderModelsMap = {
${Object.entries(r).map(([i,n])=>{const o=n.map(m=>`'${m}'`),e=!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(i)?`'${i}'`:i,p=`  readonly ${e}: readonly [${o.join(", ")}];`;if(p.length>120){const m=n.map(a=>`    '${a}',`).join(`
`);return`  readonly ${e}: readonly [
${m}
  ];`}return p}).join(`
`)}
};

/**
 * Union type of all registered provider IDs
 */
export type Provider = keyof ProviderModelsMap;

/**
 * Provider models mapping interface
 */
export interface ProviderModels {
  [key: string]: string[];
}

/**
 * OpenAI-compatible model ID type
 * Dynamically derived from ProviderModelsMap
 * Full provider/model paths (e.g., "openai/gpt-4o", "anthropic/claude-3-5-sonnet-20241022")
 */
export type ModelRouterModelId =
  | {
      [P in Provider]: \`\${P}/\${ProviderModelsMap[P][number]}\`;
    }[Provider]
  | \`mastra/\${ProviderModelsMap['openrouter'][number]}\`
  | (string & {});

/**
 * Extract the model part from a ModelRouterModelId for a specific provider
 * Dynamically derived from ProviderModelsMap
 * Example: ModelForProvider<'openai'> = 'gpt-4o' | 'gpt-4-turbo' | ...
 */
export type ModelForProvider<P extends Provider> = ProviderModelsMap[P][number];
`}async function $(r,d,i,n,o){const c=u.dirname(r),e=u.dirname(d);await l.mkdir(c,{recursive:!0}),await l.mkdir(e,{recursive:!0}),await y(r,JSON.stringify({providers:i,models:n,version:"1.0.0"},null,2),"utf-8");const m=M(n);if(await y(d,m,"utf-8"),o&&Object.keys(o).length>0){const a=u.join(c,"capabilities");await l.mkdir(a,{recursive:!0});try{const t=await l.readdir(a);for(const s of t)s.endsWith(".json")&&await l.unlink(u.join(a,s))}catch{}for(const[t,s]of Object.entries(o)){const f=u.join(a,`${t}.json`);await y(f,JSON.stringify({attachment:s},null,2),"utf-8")}}}export{y as atomicWriteFile,P as fetchProvidersFromGateways,M as generateTypesContent,$ as writeRegistryFiles};
