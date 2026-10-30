import ExpoModulesCore
import UIKit
import UserNotifications

/// Sends an Answer typed (or a choice button pressed) on a relay notification without opening the app or waiting for JavaScript. It sits in front
/// of the app's notification delegate (expo-notifications' or the app's own) and forwards everything it does not own.
public class NoticeAnswerSubscriber: ExpoAppDelegateSubscriber {
  public func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
    let center = UNUserNotificationCenter.current()
    if !(center.delegate is NoticeAnswerCenter) {
      NoticeAnswerCenter.shared.next = center.delegate
      center.delegate = NoticeAnswerCenter.shared
    }
    return true
  }
}

final class NoticeAnswerCenter: NSObject, UNUserNotificationCenterDelegate {
  static let shared = NoticeAnswerCenter() // the center holds its delegate weakly
  weak var next: UNUserNotificationCenterDelegate?

  static func targets() -> [AnswerTarget] {
    UserDefaults.standard.data(forKey: "byokit.notices.answer-targets")
      .flatMap { try? JSONDecoder().decode([AnswerTarget].self, from: $0) } ?? []
  }
  static func setTargets(_ targets: [AnswerTarget]) throws {
    UserDefaults.standard.set(try JSONEncoder().encode(targets), forKey: "byokit.notices.answer-targets")
  }

  func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                              withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
    guard let next, next.responds(to: #selector(UNUserNotificationCenterDelegate.userNotificationCenter(_:willPresent:withCompletionHandler:)))
    else { return done([]) }
    next.userNotificationCenter?(center, willPresent: notification, withCompletionHandler: done)
  }

  func userNotificationCenter(_ center: UNUserNotificationCenter, openSettingsFor notification: UNNotification?) {
    next?.userNotificationCenter?(center, openSettingsFor: notification)
  }

  func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                              withCompletionHandler done: @escaping () -> Void) {
    let typed = response as? UNTextInputNotificationResponse
    guard let request = AnswerRequest(userInfo: response.notification.request.content.userInfo, action: response.actionIdentifier),
          typed != nil || request.choices.contains(response.actionIdentifier) else {
      if let next, next.responds(to: #selector(UNUserNotificationCenterDelegate.userNotificationCenter(_:didReceive:withCompletionHandler:))) {
        next.userNotificationCenter?(center, didReceive: response, withCompletionHandler: done)
      } else { done() }
      return
    }
    // The kit owns this press: JavaScript never sees it, so the app cannot send it twice.
    let notification = response.notification.request
    var task = UIBackgroundTaskIdentifier.invalid
    var settled = false
    let settle = { (failure: String?) in
      let finish = {
        guard !settled else { return }
        settled = true
        if let failure {
          let content = (notification.content.mutableCopy() as? UNMutableNotificationContent) ?? UNMutableNotificationContent()
          content.body = "\(failure). Open the app to answer."
          content.sound = nil
          center.add(UNNotificationRequest(identifier: notification.identifier, content: content, trigger: nil))
        } else {
          center.removeDeliveredNotifications(withIdentifiers: [notification.identifier])
        }
        done()
        UIApplication.shared.endBackgroundTask(task)
      }
      // The expiry handler runs on the main thread and must end the task before it returns.
      if Thread.isMainThread { finish() } else { DispatchQueue.main.async(execute: finish) }
    }
    task = UIApplication.shared.beginBackgroundTask(withName: "byokit.notices.answer") { settle("Not sent in time") }
    let given = typed.map { AnswerReply.text($0.userText.trimmingCharacters(in: .whitespacesAndNewlines)) } ?? .choice(request.action)
    if given == .text("") { return settle("Nothing was sent") }
    guard let group = Bundle.main.object(forInfoDictionaryKey: "ByokitNoticeAppGroup") as? String else { return settle("The device key is locked or missing") }
    let session = NoticeSession(group: group)
    do { try session.requireSignedIn() } catch { return settle(error.localizedDescription) }
    guard let target = Self.targets().first(where: { $0.host == request.host }) else { return settle("This device has no answer route") }
    guard var secret = NoticeKeyStore(group: group).get() else { return settle("The device key is locked or missing") }
    defer { secret.resetBytes(in: 0..<secret.count) }
    let press: URLRequest
    do {
      guard let sealed = try NoticeAnswer.press(request, reply: given, deviceSecret: secret, target: target, session: session) else { return settle("The answer could not be sealed") }
      press = sealed
    } catch { return settle(error.localizedDescription) }
    URLSession.shared.dataTask(with: press) { body, reply, error in
      settle(error.map { $0.localizedDescription.trimmingCharacters(in: CharacterSet(charactersIn: ".")) }
        ?? NoticeAnswer.failure(status: (reply as? HTTPURLResponse)?.statusCode, body: body))
    }.resume()
  }
}
