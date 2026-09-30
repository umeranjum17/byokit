package io.github.umeranjum17.byokit.dictationproof;

import android.content.Intent;
import android.os.Bundle;
import android.os.RemoteException;
import android.speech.RecognitionService;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

/** Deterministic local recognizer, bound through Android's real SpeechRecognizer/Binder path. */
public final class FixtureRecognizer extends RecognitionService {
    public static volatile Intent request;
    public static volatile Intent firstRequest;
    public static final AtomicInteger starts = new AtomicInteger();
    public static final AtomicInteger stops = new AtomicInteger();
    public static final AtomicInteger cancels = new AtomicInteger();
    private Bundle words(String text) {
        Bundle b = new Bundle();
        b.putStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION, new ArrayList<>(List.of(text)));
        return b;
    }
    @Override protected void onStartListening(Intent intent, Callback callback) {
        request = new Intent(intent);
        if (starts.incrementAndGet() == 1) firstRequest = request;
        try {
            callback.readyForSpeech(new Bundle());
            callback.partialResults(words("hello kit"));
            callback.partialResults(words("hello kit again"));
        } catch (RemoteException e) { throw new IllegalStateException(e); }
    }
    @Override protected void onStopListening(Callback callback) {
        stops.incrementAndGet();
        try { callback.results(words("hello kit")); }
        catch (RemoteException e) { throw new IllegalStateException(e); }
    }
    @Override protected void onCancel(Callback callback) { cancels.incrementAndGet(); }
}
