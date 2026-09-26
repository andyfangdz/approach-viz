import * as Comlink from 'comlink';
import { RGBELoader } from 'three-stdlib';

export interface DecodedHdr {
  /** Half-float RGBA texels, row 0 at the top of the image. */
  data: Uint16Array;
  width: number;
  height: number;
}

export class HdrWorkerApi {
  /**
   * Fetch and decode a Radiance `.hdr` image with the same loader drei uses,
   * so RGBE parsing and the half-float conversion stay off the main thread.
   */
  async decode(url: string): Promise<DecodedHdr> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HDR environment request failed (${response.status}).`);
    const parsed = new RGBELoader().parse(await response.arrayBuffer());
    if (!(parsed.data instanceof Uint16Array)) {
      throw new Error('RGBELoader did not produce half-float texels.');
    }
    const decoded: DecodedHdr = { data: parsed.data, width: parsed.width, height: parsed.height };
    // SAFETY: RGBELoader allocates the half-float texels over a fresh ArrayBuffer.
    return Comlink.transfer(decoded, [decoded.data.buffer as ArrayBuffer]);
  }
}

Comlink.expose(new HdrWorkerApi());
