package io.github.umeranjum17.byokit.reach

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.net.Inet4Address
import java.net.NetworkInterface

class ReachModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ByokitReach")

    AsyncFunction("addresses") {
      NetworkInterface.getNetworkInterfaces()?.toList().orEmpty()
        .filter { it.isUp && !it.isLoopback }
        .flatMap { iface ->
          iface.interfaceAddresses.filter { it.address is Inet4Address }.map { address ->
            mapOf("address" to address.address.hostAddress, "prefixLength" to address.networkPrefixLength.toInt(), "interface" to iface.name)
          }
        }
    }

    AsyncFunction("phoneNetwork") {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
      val capabilities = manager.activeNetwork?.let { manager.getNetworkCapabilities(it) }
      mapOf(
        "onWifi" to (capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true),
        "cellular" to (capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) == true),
        "vpnActive" to if (capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true) "yes" else "no"
      )
    }
  }
}
