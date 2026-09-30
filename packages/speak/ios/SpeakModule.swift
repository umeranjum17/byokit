import AVFoundation
import ExpoModulesCore

// Expo module 'ByokitSpeak': the NativeSpeak seam over iOS's own AVSpeechSynthesizer. No network, no keys.
// Each speak carries a numeric id; progress for that id goes out as a 'speak' event.
public class SpeakModule: Module {
  private let synth = AVSpeechSynthesizer()
  private var voices: [Int: AVSpeechUtterance] = [:]
  private let delegate = SpeakDelegate()

  public func definition() -> ModuleDefinition {
    Name("ByokitSpeak")
    Events("speak")

    OnCreate {
      self.delegate.onEvent = { [weak self] id, type in
        self?.sendEvent("speak", ["id": id, "type": type])
        if (type == "end" || type == "error") { self?.voices.removeValue(forKey: id) }
      }
      self.synth.delegate = self.delegate
    }

    Function("speak") { (id: Int, text: String, voice: String?, rate: Float, pitch: Float) in
      let utterance = AVSpeechUtterance(string: text)
      if let voice = voice {
        utterance.voice = AVSpeechSynthesisVoice.speechVoices().first(where: { $0.identifier == voice || $0.name == voice })
      }
      utterance.rate = min(max(rate, 0.25), 4) * AVSpeechUtteranceDefaultSpeechRate
      utterance.pitchMultiplier = min(max(pitch, 0), 2)
      self.delegate.ids[utterance] = id
      self.voices[id] = utterance
      self.synth.speak(utterance)
    }

    Function("cancel") { (id: Int) in
      // iOS stops everything; the JS side settles only the cancelled handle.
      if self.voices.removeValue(forKey: id) != nil { self.synth.stopSpeaking(at: .immediate) }
    }

    Function("stopAll") {
      self.voices.removeAll()
      self.synth.stopSpeaking(at: .immediate)
    }

    AsyncFunction("voices") {
      AVSpeechSynthesisVoice.speechVoices().map { ["id": $0.identifier, "name": $0.name, "lang": $0.language] }
    }
  }
}

private class SpeakDelegate: NSObject, AVSpeechSynthesizerDelegate {
  var ids: [AVSpeechUtterance: Int] = [:]
  var onEvent: ((Int, String) -> Void)?
  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
    if let id = ids[utterance] { onEvent?(id, "start") }
  }
  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
    if let id = ids.removeValue(forKey: utterance) { onEvent?(id, "end") }
  }
  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
    if let id = ids.removeValue(forKey: utterance) { onEvent?(id, "error") }
  }
}
