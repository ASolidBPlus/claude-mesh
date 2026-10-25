// Reading a request body with a running cap, before anything else looks at it. A declared
// content-length over the cap is refused unread; a body sent without one (chunked) is counted as
// it arrives and the read stops at the cap, so no caller, checked or not, can make an app buffer
// more than `max` bytes. The bridge's and every app door's first step (W-1441).
export async function readBody(req: Request, max: number): Promise<Uint8Array | null> {
  const declared = req.headers.get('content-length');
  if (declared !== null && Number(declared) > max) return null;
  if (req.body === null) return new Uint8Array();
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
