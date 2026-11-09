# Remote control

Drive one Orion instance from another. If machine **A** enables remote control
and pairs with machine **B**, then B can view and drive A's workspace — A's
projects and threads, with turns actually running on A. The
relationship is one-directional per pairing: B controlling A grants A nothing,
unless A separately pairs the other way.

Off by default. While it is off, nothing listens and nothing connects.

## Using it

**On the machine to be controlled (the host):** Settings → Remote Control →
enable *Remote control*. Press **Generate code** and note the 10-character code
(on your own network only, also the address and port shown next to it).
Enabling remote control implies the machine may be controlled — there
is no separate "allow incoming" switch in the UI; pairing codes are what gate
every actual connection. (The engine still honors
`remoteControlSettings.allowIncoming`, which the UI keeps in lockstep with
`enabled`.)

**On the controlling machine:** Settings → Remote Control → enable *Remote
control*, then under "Machines you can control" enter the pairing code and
press **Pair**. Over the internet the code is all it takes: the controller asks
Durango Cloud for this account's machines that are online at the relay
(`GET /api/relay/devices`) and offers the code to each until one accepts
(`pairByCode` in `remote-control.js`; machines it hasn't paired with first).
A machine without an active code fails the handshake at no cost to it. On
your own network only, enter the host's address and port as well.

**Running agents there.** Once a machine is paired, a machine picker appears
above the prompt box, left of the branch picker. Pick the machine before a
thread's first message; the thread then runs there for good (the picker only
shows where). The thread stays in this machine's sidebar like any other, with
the machine's name on its third line and in its hover card. Its first turn
finds the project on the host: its Durango Source repository there (cloned if
the host lacks it, `checkoutSource`), else a project of the same name or
folder (`remote:resolveProject` in `main.js`). Turns start with
`runTurn` (model, access, effort as set in the prompt box); Stop sends
`stopTurn`; follow-ups typed while it runs queue here and go out when it ends.
The transcript is a mirror of the host's copy (`Thread.remote` in `store.ts`,
`src/app/useRemoteThreadSync.ts`): it refreshes on the host's push events, with
a slow poll while running, for threads open here only (the machine listing
keeps the rest current). Desktop controllers tell each host which threads they
show (`follow`): streamed text and tool activity are forwarded only for those,
run/question/done events to every controller; a client that never sends
`follow` (app.durango.sh) gets everything. Each fetch names the version it has
(`knownVersion`, the host's threads-index hash) and an unchanged thread is not
sent again. The thread's model, access and effort follow the host's
(`remote.hostSettings`) unless changed here; a turn sends only the settings
changed here, so a stale value here never overrides a change made there. Stop
puts queued follow-ups back in the composer; if the host can't be reached the
thread is marked stopped here. Branching such a thread isn't supported yet.
Mirrors are not synced to Durango (workspace sync skips them; the host syncs
its own threads).

**The host's own threads.** While remote control is on, every paired machine
is kept connected, and each connected machine's threads are listed in this
machine's sidebar like local ones (`remote:listThreads` → store
`syncRemoteMachineThreads`): filed under the local project with the same
Durango Source repository (the host's snapshot carries repo ids), else the same
name or folder, else No project labeled with the host's project name. They are
listed again after the host's `workspaceChanged` events and every minute;
opening one fetches its transcript. A thread the host deletes leaves the list
(after two listings without it; an empty listing removes nothing);
deleting one here only hides it here (the host keeps it). The host's untouched
drafts and threads that are themselves mirrors are not listed.

**Attachments.** A turn's files are uploaded to the host first
(`attachmentUpload`, 3 MiB chunks, 100 MB per file) into its attachment folder,
and the turn names them by upload id, so the host's agent gets them exactly
like files attached there. The mirror shows this machine's own copies; the
host's other attachments are fetched once into
`<attachments>/remote/` (`attachmentRead`, which serves only files in the
host's attachment folder).

**Questions and user actions.** A host thread's pending agent questions and
approvals (`questions`, from main's pending Codex and Claude requests) and its
"Needs you" actions (`userActions`, mirrored with the thread) show here and are
answered here. `answerQuestion` and `userAction` run on the host through the
same handlers as its own cards (renderer remote commands, atomically claimed);
a Reply's files upload first. The local check-watcher never runs a mirrored
action's `check`: Watch toggles it on the host. The host snapshot says which
threads wait on a question or action, so the sidebar shows "Needs you" for
them.

**Branch.** In place of this machine's branch picker, a thread on another
machine shows where it works there: its Durango workspace and branch, and a
dot for uncommitted changes (`threadGit`, refreshed after host events). Read
only.

Both machines must be signed in to the **same Orion account** the whole time.
Signing out on either end drops every session immediately and stops the
listener.

## Connection modes

*Connect over the internet* (`remoteControlSettings.connectionMode`)
picks how the two machines find each other. It changes nothing about the
encryption, the authentication, or what a controller may do.

| Mode | What happens |
|---|---|
| **Off** — `'direct'` (default) | The host binds a local TCP listener (default port 47615) and the controller dials an address you type. LAN, VPN, or Tailscale. Nothing leaves your network: the engine makes **zero** requests to Orion Cloud's relay, and never even resolves its URL. |
| **On** — `'relay'` | The host additionally holds an **outbound** WebSocket to Orion Cloud's relay and controllers find it by its pairing code, then reach it by machine ID. No port forwarding, no inbound firewall rule, no NAT traversal. The host keeps listening locally too. |

In internet mode, the host registers itself (`POST /api/relay/devices`) and
mints a short-lived relay ticket per socket (`POST /api/relay/ticket`), both
authenticated with the desktop account token. Settings shows whether the
machine is currently online at the relay. The control socket carries a
liveness watchdog: the relay pings every 30 seconds, and 75 seconds with no
inbound frame is treated as a half-open socket (sleep/wake, NAT rebind) — the
listener tears it down and reconnects with backoff instead of reporting a dead
connection as online.

Turning internet mode **off does not deregister** the machine: it stays in the
account's machine list at Orion Cloud and shows as offline, so controllers'
lists stay stable. The explicit **Remove from Orion Cloud** action in Settings
(`remote:relayDeregister` → `DELETE /api/relay/devices/:machineId`) is what
deletes the registration; re-enabling internet mode re-registers it (the
listener forgets its cached registration on every stop, so a fresh start
always re-POSTs and revives a soft-deleted row).

**Route choice on the controller** is deliberately boring: direct first when
the machine has a known address, relay second when internet mode is on. No
probing, no racing. A machine paired over the internet has no address stored at
all, so it goes straight to the relay.

## Security model

The protocol lives in `src/main/remote-crypto.js`; the transports it runs over
live in `src/main/remote-transport.js`; the engine and its policy live in
`src/main/remote-control.js`.

**The relay is untrusted, and is not part of the security boundary.** It is a
byte pipe that splices two WebSockets and forwards opaque chunks of the exact
same stream a TCP socket would carry. Every guarantee below is produced by the
two peers and holds unchanged over it: the relay cannot read the traffic,
forge it, replay it, or impersonate either machine. What a hostile relay *can*
do is drop or delay bytes — which is what any network can do. Relay-side
authorization (tickets, machine ownership) is defense in depth on top of that,
never a substitute for it.

Only relay tickets are ever shown to the relay: short-lived, single-socket,
scoped to one machine, and useless as account credentials. The desktop account
bearer token goes to Orion Cloud's API and nowhere else — never to the relay,
never to a peer. A peer only ever receives an account *proof* bound to that
connection's challenge and to the host's machine ID.

Pairing by code knocks on every online machine of the account that is new
enough (`canOfferCodeTo`, by the version it registered with: older hosts would
count the knock against their relay rate limit); on new hosts a pairing
attempt against a machine showing no code never counts toward that limit (it
can't succeed), so mistyped codes don't lock machines out. Projects are matched by Durango Source repository first; a name or folder
match never overrides two different repositories, and the first turn says
which project it runs in there.

**Pairing.** The host shows a single-use 10-character code (`XXXXX-XXXXX`,
~49 bits over a 30-symbol unambiguous alphabet), short enough to type. It is one of two
factors: the host also requires a fresh Durango account proof for its own
account (below), so a code alone pairs nothing. Both sides run an ephemeral
X25519 exchange and derive keys with HKDF-SHA256 over `ECDH-shared-secret || PSK`, salted with
a hash of the full handshake transcript (both raw messages, so protocol
version, mode, and device id are all bound into the keys). Each side then
proves it holds the PSK by MACing the transcript. A man-in-the-middle without
the code cannot produce either confirmation. The code expires after 10 minutes,
is retired the moment one pairing completes, and is cancelled after 5 failed
*confirmations* — connection attempts that never prove anything don't count,
so a stranger cannot burn codes the user generates. Success mints a 256-bit
per-device secret stored on both ends.

The controller confirms first and the host answers only a correct
confirmation, so a fake *controller* gets one guess per connection. A fake
*host* on the path (someone who can intercept the connection: the relay, or an
attacker on the LAN in direct mode) does receive the controller's confirmation
and could search the code space offline (~49 bits: far from instant, and it
would have to finish while the controller's handshake waits), and it would
still need to relay the real host's account challenge through it. That is the
trade made for a code short enough to type (it was 16 characters, ~78 bits); a
PAKE (SPAKE2/CPace) would remove it if it ever matters.

**Sessions.** The same handshake keyed by the stored device secret. Ephemeral
keys per connection give forward secrecy. After the handshake, frames are
AES-256-GCM with independent keys per direction and strictly incrementing
counter nonces — a replayed, reordered, or tampered frame kills the connection
rather than being skipped.

**Account gating.** After the code-authenticated handshake, the host sends a
fresh random account challenge. Orion Cloud mints the controller a short-lived
proof bound to that challenge and the host machine id, then verifies it for the
host. The desktop bearer token never goes to the peer, and a claimed user id is
not treated as authentication. The host compares the verified account with its
own freshly re-checked live session. Session handshakes re-resolve the device
*and* re-check the live account at the confirm step, not just when the
connection opened — so a connection parked mid-handshake cannot outlive a
revoke or a sign-out. Revoking, signing out, or turning the listener off
destroys every inbound connection, handshaking ones included.

**Anti-abuse.** Unauthenticated connections are capped globally (32) and per
source address (6), and are held to a 4 KB frame budget until encryption is up
— the 8 MB budget needed for transcripts is only granted to authenticated
peers. Failed handshakes are rate-limited per IP. Unknown device ids continue
the handshake against a random secret so failures are indistinguishable and
device ids cannot be enumerated. Inbound relay streams enter through the
*identical* code path as accepted TCP sockets, so all of the above applies to
them unchanged; because a relay stream has no meaningful source address they
share a single bucket, which throttles a relay-borne flood like a flood from
one IP. The host also refuses to open more than 12 concurrent relay streams
that have not yet been handed to the handshake, so a broken or hostile relay
cannot make the process open sockets without bound.

**At rest.** Device secrets are encrypted with Electron `safeStorage` in
packaged builds and written 0600 through a temp-file rename. Packaged builds
refuse to persist secrets without OS-backed encryption and say so in Settings
rather than silently losing pairings. Development builds store them
unencrypted (the stock Electron signature can't match the keychain ACL), same
tradeoff the account token already makes.

**What a controller can do.** Read the host's project/thread list, read a
thread's transcript, start a turn, and stop a turn. There is no filesystem,
shell, or settings access over the wire. Turns are executed by the *host's own
renderer* through the same code path as a local user action
(`remote:commandRequest` → renderer → `remote:commandResult`, mirroring the
orchestration subagent bridge). Main dispatches only after that renderer has
explicitly installed its listener; startup and reload clear readiness. The
host's UI and store therefore stay authoritative and every remote action shows
up locally.

## Implementation notes

| Piece | Location |
|---|---|
| Wire protocol (handshake, framing, pairing codes) | `src/main/remote-crypto.js` |
| Transports (TCP + relay WebSockets) | `src/main/remote-transport.js` |
| Engine (server, relay listener, pairing, sessions, persistence) | `src/main/remote-control.js` |
| IPC handlers (`remote:*`), event tap, account hook | `src/main.js` |
| Renderer API | `src/preload.js`, types in `src/types.d.ts` |
| Settings tab | `src/app/RemoteControlSettings.tsx` |
| Machine picker (above the prompt box) | `src/app/MachinePicker.tsx` |
| Threads on another machine (send, stop, mirror, listing) | `src/App.tsx` (`startRemoteTurn`), `src/app/useRemoteThreadSync.ts`, `src/app/remoteThreads.ts`, `syncRemoteMachineThreads` in `src/store.ts` |
| Branch of a thread on another machine | `src/app/RemoteBranchPill.tsx` |
| Host-side command execution | `src/App.tsx` (`remoteCommandHandlerRef`) |
| Settings persistence | `remoteControlSettings` in `src/store.ts` |
| Pairings on disk | `<userData>/orion-remote-control.json` |

Controllers follow live runs through pushed events: the host forwards agent
turn events (`addAgentEventListener` in `src/main/events.js`) and debounced
workspace-change notices, which the remote view uses to refresh — it never
mirrors host state locally, so the two can't diverge.

## Tests

```sh
npm run test:remote-crypto    # handshake, encryption, replay/tamper rejection
npm run test:remote-control   # two real processes over TCP: pairing, sessions,
                              # revocation races, code-burning, flood resistance
npm run test:remote-relay     # two real processes over a local fake relay:
                              # direct mode makes zero relay calls, pairing and
                              # runTurn by machine ID, relay sees ciphertext
                              # only, control-socket reconnect
```

None needs the app running or a network backend — the relay test brings up its
own dependency-free WebSocket relay (`scripts/fake-relay-server.mjs`) that
implements the `/v1/host`, `/v1/connect` and `/v1/stream` contract.

## Transport notes

The relay transport uses the **global `WebSocket`** shipped with Electron's
Node runtime (Node 24 under Electron 42) rather than the `ws` package, which
is not a dependency of this app. Only client sockets are ever needed here —
the desktop never accepts a WebSocket — so the built-in covers the whole
surface, and a security-sensitive path gains no new dependency. The fake relay
in the tests needs a WebSocket *server*, which the global does not provide, so
it carries a small RFC 6455 implementation of its own.
