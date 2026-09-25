plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
    `maven-publish`
}

// The catalogue and words ship inside the library, from the one copy @byokit/accounts uses.
val shared = layout.buildDirectory.dir("generated/byokit-shared")
val copyShared by tasks.registering(Copy::class) {
    from(rootDir.resolve("../packages/accounts/src")) { include("catalogue.json", "words.json") }
    into(shared.map { it.dir("byokit") })
}

android {
    namespace = "io.github.umeranjum17.byokit"
    compileSdk = 36
    defaultConfig {
        minSdk = 26
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        consumerProguardFiles("consumer-rules.pro")
    }
    sourceSets["main"].resources.srcDir(shared)
    // The sign-in state machine tests run on the JVM and again on a device.
    sourceSets["test"].kotlin.srcDir("src/sharedTest/kotlin")
    sourceSets["androidTest"].kotlin.srcDir("src/sharedTest/kotlin")
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    testOptions.unitTests.all { it.systemProperty("byokit.fixtures", rootDir.resolve("../fixtures").absolutePath) }
    publishing { singleVariant("release") { withSourcesJar() } }
}
tasks.named("preBuild") { dependsOn(copyShared) }
tasks.matching { it.name.startsWith("process") && it.name.endsWith("JavaRes") }.configureEach { dependsOn(copyShared) }

kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }

dependencies {
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20250517") // Android's org.json is a stub on the JVM
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
}

publishing {
    publications {
        register<MavenPublication>("release") {
            // JitPack serves multi-module repos as com.github.<user>.<repo>:<module>:<tag>.
            groupId = System.getenv("GROUP")?.let { "$it.${System.getenv("ARTIFACT")}" } ?: "io.github.umeranjum17.byokit"
            artifactId = "byokit-android"
            version = System.getenv("VERSION") ?: "0.1.0"
            afterEvaluate { from(components["release"]) }
        }
    }
}
