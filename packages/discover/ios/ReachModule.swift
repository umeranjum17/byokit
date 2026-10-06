import Darwin
import ExpoModulesCore
import Network

public class ReachModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ByokitReach")

    AsyncFunction("addresses") { () -> [[String: Any]] in
      var head: UnsafeMutablePointer<ifaddrs>?
      guard getifaddrs(&head) == 0, let first = head else { return [] }
      defer { freeifaddrs(head) }
      var out: [[String: Any]] = []
      var cursor: UnsafeMutablePointer<ifaddrs>? = first
      while let current = cursor {
        defer { cursor = current.pointee.ifa_next }
        let entry = current.pointee
        guard entry.ifa_flags & UInt32(IFF_UP) != 0,
              entry.ifa_flags & UInt32(IFF_LOOPBACK) == 0,
              let address = entry.ifa_addr, address.pointee.sa_family == UInt8(AF_INET),
              let netmask = entry.ifa_netmask, netmask.pointee.sa_family == UInt8(AF_INET) else { continue }
        var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
        let hostSize = socklen_t(host.count)
        guard getnameinfo(address, socklen_t(address.pointee.sa_len), &host, hostSize, nil, 0, NI_NUMERICHOST) == 0 else { continue }
        let mask = netmask.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { UInt32(bigEndian: $0.pointee.sin_addr.s_addr) }
        // Prefix masks must be contiguous. If the platform gives another shape, omit the prefix.
        let prefix = mask.nonzeroBitCount
        let expected: UInt32 = prefix == 0 ? 0 : UInt32.max << (32 - prefix)
        var value: [String: Any] = ["address": String(cString: host), "interface": String(cString: entry.ifa_name)]
        if mask == expected { value["prefixLength"] = prefix }
        out.append(value)
      }
      return out
    }

    AsyncFunction("phoneNetwork") { (promise: Promise) in
      // NWPath exposes the active Wi-Fi/cellular transports, but cannot prove a VPN is on or off.
      let monitor = NWPathMonitor()
      let queue = DispatchQueue(label: "byokit.reach.network")
      var completed = false
      let finish: ([String: Any]) -> Void = { value in
        guard !completed else { return }
        completed = true
        monitor.pathUpdateHandler = nil
        monitor.cancel()
        promise.resolve(value)
      }
      monitor.pathUpdateHandler = { path in
        finish(["onWifi": path.usesInterfaceType(.wifi), "cellular": path.usesInterfaceType(.cellular), "vpnActive": "unknown"])
      }
      monitor.start(queue: queue)
      queue.asyncAfter(deadline: .now() + 2) {
        finish(["onWifi": false, "cellular": false, "vpnActive": "unknown"])
      }
    }
  }
}
