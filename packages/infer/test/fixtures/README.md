# Infer native receipts

`final-explicit-result.json` is the byte-exact owned synthetic native receipt (SHA256 `4dfe4aa040cfde7dfb7c0ffba25518e316e88eb2a52ea43b198587049b6bc040`), never accepted/coerced.

`summary-grammar-b10256.json` records real released b10256 formatter + GBNF recognizer results, compiled against unmodified published llama.rn 0.12.9 headers. Old grammar accepts that contradiction; corrected grammar rejects it, accepts true3/4 and false[], enforces 1–100 plain characters, and rejects newline/quote/backslash escapes. It is not phone sampling or model-faithfulness proof.

Reproduce with task-private verified CPU b10256 libraries and `grammar-probe.cpp` (no model load/generation):

```
c++ -std=c++17 -I "$SDK/cpp" -I "$SDK/cpp/common" ../grammar-probe.cpp -L "$LIB" -lllama-common -lllama -o "$TMP/grammar-probe"
LD_LIBRARY_PATH="$LIB" "$TMP/grammar-probe" request.json embedded-template.txt native-result.json
```

Arguments are retained synthetic options, the pinned GGUF's embedded template, and the exact result receipt. The probe uses the actual stock converter/grammar parser; no generic schema validator substitutes for it. The Expo binding test executes real SDK formatting/completion methods, stubbing only the device transport, and checks the final dispatched grammar. CI runs it after installing the pinned Expo SDK.
