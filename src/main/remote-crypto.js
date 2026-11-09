import crypto from 'node:crypto';
import { wrapTcpSocket } from './remote-transport.js';

// Wire protocol for Orion remote control (desktop ↔ desktop).
//
// Security model
// - Pairing: the host displays a short-lived, single-use 10-character code
//   and also requires a Durango account proof for its own account. Both
//   sides run an ephemeral X25519 exchange and prove knowledge of the code
//   by MACing the handshake transcript, so a man-in-the-middle without the
//   code cannot complete either confirmation.
//   Success mints a 256-bit per-device secret that both sides store.
// - Sessions: the same handshake, keyed by the stored device secret instead
//   of a pairing code. Ephemeral keys give forward secrecy; the transcript
//   MAC authenticates both ends and binds the derived keys to this exact
//   connection.
// - Transport: AES-256-GCM with independent keys per direction and strictly
//   incrementing counter nonces — no reuse, no replay, no reordering (ordered
//   byte stream + counter checks; any mismatch kills the connection).
//
// The bytes below travel over a transport (remote-transport.js): a direct TCP
// socket, or a relay WebSocket. Which one is in use changes nothing here — an
// untrusted relay sees exactly what a passive network attacker on the LAN path
// sees, and gets exactly as far.

export const REMOTE_PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const HKDF_INFO = 'orion-remote-control-v1';
const GCM_TAG_BYTES = 16;
const COUNTER_BYTES = 8;

export const createEphemeralKeyPair = () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  return {
    privateKey,
    publicDer: publicKey.export({ type: 'spki', format: 'der' }),
  };
};

export const handshakeTranscript = (helloRaw, helloAckRaw) =>
  crypto.createHash('sha256').update(helloRaw).update(helloAckRaw).digest();

/**
 * Derive the per-direction transport keys and the confirmation MAC key from
 * the ECDH shared secret and the pre-shared key (pairing code or stored
 * device secret). Mixing the PSK into the KDF means a handshake only
 * completes when BOTH ends hold it — the transcript salt binds the output to
 * these exact ephemeral keys.
 */
export const deriveHandshakeKeys = ({ privateKey, peerPublicDer, psk, transcript, isClient }) => {
  const peerKey = crypto.createPublicKey({
    key: peerPublicDer,
    format: 'der',
    type: 'spki',
  });
  if (peerKey.asymmetricKeyType !== 'x25519') {
    throw new Error('Unexpected key type in handshake.');
  }
  const shared = crypto.diffieHellman({ privateKey, publicKey: peerKey });
  const ikm = Buffer.concat([shared, psk]);
  const okm = Buffer.from(crypto.hkdfSync('sha256', ikm, transcript, HKDF_INFO, 96));
  const keyClientToServer = okm.subarray(0, 32);
  const keyServerToClient = okm.subarray(32, 64);
  const macKey = okm.subarray(64, 96);
  return {
    sendKey: isClient ? keyClientToServer : keyServerToClient,
    recvKey: isClient ? keyServerToClient : keyClientToServer,
    macKey,
  };
};

export const confirmationMac = (macKey, label, transcript) =>
  crypto.createHmac('sha256', macKey).update(label).update(transcript).digest();

export const macsEqual = (a, b) => {
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b) || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
};

const nonceForCounter = (counter) => {
  const nonce = Buffer.alloc(12);
  nonce.writeBigUInt64BE(counter, 4);
  return nonce;
};

/**
 * Length-prefixed JSON frames over a transport. Starts in plaintext (the two
 * handshake messages carry only ephemeral public keys and nonces); after
 * `enableEncryption` every frame is AES-256-GCM sealed with the direction's
 * key and a counter nonce, and the receive counter is enforced strictly.
 *
 * Handlers receive (message, rawPayload) — the raw bytes feed the handshake
 * transcript hash.
 *
 * Accepts either a transport from remote-transport.js or a bare net.Socket,
 * which is wrapped on the spot — every call site that used to pass a socket
 * keeps working, and `.socket` still exposes it.
 */
