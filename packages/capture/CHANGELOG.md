# Changelog

## Unreleased

- Scaffold (docs/capability-kits.md BK-0): frozen public types, the `Capture` client, supervision and protocol
  seams, `./testing` and words. Bodies throw `not built` until BK-C1 (recorder protocol v1 schema, parsers, fake
  recorder, contract) and BK-C2 (the client and supervision) land.
- BK-C1: recorder protocol v1 schema, wire parsers with the 6.7 error mapping, the scripted fake recorder and the
  contract suite. The contract runs against the fake recorder in BK-C2.
