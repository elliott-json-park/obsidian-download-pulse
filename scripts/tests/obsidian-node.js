// The parts of `obsidian` the data layer touches, for running the tests in Node.
// requestUrl answers from `globalThis.__routes`: { [urlPrefix]: (url) => ({ status, json }) }.

export class Events {
  constructor() { this._ev = {}; }
  on(name, fn) { (this._ev[name] ??= []).push(fn); return { e: this, name, fn }; }
  offref(ref) { this._ev[ref.name] = (this._ev[ref.name] ?? []).filter((f) => f !== ref.fn); }
  trigger(name, ...a) { for (const f of [...(this._ev[name] ?? [])]) f(...a); }
}
export const Platform = { isMobile: false };
export const getLanguage = () => "en";

export const requests = [];
export async function requestUrl(req) {
  const url = typeof req === "string" ? req : req.url;
  requests.push(url);
  for (const [prefix, fn] of Object.entries(globalThis.__routes ?? {})) {
    if (url.startsWith(prefix)) {
      const r = fn(url);
      return { status: r.status ?? 200, json: r.json ?? null, text: JSON.stringify(r.json ?? null), headers: {} };
    }
  }
  return { status: 404, json: null, text: "", headers: {} };
}
