/** A new turn invalidates unfinished tools and output from the prior turn. */
export function responseFence() {
  let controller = new AbortController(), id: string | undefined, fenced = false;
  const retired = new Set<string>();
  const interrupt = () => { controller.abort(); if (id) { retired.add(id); if (retired.size > 128) retired.delete(retired.values().next().value!); } fenced = true; };
  return {
    interrupt,
    begin(next?: string) {
      if (next && (retired.has(next) || next === id && !fenced)) return false;
      interrupt(); controller = new AbortController(); id = next; fenced = false; return true;
    },
    accepts(next?: string) { return !fenced && (!next || !id || next === id) && (!next || !retired.has(next)); },
    get signal() { return controller.signal; },
  };
}
