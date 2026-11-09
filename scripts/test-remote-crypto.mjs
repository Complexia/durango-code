// Exercises the remote-control wire protocol end to end over real sockets:
// handshake key agreement, mutual confirmation, encrypted frames, replay and
// tamper rejection, and PSK mismatch failure. Run with: node scripts/test-remote-crypto.mjs
import net from 'node:net';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {
  REMOTE_PROTOCOL_VERSION,
  SecureChannel,
  confirmationMac,
  createEphemeralKeyPair,
  deriveHandshakeKeys,
  generatePairingCode,
  handshakeTranscript,
  macsEqual,
  normalizePairingCode,
  pairingCodeToPsk,
} from '../src/main/remote-crypto.js';

const socketPair = () =>
  new Promise((resolve) => {
    const server = net.createServer((serverSocket) => {
      server.close();
      resolve({ serverSocket, clientSocket });
    });
    let clientSocket;
    server.listen(0, '127.0.0.1', () => {
      clientSocket = net.connect(server.address().port, '127.0.0.1');
    });
  });

/** Full client/server handshake over a real socket pair; returns both channels. */
const handshake = async ({ clientPsk, serverPsk }) => {
  const { serverSocket, clientSocket } = await socketPair();
  const client = new SecureChannel(clientSocket);
  const server = new SecureChannel(serverSocket);

  const result = await new Promise((resolve) => {
    let clientKeys = null;
    let serverKeys = null;
    let clientTranscript = null;
    let serverTranscript = null;
    let helloRaw = null;
    const clientEph = createEphemeralKeyPair();
    const serverEph = createEphemeralKeyPair();
    const done = { clientOk: false, serverOk: false };
    const finish = (failure) => resolve(failure ?? (done.clientOk && done.serverOk ? null : 'incomplete'));

    server.onMessage((message, raw) => {
      if (message.t === 'hello') {
        const ackRaw = server.send({
          t: 'helloAck',
          v: REMOTE_PROTOCOL_VERSION,
          pub: serverEph.publicDer.toString('base64'),
          nonce: crypto.randomBytes(16).toString('base64'),
        });
        serverTranscript = handshakeTranscript(raw, ackRaw);
        serverKeys = deriveHandshakeKeys({
          privateKey: serverEph.privateKey,
          peerPublicDer: Buffer.from(message.pub, 'base64'),
          psk: serverPsk,
          transcript: serverTranscript,
          isClient: false,
        });
        return;
      }
      if (message.t === 'confirm') {
        const expected = confirmationMac(serverKeys.macKey, 'client', serverTranscript);
        if (!macsEqual(expected, Buffer.from(message.mac, 'base64'))) {
          finish('server-rejected-client');
          return;
        }
        server.send({
          t: 'confirm',
          mac: confirmationMac(serverKeys.macKey, 'server', serverTranscript).toString('base64'),
        });
        server.enableEncryption(serverKeys);
        done.serverOk = true;
        if (done.clientOk) finish();
      }
    });

    client.onMessage((message, raw) => {
      if (message.t === 'helloAck') {
        clientTranscript = handshakeTranscript(helloRaw, raw);
        clientKeys = deriveHandshakeKeys({
          privateKey: clientEph.privateKey,
          peerPublicDer: Buffer.from(message.pub, 'base64'),
          psk: clientPsk,
          transcript: clientTranscript,
          isClient: true,
        });
        client.send({
          t: 'confirm',
          mac: confirmationMac(clientKeys.macKey, 'client', clientTranscript).toString('base64'),
        });
        return;
      }
      if (message.t === 'confirm') {
        const expected = confirmationMac(clientKeys.macKey, 'server', clientTranscript);
        if (!macsEqual(expected, Buffer.from(message.mac, 'base64'))) {
          finish('client-rejected-server');
          return;
        }
        client.enableEncryption(clientKeys);
        done.clientOk = true;
        if (done.serverOk) finish();
      }
    });

    clientSocket.on('connect', () => {});
    helloRaw = client.send({
      t: 'hello',
      v: REMOTE_PROTOCOL_VERSION,
      mode: 'session',
      deviceId: 'test-device',
      pub: clientEph.publicDer.toString('base64'),
      nonce: crypto.randomBytes(16).toString('base64'),
    });
    setTimeout(() => finish('timeout'), 3000);
  });

  return { client, server, failure: result };
};

