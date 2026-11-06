/**
 * Extract the Alobo web app's runtime config (API base URL, response key, request-signing salt)
 * from its public Flutter bundle `main.dart.js`, without executing any JavaScript.
 *
 * The app builds one env-config object per environment: `new A.<cls>($.a(),$.b(),...)` with ~24
 * obfuscated getters. Each getter returns `left[i] ^ right[i]` over two int tables. Minified class
 * names change on every frontend build, so the config calls are found by shape and the one whose
 * base URL (arg 8) is the production API is used. Arg 5 is the response key, arg 18 the salt.
 */

import { API_URL, WEB_URL } from "./client.ts";

const ARG_BASE_URL = 8;
const ARG_RESPONSE_KEY = 5;
const ARG_APP_SALT = 18;
const CHANGED = "frontend config structure changed; inspect the new bundle";

export interface ExtractedRuntime {
  base_url: string;
  response_key: string;
  app_salt: string;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function intTable(bundle: string, name: string): number[] {
  const found = new RegExp(`B\\.${escapeRegExp(name)}=s\\((\\[[^\\]]+\\])`).exec(bundle);
  if (!found) throw new Error(CHANGED);
  const values: unknown = JSON.parse(found[1]!);
  if (!Array.isArray(values) || !values.every(Number.isInteger)) throw new Error("frontend config table is invalid");
  return values as number[];
}

/** Decode one obfuscated getter (`$.name()`) into its string value. */
export function decodeGetter(bundle: string, getter: string): string {
  const start = bundle.indexOf(`"${getter}",()=>`);
  if (start < 0) throw new Error(CHANGED);
  const callback = /new A\.([\w$]+)\(\)/.exec(bundle.slice(start, start + 250));
  if (!callback) throw new Error(CHANGED);
  const proto = bundle.indexOf(`A.${callback[1]}.prototype={`);
  const pair = proto < 0 ? null : /B\.([\w$]+)\[a\]\^B\.([\w$]+)\[a\]/.exec(bundle.slice(proto, proto + 180));
  if (!pair) throw new Error(CHANGED);

  const left = intTable(bundle, pair[1]!);
  const right = intTable(bundle, pair[2]!);
  if (left.length === 0 || left.length !== right.length) throw new Error(CHANGED);
  const value = String.fromCharCode(...left.map((a, i) => a ^ right[i]!));
  if (!/^[\x20-\x7e]+$/.test(value)) throw new Error("frontend config decoded an invalid value");
  return value;
}

export function extractRuntime(bundle: string): ExtractedRuntime {
  const calls = [...bundle.matchAll(/new A\.[\w$]+\(((?:\$\.[\w$]+\(\),?){15,})\)/g)];
  if (calls.length === 0) throw new Error(CHANGED);

  for (const call of calls) {
    const getters = [...call[1]!.matchAll(/\$\.([\w$]+)\(\)/g)].map((m) => m[1]!);
    if (getters.length <= ARG_APP_SALT) continue;
    let baseUrl: string;
    try {
      baseUrl = decodeGetter(bundle, getters[ARG_BASE_URL]!);
    } catch {
      continue;
    }
    if (baseUrl !== API_URL) continue;
    return {
      base_url: baseUrl,
      response_key: decodeGetter(bundle, getters[ARG_RESPONSE_KEY]!),
      app_salt: decodeGetter(bundle, getters[ARG_APP_SALT]!),
    };
  }
  throw new Error(`${CHANGED} (no env config points to ${API_URL})`);
}

export function validateRuntime(runtime: ExtractedRuntime): void {
  if (runtime.base_url !== API_URL) throw new Error(`unexpected base_url ${runtime.base_url}`);
  if (new TextEncoder().encode(runtime.response_key).length !== 32) throw new Error("response_key is not 32 bytes");
  if (!runtime.app_salt) throw new Error("app_salt is empty");
}

export interface FetchedRuntime extends ExtractedRuntime {
  version: string;
}

/** Download the live frontend and extract its runtime. Fails if Alobo deploys while downloading. */
export async function fetchRuntime(fetchFn: typeof fetch = fetch): Promise<FetchedRuntime> {
  const get = async (url: string) => {
    const res = await fetchFn(url, { headers: { "cache-control": "no-cache" } });
    if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
    return res;
  };
  const liveVersion = async () => ((await (await get(`${WEB_URL}/version.json`)).json()) as { version?: string }).version;

  const version = await liveVersion();
  if (!version) throw new Error("version.json has no version");
  const bundle = await (await get(`${WEB_URL}/main.dart.js`)).text();
  if ((await liveVersion()) !== version) throw new Error("Alobo deployed a new frontend while fetching; retry in a few minutes");

  const runtime = { version, ...extractRuntime(bundle) };
  validateRuntime(runtime);
  return runtime;
}
