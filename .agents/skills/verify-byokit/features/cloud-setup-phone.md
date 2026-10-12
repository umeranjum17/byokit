# Phone cloud-key setup

The native example's Cloud computer card pastes the Boat provider key into the phone's own SecureStore-backed account storage after one identity check (no machine, no spend). Every failure ends in plain words with nothing saved: an unknown key, an interrupted connection, a cancelled check, and a missing key. A replaced key from another account drops the stored machine ref. The key travels only in the Authorization header and the input clears on submit, so no screenshot, recording or log ever shows it.

## Sub-features

- `cloud-setup-missing`: an empty paste checks nothing and spends nothing; the card repeats where to make the key.
- `cloud-setup-unknown`: a rejected key says the provider did not accept it and stores nothing.
- `cloud-setup-unreachable`: a dead connection says the provider cannot be reached and stores nothing.
- `cloud-setup-cancelled`: cancelling mid-check saves nothing.
- Not built: the claim flow (refused/expired steps). `claim()` is still M8's stub, so no claim path is proven here.
- No live credential ever enters this journey: the pasted value is a fixture key the fake provider rejects, and a connected state is proved by the loopback journey test, never by a real key on a device.

## How to get to it (user POV)

Open the default Expo example, scroll to Cloud computer, paste the Boat key and tap Connect. A saved key shows the saved note with Replace and Remove; Remove deletes it and says so.

## Driving it with the maintained capture

Build and doctor the workspace per the parent verify skill, then run the capture with a private emulator serial and an absolute private evidence dir (the caller owns the emulator, the memory gate and the device/heavy locks):

```sh
/home/umer/firstmate/config/fm-mem-gate.sh \
  sh .agents/skills/verify-byokit/capture/expo-cloud-setup.sh <private-emulator-serial> <absolute-private-evidence-dir>
```

The capture builds the actual release app with `EXPO_PUBLIC_BOAT_BASE=http://10.0.2.2:21456`, serves one host fixture on that port in three modes (fast 401, 5 s delayed 401, stopped), and screenshots the missing, unknown-key, cancelled and unreachable states through the same uiautomator path as `e2e-android.sh`. It then runs the credential leak check with the fixture key as the canary. Check every PNG visually; keep the command log and failures. A connected phone state is covered by `examples/expo/cloud-setup.test.ts` (loopback journey, real `boat()` adapter), not by this capture: state that split in the report.

## Gotchas

- Only the caller's private emulator is authorized; every adb command includes its serial. Proof lives outside the repository.
- The fixture key is rejected by design; a 200 from the fixture would prove nothing about the real provider and must fail the run.
- The input clears on submit before any screenshot; a screenshot showing key text fails the run even when the words are right.
- Bundles are not device proof. Other device routes, live vendor flows and native iOS execution are not qualified here.
