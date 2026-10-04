package io.github.umeranjum17.byokit.example.a11y

import android.app.Activity
import android.os.Bundle
import android.widget.TextView

/** Account-free debug activity in the example app's package, with no editor or network. */
class ForegroundFixtureActivity : Activity() {
  override fun onCreate(state: Bundle?) {
    super.onCreate(state)
    setContentView(TextView(this).apply { text = "Foreground package fixture" })
  }
}
