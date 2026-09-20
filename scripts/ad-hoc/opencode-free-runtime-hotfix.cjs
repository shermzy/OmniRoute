const fs = require("node:fs");
const crypto = require("node:crypto");

const file = process.argv[2];
if (!file) throw new Error("usage: node opencode-free-runtime-hotfix.cjs <compiled-chunk>");

let body = fs.readFileSync(file, "utf8");
const sha = crypto.createHash("sha256").update(body).digest("hex");
const EXPECTED_SHA = "986991f18d773d7a7e5969733be93cbfb1d873fca1c830a78f03f61971a0a18c";
if (sha !== EXPECTED_SHA) {
  throw new Error(`refusing to patch unexpected chunk sha256=${sha}`);
}

function replaceOnce(label, needle, replacement) {
  const first = body.indexOf(needle);
  const last = body.lastIndexOf(needle);
  if (first < 0 || first !== last) {
    throw new Error(`${label}: expected exactly one match, first=${first}, last=${last}`);
  }
  body = body.slice(0, first) + replacement + body.slice(first + needle.length);
}

const returnNeedle =
  'return"openai-responses"===this._requestFormat&&d.startsWith("muse-spark")&&';

const headerContract =
  'd&&!v(d,this.provider)&&"https://opencode.ai/zen/v1"===this.config?.baseUrl&&(' +
  'j.Authorization="Bearer public",' +
  'j.Accept="text/event-stream",' +
  'j["User-Agent"]="opencode/prod/1.18.31/cli",' +
  'j["x-opencode-client"]="cli",' +
  'j["x-opencode-project"]="global",' +
  'j["x-opencode-session"]=/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(j["x-opencode-session"]||"")?' +
  'j["x-opencode-session"]:(()=>{let a=BigInt(Date.now())*4096n+1n,b=(~a)&281474976710655n,c=b.toString(16).padStart(12,"0"),d=(0,e.randomBytes)(14),f="0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";return"ses_"+c+Array.from(d,a=>f[a%62]).join("")})(),' +
  'j["x-opencode-request"]=/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(j["x-opencode-request"]||"")?' +
  'j["x-opencode-request"]:(()=>{let a=(BigInt(Date.now())*4096n+1n)&281474976710655n,b=a.toString(16).padStart(12,"0"),c=(0,e.randomBytes)(14),d="0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";return"msg_"+b+Array.from(c,a=>d[a%62]).join("")})()' +
  ');return"openai-responses"===this._requestFormat&&d.startsWith("muse-spark")&&v(d,this.provider)&&';

replaceOnce("header contract", returnNeedle, headerContract);

const transformNeedle =
  'transformRequest(a,b,c,d){let e=super.transformRequest(a,b,c,d);if((e=this.applyDeepSeekJsonSchemaFallback(a,e))&&"object"==typeof e&&!Array.isArray(e)&&Object.prototype.hasOwnProperty.call(e,"client_metadata")&&delete e.client_metadata,e&&"object"==typeof e&&!Array.isArray(e)){';

