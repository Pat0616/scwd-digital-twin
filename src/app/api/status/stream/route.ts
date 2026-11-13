import { watchStatus, type WatchEvent } from "@/lib/status/watch";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEARTBEAT_MS = 20_000;

/**
 * Server-Sent Events: the map's live status, pushed whenever the twin changes (checked every few seconds).
 * Events: "status" (the full status, on connect and on every change), "checked" (each check, for the badge),
 * "twin-error" (the twin could not be read; the browser keeps what it has).
 */
export async function GET(req: Request) {
  const enc = new TextEncoder();
  let stop = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunk: string) => { try { controller.enqueue(enc.encode(chunk)); } catch { stop(); } };
      const unsubscribe = watchStatus((e: WatchEvent) => {
        if (e.type === "status") send(`event: status\ndata: ${JSON.stringify({ version: e.status.version, status: e.status.body })}\n\n`);
        if (e.type === "checked") send(`event: checked\ndata: ${JSON.stringify({ fetchedAt: e.fetchedAt })}\n\n`);
        if (e.type === "error") send(`event: twin-error\ndata: {}\n\n`);
      });
      const beat = setInterval(() => send(`: keep-alive\n\n`), HEARTBEAT_MS);
      stop = () => {
        clearInterval(beat);
        unsubscribe();
        try { controller.close(); } catch { /* already closed */ }
      };
      req.signal.addEventListener("abort", () => stop());
    },
    cancel() { stop(); },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // no gzip (it would buffer the events) and no proxy buffering
      "Content-Encoding": "none",
      "X-Accel-Buffering": "no",
    },
  });
}
