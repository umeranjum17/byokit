#!/bin/sh
# Runs bench/streams.ts in Hermes: `sh bench/hermes.sh path/to/hermes` (the CLI from github.com/facebook/hermes
# releases). Bundles the React Native graph with esbuild lowered to ES2015 for Hermes (TypeScript 7 removed the
# transpileModule/ES5 surface, and esbuild does not lower to ES5), and adds the two globals
# a bare Hermes lacks and an app polyfills (crypto.getRandomValues, TextDecoder).
set -eu
hermes=$(realpath "${1:?path to the hermes CLI}")
cd "$(dirname "$0")"
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cat > "$out/globals.js" <<'JS'
if (typeof globalThis.self === 'undefined') globalThis.self = globalThis;
if (typeof globalThis.crypto === 'undefined') globalThis.crypto = { getRandomValues(a) { for (let i = 0; i < a.length; i++) a[i] = (Math.random() * 256) | 0; return a; } };
if (typeof globalThis.TextDecoder === 'undefined') globalThis.TextDecoder = class { decode(u) { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return decodeURIComponent(escape(s)); } };
JS
node ../../../node_modules/esbuild/bin/esbuild "$PWD/streams.ts" --bundle --platform=browser --conditions=react-native --target=es2015 --format=iife --inject:"$out/globals.js" --outfile="$out/hermes.js" --log-level=error
"$hermes" -O -w "$out/hermes.js"
