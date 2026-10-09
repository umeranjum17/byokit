package io.github.umeranjum17.byokit.overlay

import android.content.Context
import android.content.Intent
import android.os.Bundle
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint
import com.facebook.react.defaults.DefaultReactActivityDelegate

/** A translucent activity rendering the app-registered panel component with the props it was opened with. */
class PanelActivity : ReactActivity() {
  override fun getMainComponentName(): String? = intent?.getStringExtra(EXTRA_PANEL)

  // ReactActivity builds its delegate in its constructor, before the intent exists, so the delegate reads the key and
  // props later, from onCreate.
  override fun createReactActivityDelegate(): ReactActivityDelegate =
    object : DefaultReactActivityDelegate(this, "", DefaultNewArchitectureEntryPoint.fabricEnabled) {
      override fun getMainComponentName(): String? = this@PanelActivity.mainComponentName
      override fun getLaunchOptions(): Bundle? = this@PanelActivity.intent?.getBundleExtra(EXTRA_PROPS)
    }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    current = this
    if (savedInstanceState == null) open.emit(true) // a recreation (rotation) is the same open panel
  }

  override fun onDestroy() {
    super.onDestroy()
    if (current === this) current = null
    if (!isChangingConfigurations) open.emit(false)
  }

  companion object {
    private const val EXTRA_PANEL = "byokit.panel"
    private const val EXTRA_PROPS = "byokit.props"

    /** The open panel, or null; `current?.finish()` closes it. */
    @Volatile var current: PanelActivity? = null
      private set
    /** True when a panel opens, false when it finishes. */
    val open = Listeners<Boolean>()

    /** Opens the panel registered as [panel] (an AppRegistry key) with [props] as its initial props. */
    fun launch(context: Context, panel: String, props: Map<String, String>) {
      val bundle = Bundle().apply { props.forEach { (k, v) -> putString(k, v) } }
      context.startActivity(
        Intent(context, PanelActivity::class.java)
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          .putExtra(EXTRA_PANEL, panel)
          .putExtra(EXTRA_PROPS, bundle),
      )
    }
  }
}
