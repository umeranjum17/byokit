plugins { id("com.android.application") version "8.12.0" }

val kitRoot = rootDir.resolve("../..").canonicalFile
val consumerAssets = layout.buildDirectory.dir("generated/consumer-assets")
val bundleConsumer by tasks.registering(Exec::class) {
    inputs.file(rootDir.resolve("consumer.ts"))
    inputs.dir(kitRoot.resolve("packages/dictation/dist"))
    outputs.dir(consumerAssets)
    doFirst { consumerAssets.get().asFile.mkdirs() }
    commandLine("node", kitRoot.resolve("node_modules/esbuild/bin/esbuild"), rootDir.resolve("consumer.ts"),
        "--bundle", "--platform=browser", "--format=iife", "--outfile=${consumerAssets.get().asFile}/consumer.js")
}
android {
    namespace = "io.github.umeranjum17.byokit.dictationproof"
    compileSdk = 36
    defaultConfig {
        applicationId = "io.github.umeranjum17.byokit.dictationproof"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    sourceSets["main"].assets.srcDir(consumerAssets)
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
tasks.named("preBuild") { dependsOn(bundleConsumer) }
dependencies {
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test:rules:1.6.1")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
}
