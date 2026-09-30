package io.github.umeranjum17.byokit.dictationproof;

import android.Manifest;
import android.os.SystemClock;
import android.speech.RecognizerIntent;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.rule.GrantPermissionRule;
import org.json.JSONObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public final class DictationFlowTest {
    @Rule public GrantPermissionRule microphone = GrantPermissionRule.grant(Manifest.permission.RECORD_AUDIO);
    @Test public void systemRecognizerSettlesAndCancelsThroughThePublishedKit() throws Exception {
        FixtureRecognizer.starts.set(0); FixtureRecognizer.stops.set(0); FixtureRecognizer.cancels.set(0);
        try (ActivityScenario<DictationActivity> app = ActivityScenario.launch(DictationActivity.class)) {
            long deadline = SystemClock.elapsedRealtime() + 20000;
            while ((DictationActivity.result.get() == null || FixtureRecognizer.cancels.get() == 0) && SystemClock.elapsedRealtime() < deadline) SystemClock.sleep(50);
            assertNotNull("JavaScript consumer did not complete", DictationActivity.result.get());
            JSONObject result = new JSONObject(DictationActivity.result.get());
            assertFalse(result.toString(), result.has("error"));
            assertEquals("hello app", result.getString("text"));
            assertEquals("hello kit", result.getJSONArray("partials").getString(1));
            assertTrue(result.getBoolean("final")); assertTrue(result.getBoolean("idle"));
            assertEquals("en-US", result.getString("language"));
            assertEquals("system", result.getJSONObject("engine").getString("id"));
            assertTrue(result.getJSONObject("engine").getBoolean("onDevice"));
            assertEquals("free", result.getJSONObject("usage").getString("basis"));
            assertEquals(1000, result.getJSONObject("usage").getInt("audioMs"));
            assertEquals("needs-download", result.getString("missing"));
            assertEquals("cancelled", result.getString("cancelCode"));
            assertEquals(2, FixtureRecognizer.starts.get()); assertEquals(1, FixtureRecognizer.stops.get());
            assertEquals(1, FixtureRecognizer.cancels.get());
            assertFalse(FixtureRecognizer.firstRequest.getBooleanExtra("byokit.fixture.punctuation", true));
            assertEquals("en-US", FixtureRecognizer.request.getStringExtra(RecognizerIntent.EXTRA_LANGUAGE));
            assertTrue(FixtureRecognizer.request.getBooleanExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false));
            assertTrue(FixtureRecognizer.request.getBooleanExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, false));
        }
    }
}
