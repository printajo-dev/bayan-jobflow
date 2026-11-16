# ADR 0005 — HTTPS on the LAN with Caddy's internal CA
Status: accepted

Browsers expose `getUserMedia` (microphone) only in secure contexts, so voice
notes require HTTPS even on the LAN. Users reach the server by its LAN IP
(no DNS). Caddy runs `tls internal` for that IP address (certificate with an IP
SAN); the server must have a static IP or DHCP reservation, because a changed IP
invalidates bookmarks and the certificate. A DNS name can be added to the same
site later. Its root certificate is exported once and installed on each office
PC. No public certificate, no port forwarding, no internet dependency.
