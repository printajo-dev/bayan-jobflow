# ADR 0005 — HTTPS on the LAN with Caddy's internal CA
Status: proposed (needs Q1 answer)

Browsers expose `getUserMedia` (microphone) only in secure contexts, so voice
notes require HTTPS even on the LAN. Caddy runs `tls internal` for an internal
hostname; its root certificate is exported once and installed on each office
PC. No public certificate, no port forwarding, no internet dependency.
