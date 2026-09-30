require 'json'
package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))
Pod::Spec.new do |s|
  s.name = 'ByokitReach'
  s.version = package['version']
  s.summary = 'Native interface prefixes and phone network transports for byokit.'
  s.description = package['description']
  s.license = { :type => 'Apache-2.0', :file => '../LICENSE' }
  s.author = 'Umer Anjum'
  s.homepage = 'https://github.com/umeranjum17/byokit'
  s.platforms = { :ios => '15.1' }
  s.swift_version = '5.9'
  s.source = { :git => 'https://github.com/umeranjum17/byokit.git' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.{h,m,mm,swift}'
end
