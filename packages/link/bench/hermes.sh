#!/bin/sh
# Runs bench/streams.ts in Hermes: `sh bench/hermes.sh path/to/hermes` (the CLI from github.com/facebook/hermes
# releases). Bundles the React Native graph with esbuild, lowers it to ES5 for Hermes with tsc, and adds the two globals
# a bare Hermes lacks and an app polyfills (crypto.getRandomValues, TextDecoder).
set -eu
hermes=$(realpath "${1:?path to the hermes CLI}")
cd "$(dirname "$0")"
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
cat > "$out/globals.js" <<'JS'
if (typeof globalThis.self === 'undefined') globalThis.self = globalThis;
if (typeof globalThis.crypto === 'undefined') globalThis.crypto = { getRandomValues(a) { for (let i = 0; i < a.length; i++) a[i] = (Math.random() * 256) | 0; return a; } };
if (typeof globalThis.TextDecoder === 'undefined') globalThis.TextDecoder = class { decode(u) { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return decodeURIComponent(escape(s)); } };
JS
node ../../../node_modules/esbuild/bin/esbuild "$PWD/streams.ts" --bundle --platform=browser --conditions=react-native --target=es2019 --format=iife --inject:"$out/globals.js" --outfile="$out/bundle.js" --log-level=error
node -e "const ts=require('typescript'),fs=require('fs');fs.writeFileSync(process.argv[2],ts.transpileModule(fs.readFileSync(process.argv[1],'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES5,downlevelIteration:true,allowJs:true}}).outputText)" "$out/bundle.js" "$out/es5.js"
"$hermes" -O -w "$out/es5.js"
