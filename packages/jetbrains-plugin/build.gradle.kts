plugins {
    id("org.jetbrains.intellij") version "1.17.0"
    kotlin("jvm") version "1.9.21"
}

group = "com.autodocmcp"
version = "0.1.0"

repositories {
    mavenCentral()
}

intellij {
    version.set("2023.3")
    type.set("IC")
    plugins.set(listOf("Git4Idea"))
}

tasks {
    patchPluginXml {
        sinceBuild.set("233")
        untilBuild.set("243.*")
    }

    publishPlugin {
        token.set(System.getenv("JETBRAINS_PUBLISH_TOKEN"))
    }
}
