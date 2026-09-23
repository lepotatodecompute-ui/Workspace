# Ethernet relay for BrowserVM

`device.js` now forwards the guest's outbound Ethernet frames to a WebSocket
relay and injects inbound frames back into the guest, instead of dropping
them. One binary WebSocket message = one raw Ethernet frame, each direction,
no extra framing — the same convention other browser-VM projects (e.g. v86)
use for their relays.

## What you need to actually get network access

A browser tab can't send raw Ethernet frames to the internet by itself. You
need a relay **server** on the other end that:
1. Accepts a WebSocket connection and speaks the raw-frame protocol above.
2. Runs a user-mode NAT/SLIRP stack that turns those frames into real
   outbound TCP/UDP.

This patch only adds the **client** side. Two ways to get a server:

- **Point at an existing v86-compatible relay**, if you have one you trust —
  set `window.BROWSERVM_RELAY_URL` before `device.js` loads, e.g.
  `<script>window.BROWSERVM_RELAY_URL = "wss://your-relay-host/";</script>`.
- **Self-host one.** v86's project ships a small Docker-based relay
  (`websockproxy` + `slirp`) you can run yourself — search "v86 network proxy
  docker" for the current instructions, since I can't vouch for a specific
  public relay's trustworthiness or availability.

Default if you set nothing: `ws://localhost:8080/` — i.e. it expects a relay
running on your own machine.

## Applying this

Either copy `device.js` over the one in the repo, or apply
`ethernet-relay.patch` with `git apply ethernet-relay.patch` from the repo
root.

## Next up: 9P

The virtio-9p device (host filesystem sharing, as opposed to the flat
block-device disk that's already there) is a separate, larger piece —
happy to start on it next.
