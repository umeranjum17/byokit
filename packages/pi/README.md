# @byokit/pi

One Pi process per bot. This package is private and has no runtime yet: only its public types and the exact Pi pin are here.

```ts
import { PiError, type PiErrorCode } from '@byokit/pi';

const code: PiErrorCode = 'pi-missing';
console.log(new PiError(code, 'Pi is not installed.').code);
```