export class SecureChannel {
  constructor(transport, { maxFrame = MAX_FRAME_BYTES } = {}) {
    this.transport = typeof transport?.onData === 'function' ? transport : wrapTcpSocket(transport);
    // Direct-TCP callers reach through to the raw socket (tests, diagnostics);
    // null on transports that have no socket of their own.
    this.socket = this.transport.socket ?? null;
    this.maxFrame = maxFrame;
    this.buffer = Buffer.alloc(0);
    this.sendKey = null;
    this.recvKey = null;
    this.sendCounter = 0n;
    this.recvCounter = 0n;
    this.closed = false;
    this.closeError = null;
    this.messageHandler = null;
    this.closeHandler = null;

    this.transport.onData((chunk) => this.#onData(chunk));
    this.transport.onClose((error) => this.#onClose(error));
  }

  onMessage(handler) {
    this.messageHandler = handler;
  }

  onClose(handler) {
    this.closeHandler = handler;
    if (this.closed) handler(this.closeError);
  }

  get encrypted() {
    return this.sendKey !== null;
  }

  enableEncryption({ sendKey, recvKey }) {
    this.sendKey = Buffer.from(sendKey);
    this.recvKey = Buffer.from(recvKey);
    this.sendCounter = 0n;
    this.recvCounter = 0n;
  }

  /**
   * Raise (or lower) the frame budget. Callers keep this small until the peer
   * is authenticated, so an anonymous connection cannot make the process
   * buffer megabytes on demand.
   */
  setMaxFrame(bytes) {
    this.maxFrame = bytes;
  }

  /** Send a frame; returns the raw payload bytes (for the transcript hash). */
  send(message) {
    if (this.closed) return null;
    const json = Buffer.from(JSON.stringify(message), 'utf8');
    let payload = json;
    if (this.sendKey) {
      const counter = this.sendCounter;
      this.sendCounter += 1n;
      const cipher = crypto.createCipheriv('aes-256-gcm', this.sendKey, nonceForCounter(counter));
      const encrypted = Buffer.concat([cipher.update(json), cipher.final()]);
      const counterBuf = Buffer.alloc(COUNTER_BYTES);
      counterBuf.writeBigUInt64BE(counter);
      payload = Buffer.concat([counterBuf, encrypted, cipher.getAuthTag()]);
    }
    if (payload.length > this.maxFrame) {
      this.destroy(new Error('Frame too large to send.'));
      return null;
    }
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.length);
    this.transport.write(Buffer.concat([header, payload]));
    return payload;
  }

  destroy(error) {
    if (this.closed) return;
    this.transport.destroy(error);
    this.#onClose(error);
  }

  close() {
    if (this.closed) return;
    this.transport.close();
  }

  #onClose(error) {
    if (this.closed) return;
    this.closed = true;
    this.closeError = error ?? null;
    this.closeHandler?.(this.closeError);
  }

  #onData(chunk) {
    if (this.closed) return;
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    while (!this.closed && this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length === 0 || length > this.maxFrame) {
        this.destroy(new Error('Invalid frame length.'));
        return;
      }
      if (this.buffer.length < 4 + length) return;
      const payload = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      this.#onFrame(payload);
    }
  }

  #onFrame(payload) {
    let json = payload;
    if (this.recvKey) {
      if (payload.length < COUNTER_BYTES + GCM_TAG_BYTES) {
        this.destroy(new Error('Frame too short.'));
        return;
      }
      const counter = payload.readBigUInt64BE(0);
      if (counter !== this.recvCounter) {
        // Replayed, dropped, or reordered frame — unrecoverable by design.
        this.destroy(new Error('Frame counter mismatch.'));
        return;
      }
      this.recvCounter += 1n;
      const ciphertext = payload.subarray(COUNTER_BYTES, payload.length - GCM_TAG_BYTES);
      const tag = payload.subarray(payload.length - GCM_TAG_BYTES);
      try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', this.recvKey, nonceForCounter(counter));
        decipher.setAuthTag(tag);
        json = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      } catch {
        this.destroy(new Error('Frame authentication failed.'));
        return;
      }
    }
    let message;
    try {
      message = JSON.parse(json.toString('utf8'));
    } catch {
      this.destroy(new Error('Malformed frame.'));
      return;
    }
    if (!message || typeof message !== 'object') {
      this.destroy(new Error('Malformed frame.'));
      return;
    }
    try {
      this.messageHandler?.(message, payload);
    } catch (error) {
      this.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

// Pairing codes avoid ambiguous characters (0/O, 1/I/L): 10 symbols over a
// 30-character alphabet (~49 bits), shown as two groups of five so they are
// easy to read out and type. The code is one factor of two: the host also
// requires a fresh Durango account proof for its own account, caps failed
// attempts (PAIRING_MAX_ATTEMPTS) and expires the code after 10 minutes.
const PAIRING_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
export const PAIRING_CODE_LENGTH = 10;

export const generatePairingCode = () => {
  let code = '';
  for (let index = 0; index < PAIRING_CODE_LENGTH; index += 1) {
    if (index === PAIRING_CODE_LENGTH / 2) code += '-';
    code += PAIRING_ALPHABET[crypto.randomInt(PAIRING_ALPHABET.length)];
  }
  return code;
};

export const normalizePairingCode = (value) =>
  String(value ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

export const pairingCodeToPsk = (code) =>
  crypto.createHash('sha256').update(`orion-pairing:${normalizePairingCode(code)}`).digest();
