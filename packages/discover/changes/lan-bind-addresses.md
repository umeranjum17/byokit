- FIX: `reach()` no longer asks for a wildcard bind on the LAN and overlay routes: the wildcard bind exposed the
  pairing server on every interface of this computer, including the ones the phone was never offered. `bind` is now
  a list of the classified addresses, one listener each, and every dial URL names an address in that list. Direct
  Tailscale still binds the selected tailnet IP and Serve still binds loopback. The `Reach.bind` type changes from
  `string` to `string[]`: read the list and bind each address.
