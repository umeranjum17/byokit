#!/bin/sh
# Run the built portable entry over scripted protocol replies in a standalone Hermes JS runtime (not hermesc).
# Build first. Callers serialize this runner with their normal build/resource lock.
set -eu
hermes=$(realpath "${1:?absolute path to the Hermes JS runtime}")
cd "$(dirname "$0")"
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cat > "$out/driver.ts" <<TS
import { portableFixture } from '$PWD/fixtures/portable.ts';
portableFixture().then(result => {
  if (result.hello.protocol !== 1 || result.platforms !== 1 || result.invalid !== 'invalid' ||
      result.checked?.voice.length !== 1 || result.checked.added[0] !== '42' || result.checked.dropped[0] !== '41' ||
      result.posts[0] !== '1/1 Hello there.' || result.verbs.join(',') !== 'hello,voice.parse,voice.guide,platforms,brief,check,split') {
    print('FAIL: unexpected portable result');
    return;
  }
  print('PORTABLE_RESULT ' + JSON.stringify(result));
}, error => print('FAIL: ' + String(error)));
TS
node ../../../node_modules/esbuild/bin/esbuild "$out/driver.ts" --bundle --platform=browser --conditions=react-native --target=es2019 --format=iife --outfile="$out/bundle.js" --log-level=error
# Hermes 0.13 accepts ES5; React Native normally performs this lowering in its bundler.
node -e "const ts=require('typescript'),fs=require('fs');fs.writeFileSync(process.argv[2],ts.transpileModule(fs.readFileSync(process.argv[1],'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES5,downlevelIteration:true,allowJs:true}}).outputText)" "$out/bundle.js" "$out/es5.js"
"$hermes" -O -w "$out/es5.js" > "$out/result"
cat "$out/result"
# A syntax failure, rejected promise or absent execution must not be called a pass.
rg -q '^PORTABLE_RESULT ' "$out/result"
! rg -q '^FAIL:' "$out/result"
