- `sealNotice`/`openNotice` (and the portable `./device` re-export) now delegate to `@byokit/seal`'s generic
  `sealNotice`/`openNotice` instead of sealing and opening the box here: the device seed becomes the box secret
  through `boxKeyPairFromSeed`, and the opened value is still shape-checked as a `BlockedAgent`. The wire format is
  unchanged, so a notice sealed by an earlier kit still opens, and `seal.openNotice` opens a herdr notice. The
  hand-rolled base64url helpers stay only for the box-key registration text (`boxPublicKeyB64`, link.ts's
  `decodeB64Url`), because seal exports no base64url.
