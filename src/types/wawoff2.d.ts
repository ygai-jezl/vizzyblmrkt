// wawoff2 (MIT) ships no types. We only use decompress: WOFF2 bytes in, TTF/OTF bytes out.
declare module "wawoff2" {
  export function decompress(buffer: Uint8Array): Promise<Uint8Array>;
  export function compress(buffer: Uint8Array): Promise<Uint8Array>;
}