// 1. Matching PSKs: handshake completes, encrypted frames flow both ways.
{
  const psk = crypto.randomBytes(32);
  const { client, server, failure } = await handshake({ clientPsk: psk, serverPsk: psk });
  assert.equal(failure, null, `handshake should succeed, got ${failure}`);

  const received = new Promise((resolve) => server.onMessage((message) => resolve(message)));
  client.send({ t: 'ping', payload: 'x'.repeat(10_000) });
  const message = await received;
  assert.equal(message.t, 'ping');
  assert.equal(message.payload.length, 10_000);

  const echoed = new Promise((resolve) => client.onMessage((message2) => resolve(message2)));
  server.send({ t: 'pong' });
  assert.equal((await echoed).t, 'pong');
  client.destroy();
  server.destroy();
  console.log('ok  encrypted round trip');
}

// 2. Mismatched PSKs (wrong pairing code): the server must reject the client's
// confirmation — and the derived keys must differ.
{
  const { client, server, failure } = await handshake({
    clientPsk: pairingCodeToPsk('AAAA-BBBB-CCCC-DDDD'),
    serverPsk: pairingCodeToPsk('AAAA-BBBB-CCCC-DDDX'),
  });
  assert.equal(failure, 'server-rejected-client');
  client.destroy();
  server.destroy();
  console.log('ok  wrong code rejected');
}

// 3. Tampered ciphertext kills the channel.
{
  const psk = crypto.randomBytes(32);
  const { client, server, failure } = await handshake({ clientPsk: psk, serverPsk: psk });
  assert.equal(failure, null);
  const closed = new Promise((resolve) => server.onClose((error) => resolve(error)));
  // Bypass the channel: write a corrupted frame straight to the socket.
  const bogus = Buffer.alloc(4 + 8 + 32 + 16);
  bogus.writeUInt32BE(8 + 32 + 16, 0);
  client.socket.write(bogus);
  const error = await closed;
  assert.ok(error, 'server should destroy the channel on tampered frames');
  client.destroy();
  server.destroy();
  console.log('ok  tampered frame rejected');
}

// 4. Replay rejection: duplicate an encrypted frame at the TCP level.
{
  const psk = crypto.randomBytes(32);
  const { client, server, failure } = await handshake({ clientPsk: psk, serverPsk: psk });
  assert.equal(failure, null);
  let firstFrame = null;
  const origWrite = client.socket.write.bind(client.socket);
  client.socket.write = (buf) => {
    if (!firstFrame) firstFrame = Buffer.from(buf);
    return origWrite(buf);
  };
  const got = new Promise((resolve) => server.onMessage((message) => resolve(message)));
  client.send({ t: 'ping' });
  await got;
  const closed = new Promise((resolve) => server.onClose(() => resolve(true)));
  origWrite(firstFrame); // replay the exact same frame
  assert.ok(await closed, 'replayed frame must kill the channel');
  client.destroy();
  server.destroy();
  console.log('ok  replayed frame rejected');
}

// 5. A close that lands between handshake completion and the caller's next
// handler registration must be replayed at that handoff.
{
  let emitClose;
  const transport = {
    socket: null,
    onData: () => {},
    onClose: (handler) => {
      emitClose = handler;
    },
    write: () => {},
    destroy: () => {},
    close: () => {},
  };
  const channel = new SecureChannel(transport);
  const closeError = new Error('closed during handler handoff');
  emitClose(closeError);
  let replayedError;
  channel.onClose((error) => {
    replayedError = error;
  });
  assert.equal(channel.closed, true);
  assert.equal(replayedError, closeError);
  console.log('ok  channel close replays to late subscribers');
}

// 6. Pairing code utilities.
{
  const code = generatePairingCode();
  assert.match(code, /^[A-HJKMNP-TV-Z2-9]{5}-[A-HJKMNP-TV-Z2-9]{5}$/);
  assert.equal(normalizePairingCode(` ${code.toLowerCase().replace('-', ' ')} `), code.replace('-', ''));
  assert.ok(macsEqual(pairingCodeToPsk(code), pairingCodeToPsk(code.toLowerCase())));
  assert.ok(!macsEqual(pairingCodeToPsk(code), pairingCodeToPsk(generatePairingCode())));
  console.log('ok  pairing code normalization');
}

console.log('All remote-crypto tests passed.');
process.exit(0);
