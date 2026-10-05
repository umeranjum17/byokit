// The Expo prebuild template caps the Gradle daemon at -Xmx2g. Packaging the debug APK runs inside
// that single-use daemon (zipflinger reads whole native-library entries into its heap) and peaks at
// ~2.0 GB there — CI dies at :app:packageDebug with OutOfMemoryError: Java heap space. 4g is twice
// the measured peak and well inside a 16 GB CI runner.
const { withGradleProperties } = require('expo/config-plugins');

module.exports = function gradleDaemonHeap(config) {
  return withGradleProperties(config, (c) => {
    const jvmargs = c.modResults.find((item) => item.key === 'org.gradle.jvmargs');
    if (jvmargs) jvmargs.value = '-Xmx4g';
    return c;
  });
};
