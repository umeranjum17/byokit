Pod::Spec.new do |s|
  s.name = 'ByokitNotices'
  s.version = '0.1.0'
  s.summary = 'Provision the device key for sealed push notices'
  s.description = s.summary
  s.license = { :type => 'Apache-2.0', :file => '../LICENSE' }
  s.author = 'BYOKit'
  s.homepage = 'https://github.com/umeranjum17/byokit'
  s.source = { :git => 'https://github.com/umeranjum17/byokit.git' }
  s.platform = :ios, '15.1'
  s.swift_version = '5.9'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = 'NoticesModule.swift', 'NoticeKeyStore.swift'
end
