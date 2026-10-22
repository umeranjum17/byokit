- FIX: `serve()` starts one listener per address `reach` names, plus loopback, instead of one listener on
  whatever `reach` returned: a LAN route's wildcard bind opened the pairing server on every interface of this
  computer, and the kit now listens only where the phone was pointed, with loopback kept for a client on this
  machine.