const transformReplacement =
  'transformRequest(a,b,c,d){let e=super.transformRequest(a,b,c,d);' +
  'e=this.applyDeepSeekJsonSchemaFallback(a,e);' +
  '!v(a,this.provider)&&"https://opencode.ai/zen/v1"===this.config?.baseUrl&&e&&"object"==typeof e&&!Array.isArray(e)&&(' +
  'e.stream=!0,' +
  'Array.isArray(e.tools)&&e.tools.length||(e.tools="openai-responses"===this._requestFormat?' +
  '[{type:"function",name:"bash",description:"Do not call this tool. It exists only for API compatibility.",parameters:{type:"object",properties:{}}},{type:"function",name:"edit",description:"Do not call this tool. It exists only for API compatibility.",parameters:{type:"object",properties:{}}},{type:"function",name:"glob",description:"Do not call this tool. It exists only for API compatibility.",parameters:{type:"object",properties:{}}},{type:"function",name:"grep",description:"Do not call this tool. It exists only for API compatibility.",parameters:{type:"object",properties:{}}},{type:"function",name:"invalid",description:"Do not call this tool. It exists only for API compatibility.",parameters:{type:"object",properties:{}}},{type:"function",name:"question",description:"Do not call this tool. It exists only for API compatibility.",parameters:{type:"object",properties:{}}},{type:"function",name:"read",description:"Do not call this tool. It exists only for API compatibility.",parameters:{type:"object",properties:{}}},{type:"function",name:"skill",description:"Do not call this tool. It exists only for API compatibility.",parameters:{type:"object",properties:{}}},{type:"function",name:"task",description:"Do not call this tool. It exists only for API compatibility.",parameters:{type:"object",properties:{}}},{type:"function",name:"todowrite",description:"Do not call this tool. It exists only for API compatibility.",parameters:{type:"object",properties:{}}},{type:"function",name:"webfetch",description:"Do not call this tool. It exists only for API compatibility.",parameters:{type:"object",properties:{}}},{type:"function",name:"websearch",description:"Do not call this tool. It exists only for API compatibility.",parameters:{type:"object",properties:{}}},{type:"function",name:"write",description:"Do not call this tool. It exists only for API compatibility.",parameters:{type:"object",properties:{}}}]:' +
  '[{type:"function",function:{name:"bash",description:"Do not call this tool. It exists only for API compatibility.",parameters:{type:"object",properties:{}}}},{type:"function",function:{name:"edit",description:"Do not call this tool. It exists only for API compatibility.",parameters:{type:"object",properties:{}}}},{type:"function",function:{name:"glob",description:"Do not call this tool. It exists only for API compatibility.",parameters:{type:"object",properties:{}}}},{type:"function",function:{name:"grep",description:"Do not call this tool. It exists only for API compatibility.",parameters:{type:"object",properties:{}}}},{type:"function",function:{name:"invalid",description:"Do not call this tool. It exists only for API compatibility.",parameters:{type:"object",properties:{}}}},{type:"function",function:{name:"question",description:"Do not call this tool. It exists only for API compatibility.",parameters:{type:"object",properties:{}}}},{type:"function",function:{name:"read",description:"Do not call this tool. It exists only for API compatibility.",parameters:{type:"object",properties:{}}}},{type:"function",function:{name:"skill",description:"Do not call this tool. It exists only for API compatibility.",parameters:{type:"object",properties:{}}}},{type:"function",function:{name:"task",description:"Do not call this tool. It exists only for API compatibility.",parameters:{type:"object",properties:{}}}},{type:"function",function:{name:"todowrite",description:"Do not call this tool. It exists only for API compatibility.",parameters:{type:"object",properties:{}}}},{type:"function",function:{name:"webfetch",description:"Do not call this tool. It exists only for API compatibility.",parameters:{type:"object",properties:{}}}},{type:"function",function:{name:"websearch",description:"Do not call this tool. It exists only for API compatibility.",parameters:{type:"object",properties:{}}}},{type:"function",function:{name:"write",description:"Do not call this tool. It exists only for API compatibility.",parameters:{type:"object",properties:{}}}}])' +
  ');' +
  'if(e&&"object"==typeof e&&!Array.isArray(e)&&Object.prototype.hasOwnProperty.call(e,"client_metadata")&&delete e.client_metadata,e&&"object"==typeof e&&!Array.isArray(e)){';

replaceOnce("body contract", transformNeedle, transformReplacement);

for (const marker of [
  'Authorization="Bearer public"',
  'User-Agent"]="opencode/prod/1.18.31/cli"',
  'x-opencode-client"]="cli"',
  'e.stream=!0',
  'msg_',
  'ses_',
]) {
  if (!body.includes(marker)) throw new Error(`patched chunk is missing marker: ${marker}`);
}

fs.writeFileSync(file, body);
const patchedSha = crypto.createHash("sha256").update(body).digest("hex");
console.log(`patched ${file}`);
console.log(`before=${sha}`);
console.log(`after=${patchedSha}`);
