import crypto from 'node:crypto';

// The keys a bot's chat seals a request_secret value to (Durango's
// botThreadRequests: answering a bot-started thread's secret card from the
// bot's chat on another device). One P-256 key pair per request, made when
// the request is first synced and kept only in this process's memory: the
// public key goes to Durango with the request, the private key never leaves
// this machine. The envelope (sealed by src/app/botSecretSeal.ts here and by
// Durango's web and iOS apps): {"v":1,"epk","iv","ct"} in base64, with
// ECDH P-256 → HKDF-SHA256 (info "durango-bot-secret-v1:<request id>") →
// AES-256-GCM (additional data: the request id).

const INFO_PREFIX = 'durango-bot-secret-v1:';
const MAX_KEYS = 200;

export const createBotSecretKeys = () => {
  const keys = new Map(); // request id -> { ecdh, publicKey }

  return {
    /** This request's public key (base64 raw point), made on first use. */
    publicKeyFor(requestId) {
      const id = String(requestId ?? '');
      if (!id) return null;
      let entry = keys.get(id);
      if (!entry) {
        const ecdh = crypto.createECDH('prime256v1');
        ecdh.generateKeys();
        entry = { ecdh, publicKey: ecdh.getPublicKey('base64', 'uncompressed') };
        keys.set(id, entry);
        while (keys.size > MAX_KEYS) keys.delete(keys.keys().next().value);
      }
      return entry.publicKey;
    },
    /**
     * A request's value was used: its key opens nothing more (it keeps its
     * public key until the request leaves the set, so the row doesn't look
     * re-keyed meanwhile).
     */
    spend(requestId) {
      const entry = keys.get(String(requestId ?? ''));
      if (!entry) return;
      entry.spent = true;
      // Its private key isn't needed any more: let it go now.
      entry.ecdh = null;
    },
    /** Forget the keys of requests no longer pending (their values can't be opened after). */
    keepOnly(requestIds) {
      const keep = new Set(requestIds);
      for (const id of [...keys.keys()]) if (!keep.has(id)) keys.delete(id);
    },
    /** The value sealed to this request's key, or throws. */
    open(requestId, sealed) {
      const id = String(requestId ?? '');
      const entry = keys.get(id);
      if (!entry) throw new Error('Durango Code restarted before it got the value: enter it again.');
      if (entry.spent) throw new Error('That request already has its value.');
      const envelope = JSON.parse(String(sealed ?? ''));
      if (envelope?.v !== 1) throw new Error('Unknown sealed value.');
      const shared = entry.ecdh.computeSecret(Buffer.from(String(envelope.epk), 'base64'));
      const key = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.from(`${INFO_PREFIX}${id}`), 32));
      const data = Buffer.from(String(envelope.ct), 'base64');
      if (data.length < 17) throw new Error('The sealed value is cut short.');
      const iv = Buffer.from(String(envelope.iv), 'base64');
      if (iv.length !== 12) throw new Error('The sealed value has a bad nonce.');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(Buffer.from(id));
      decipher.setAuthTag(data.subarray(data.length - 16));
      return Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]).toString('utf8');
    },
  };
};
