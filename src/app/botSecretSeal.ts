/**
 * Seals a request_secret value for the machine its thread runs on, in the
 * browser (WebCrypto): ECDH P-256 with a fresh key, HKDF-SHA256, AES-256-GCM
 * (the same envelope Durango's web and iOS apps send). Durango stores only the
 * sealed string; the machine's private key for that request opens it
 * (src/main/bot-secret-keys.js).
 */
const INFO_PREFIX = "durango-bot-secret-v1:";

const encode = (text: string) => new TextEncoder().encode(text);

function toBase64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (let index = 0; index < view.length; index += 0x8000) binary += String.fromCharCode(...view.subarray(index, index + 0x8000));
  return btoa(binary);
}

function fromBase64(value: string) {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** The value sealed to `publicKey` (base64 raw P-256 point) for request `requestId`. */
export async function sealBotSecret(publicKey: string, requestId: string, value: string): Promise<string> {
  const subtle = globalThis.crypto.subtle;
  const machineKey = await subtle.importKey("raw", fromBase64(publicKey), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ephemeral = (await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const shared = await subtle.deriveBits({ name: "ECDH", public: machineKey }, ephemeral.privateKey, 256);
  const hkdf = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const key = await subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: encode(`${INFO_PREFIX}${requestId}`) },
    hkdf,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: "AES-GCM", iv, additionalData: encode(requestId) }, key, encode(value));
  const epk = await subtle.exportKey("raw", ephemeral.publicKey);
  return JSON.stringify({ v: 1, epk: toBase64(epk), iv: toBase64(iv), ct: toBase64(ct) });
}
