// The stub engine as a bin with the engine bin's I/O: `hello` as an argument, else one JSON request on stdin and one
// JSON answer on stdout, exit 1 on an error answer.
import { engineStub } from './engine-stub.ts';

const stub = engineStub();
const out = (value: unknown): void => {
  const bad = typeof value === 'object' && value !== null && 'error' in value;
  process.stdout.write(JSON.stringify(value) + '\n');
  process.exitCode = bad ? 1 : 0;
};
if (process.argv[2] === 'hello') {
  out(await stub.Protocol.hello());
} else {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  out(await stub.Protocol.handle(JSON.parse(input)));
}
