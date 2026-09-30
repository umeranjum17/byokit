package io.github.umeranjum17.byokit.dictationproof;

import android.app.Activity;
import android.content.ComponentName;
import android.content.Intent;
import android.os.Bundle;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.util.Log;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;

/** Consumer-owned bridge: only bundled assets are loaded and no network permission is present. */
public final class DictationActivity extends Activity {
    public static final AtomicReference<String> result = new AtomicReference<>();
    private WebView web;
    private final Map<String, SpeechRecognizer> recognizers = new HashMap<>();
    @Override public void onCreate(Bundle state) {
        super.onCreate(state); result.set(null);
        web = new WebView(this); web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setAllowFileAccess(false);
        web.addJavascriptInterface(new Port(), "Android");
        setContentView(web); web.loadUrl("file:///android_asset/index.html");
    }
    private void event(String id, JSONObject payload) {
        web.evaluateJavascript("window.dictationNativeEvent(" + JSONObject.quote(id) + "," + payload + ")", null);
    }
    private JSONObject object(String... pairs) {
        JSONObject o = new JSONObject();
        try { for (int i = 0; i < pairs.length; i += 2) o.put(pairs[i], pairs[i + 1]); }
        catch (Exception e) { throw new IllegalStateException(e); }
        return o;
    }
    private void dispose(String id) {
        SpeechRecognizer recognizer = recognizers.remove(id);
        if (recognizer != null) recognizer.destroy();
    }
    public final class Port {
        @JavascriptInterface public String available(String locale) { return locale.equals("en-US") ? "ready" : "needs-download"; }
        @JavascriptInterface public void start(String id, String options) {
            runOnUiThread(() -> {
                try {
                    JSONObject o = new JSONObject(options);
                    if (!o.getBoolean("onDevice")) throw new IllegalArgumentException("local required");
                    // The component is explicitly this app's offline fixture, never a discovered cloud service.
                    SpeechRecognizer recognizer = SpeechRecognizer.createSpeechRecognizer(DictationActivity.this,
                        new ComponentName(DictationActivity.this, FixtureRecognizer.class));
                    recognizers.put(id, recognizer);
                    recognizer.setRecognitionListener(new RecognitionListener() {
                        private void words(Bundle bundle, boolean last) {
                            try {
                                ArrayList<String> words = bundle.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                                JSONObject segment = object("id", "0", "text", words.get(0), "language", o.getString("locale"));
                                segment.put("final", last); segment.put("startMs", 0); segment.put("endMs", 1000);
                                JSONObject message = object("type", "segment"); message.put("segment", segment); event(id, message);
                                if (last) { event(id, object("type", "stopped")); dispose(id); }
                            } catch (Exception e) { onError(SpeechRecognizer.ERROR_CLIENT); }
                        }
                        public void onReadyForSpeech(Bundle b) {}
                        public void onBeginningOfSpeech() {}
                        public void onRmsChanged(float rms) {}
                        public void onBufferReceived(byte[] b) {}
                        public void onEndOfSpeech() {}
                        public void onError(int code) { event(id, object("type", "error", "code", String.valueOf(code))); dispose(id); }
                        public void onResults(Bundle b) { words(b, true); }
                        public void onPartialResults(Bundle b) { words(b, false); }
                        public void onEvent(int type, Bundle b) {}
                    });
                    Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                        .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                        .putExtra(RecognizerIntent.EXTRA_LANGUAGE, o.getString("locale"))
                        .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, o.getBoolean("partial"))
                        .putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
                        .putExtra("byokit.fixture.punctuation", o.getBoolean("punctuation"));
                    recognizer.startListening(intent);
                } catch (Exception e) { event(id, object("type", "error", "code", e.toString())); dispose(id); }
            });
        }
        @JavascriptInterface public void stop(String id) { runOnUiThread(() -> { SpeechRecognizer r = recognizers.get(id); if (r != null) r.stopListening(); }); }
        @JavascriptInterface public void cancel(String id) {
            runOnUiThread(() -> { SpeechRecognizer r = recognizers.get(id); if (r != null) r.cancel(); });
        }
        @JavascriptInterface public void report(String text) { result.set(text); Log.i("DictationProof", text); }
    }
    @Override public void onDestroy() {
        for (SpeechRecognizer r : recognizers.values()) r.destroy(); recognizers.clear();
        web.destroy(); super.onDestroy();
    }
}
