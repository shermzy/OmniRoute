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
  'j["User-Agent"]="opencode/1.18.31",' +
  'j["x-opencode-client"]||="desktop",' +
  'j["x-opencode-project"]||="global",' +
  'j["x-opencode-session"]=/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(j["x-opencode-session"]||"")?' +
  'j["x-opencode-session"]:"ses_"+(0,e.createHash)("sha256").update(String(j["x-opencode-session"]||d||"opencode")).digest("hex").slice(0,26),' +
  'j["x-opencode-request"]=/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(j["x-opencode-request"]||"")?' +
  'j["x-opencode-request"]:"msg_"+(0,e.createHash)("sha256").update(String(j["x-opencode-request"]||(0,e.randomUUID)())).digest("hex").slice(0,26)' +
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
  '[{type:"function",name:"_noop",description:"Compatibility placeholder. Do not call.",parameters:{type:"object",properties:{}}}]:' +
  '[{type:"function",function:{name:"_noop",description:"Compatibility placeholder. Do not call.",parameters:{type:"object",properties:{}}}}])' +
  ');' +
  'if(e&&"object"==typeof e&&!Array.isArray(e)&&Object.prototype.hasOwnProperty.call(e,"client_metadata")&&delete e.client_metadata,e&&"object"==typeof e&&!Array.isArray(e)){';

replaceOnce("body contract", transformNeedle, transformReplacement);

if (!body.includes('Authorization="Bearer public"')) {
  throw new Error("patched chunk is missing public bearer marker");
}
if (!body.includes('e.stream=!0')) {
  throw new Error("patched chunk is missing forced streaming marker");
}
if (!body.includes('User-Agent"]="opencode/1.18.31"')) {
  throw new Error("patched chunk is missing versioned OpenCode user-agent marker");
}

fs.writeFileSync(file, body);
const patchedSha = crypto.createHash("sha256").update(body).digest("hex");
console.log(`patched ${file}`);
console.log(`before=${sha}`);
console.log(`after=${patchedSha}`);
