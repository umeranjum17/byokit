// Just enough typing for the Noise and libsodium packages the link uses (they ship none).
declare module 'noise-handshake' { const Noise: any; export default Noise; }
declare module 'noise-handshake/cipher.js' { const Cipher: any; export default Cipher; }
declare module 'noise-handshake/dh.js' {
  const dh: { generateKeyPair(secretKey?: Uint8Array): { publicKey: Uint8Array; secretKey: Uint8Array } };
  export default dh;
}
declare module 'sodium-universal' { const sodium: any; export default sodium; }
declare module 'sodium-javascript' { const sodium: any; export default sodium; }
